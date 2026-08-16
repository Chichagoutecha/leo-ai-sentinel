'use strict';

/**
 * LEO-AI SENTINEL v10.23.0 — Shadow Intelligence Lab
 *
 * Read-only research layer. It never places, closes, modifies or cancels orders.
 * Phase 1 deliberately uses ZERO OpenAI calls: discovery + scoring + forward
 * outcome tracking are deterministic and based on eToro market-data reads.
 *
 * Goals:
 * - expand the observable universe beyond the LIVE allowlist without expanding LIVE;
 * - resolve eToro instrument IDs safely and cache them;
 * - rank candidates using price freshness, spread and observed multi-horizon momentum;
 * - record hypothetical shadow signals and evaluate them at J+1/J+3/J+7/J+30;
 * - keep a separate persistent state so the production trading state stays untouched.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const cron = require('node-cron');

const VERSION = 'v10.23.0-shadow-intelligence-lab';
const PREFIX = '[LEO_SHADOW_LAB]';
const ENABLED = process.env.SHADOW_LAB_ENABLED !== 'false';
const SCHEDULE = String(process.env.SHADOW_LAB_SCHEDULE || '25 */4 * * *').trim();
const STARTUP_DELAY_MINUTES = clampNumber(process.env.SHADOW_LAB_STARTUP_DELAY_MINUTES, 12, 0, 180);
const MAX_RESOLUTIONS_PER_SCAN = Math.round(clampNumber(process.env.SHADOW_LAB_MAX_RESOLUTIONS_PER_SCAN, 16, 1, 60));
const MAX_UNIVERSE = Math.round(clampNumber(process.env.SHADOW_LAB_MAX_UNIVERSE, 100, 20, 250));
const TOP_CANDIDATES = Math.round(clampNumber(process.env.SHADOW_LAB_TOP_CANDIDATES, 15, 3, 50));
const SIGNAL_COUNT = Math.round(clampNumber(process.env.SHADOW_LAB_SIGNAL_COUNT, 5, 1, 20));
const MIN_SIGNAL_SCORE = clampNumber(process.env.SHADOW_LAB_MIN_SIGNAL_SCORE, 58, 0, 100);
const MAX_SPREAD_PCT = clampNumber(process.env.SHADOW_LAB_MAX_SPREAD_PCT, 2.5, 0.05, 20);
const MAX_RATE_AGE_MINUTES = clampNumber(process.env.SHADOW_LAB_MAX_RATE_AGE_MINUTES, 120, 1, 1440);
const USE_DEFAULT_WATCHLIST = process.env.SHADOW_LAB_USE_DEFAULT_WATCHLIST !== 'false';
const RESOLUTION_DELAY_MS = Math.round(clampNumber(process.env.SHADOW_LAB_RESOLUTION_DELAY_MS, 550, 250, 5000));
const MAX_HISTORY_PER_SYMBOL = Math.round(clampNumber(process.env.SHADOW_LAB_MAX_HISTORY_PER_SYMBOL, 240, 24, 1000));
const MAX_SIGNALS = Math.round(clampNumber(process.env.SHADOW_LAB_MAX_SIGNALS, 600, 50, 5000));
const MAX_SCAN_HISTORY = Math.round(clampNumber(process.env.SHADOW_LAB_MAX_SCAN_HISTORY, 180, 20, 1000));

const ETORO_BASE = 'https://public-api.etoro.com/api/v1';
const SEARCH_ENDPOINT = `${ETORO_BASE}/market-data/search`;
const RATES_ENDPOINT = `${ETORO_BASE}/market-data/instruments/rates`;
const DEFAULT_WATCHLIST_ENDPOINT = `${ETORO_BASE}/watchlists/default-watchlists/items`;

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const HAS_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const STATE_KEY = String(process.env.SHADOW_LAB_STATE_KEY || 'leo:shadow-lab:v10.23:state');
const STATE_FILE = process.env.SHADOW_LAB_STATE_FILE || path.join(
  process.env.PERSISTENT_DISK_PATH || '/tmp',
  'leo-shadow-intelligence-lab-state.json'
);

const DEFAULT_UNIVERSE_PATH = path.join(__dirname, 'shadow-universe.json');
const HORIZONS_HOURS = Object.freeze({ d1: 24, d3: 72, d7: 168, d30: 720 });

let scanInProgress = false;
let started = false;
let lastEvent = null;
let state = freshState();
let loadPromise = null;

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const n = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, n));
}

function iso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}
function hash(value) {
  return createHash('sha256').update(String(value == null ? '' : value)).digest('hex').slice(0, 20);
}

function log(event, details = {}, level = 'log') {
  const payload = { component: 'LEO_SHADOW_INTELLIGENCE_LAB', version: VERSION, event, at: iso(), ...details };
  lastEvent = payload;
  global.__LEO_SHADOW_LAB_LAST_EVENT__ = payload;
  const logger = console[level] || console.log;
  logger.call(console, `${PREFIX} ${JSON.stringify(payload)}`);
}

function freshState() {
  return {
    version: VERSION,
    createdAt: iso(),
    updatedAt: iso(),
    instrumentMap: {},
    unresolvedSymbols: {},
    priceHistory: {},
    signals: [],
    scanHistory: [],
    stats: {
      scans: 0,
      scanFailures: 0,
      resolvedSymbols: 0,
      apiReads: 0,
      apiWrites: 0,
      executionCalls: 0,
      openAiCalls: 0,
      openAiCostUsd: 0
    }
  };
}

function normalizeState(value) {
  const base = freshState();
  if (!value || typeof value !== 'object') return base;
  return {
    ...base,
    ...value,
    version: VERSION,
    instrumentMap: value.instrumentMap && typeof value.instrumentMap === 'object' ? value.instrumentMap : {},
    unresolvedSymbols: value.unresolvedSymbols && typeof value.unresolvedSymbols === 'object' ? value.unresolvedSymbols : {},
    priceHistory: value.priceHistory && typeof value.priceHistory === 'object' ? value.priceHistory : {},
    signals: Array.isArray(value.signals) ? value.signals.slice(-MAX_SIGNALS) : [],
    scanHistory: Array.isArray(value.scanHistory) ? value.scanHistory.slice(-MAX_SCAN_HISTORY) : [],
    stats: { ...base.stats, ...(value.stats || {}), apiWrites: 0, executionCalls: 0, openAiCalls: 0, openAiCostUsd: 0 }
  };
}

async function redisCommand(command) {
  if (!HAS_UPSTASH) throw new Error('UPSTASH_NOT_CONFIGURED');
  const response = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`UPSTASH_HTTP_${response.status}`);
  const json = await response.json();
  if (json && json.error) throw new Error(`UPSTASH_${json.error}`);
  return json ? json.result : null;
}

async function loadState() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      if (HAS_UPSTASH) {
        const raw = await redisCommand(['GET', STATE_KEY]);
        state = raw ? normalizeState(JSON.parse(raw)) : freshState();
        return state;
      }
      if (fs.existsSync(STATE_FILE)) {
        state = normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      }
    } catch (error) {
      log('STATE_LOAD_FALLBACK', { error: String(error.message || error).slice(0, 500) }, 'warn');
      state = normalizeState(state);
    }
    return state;
  })();
  try { return await loadPromise; } finally { loadPromise = null; }
}

async function saveState() {
  state.updatedAt = iso();
  const serialized = JSON.stringify(state);
  try {
    if (HAS_UPSTASH) {
      await redisCommand(['SET', STATE_KEY, serialized]);
      return;
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const temp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, serialized, 'utf8');
    fs.renameSync(temp, STATE_FILE);
  } catch (error) {
    log('STATE_SAVE_FAILED', { error: String(error.message || error).slice(0, 500) }, 'warn');
  }
}

function etoroHeaders() {
  if (!process.env.ETORO_API_KEY || !process.env.ETORO_USER_KEY) {
    throw new Error('ETORO_API_KEY/ETORO_USER_KEY manquante pour le Shadow Lab');
  }
  return {
    'x-api-key': process.env.ETORO_API_KEY,
    'x-user-key': process.env.ETORO_USER_KEY,
    'x-request-id': randomUUID(),
    Accept: 'application/json'
  };
}

function assertReadOnlyUrl(url) {
  const normalized = String(url || '');
  if (!normalized.startsWith(`${ETORO_BASE}/`)) throw new Error('SHADOW_LAB_ETORO_HOST_BLOCKED');
  if (/\/trading\/execution\//i.test(normalized)) throw new Error('SHADOW_LAB_EXECUTION_ENDPOINT_BLOCKED');
  if (/\/watchlists\/.*(?:items|default-watchlist)/i.test(normalized) && !normalized.includes('/default-watchlists/items')) {
    throw new Error('SHADOW_LAB_WRITE_SURFACE_BLOCKED');
  }
}

async function etoroGet(url) {
  assertReadOnlyUrl(url);
  state.stats.apiReads += 1;
  const response = await fetch(url, { method: 'GET', headers: etoroHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`ETORO_READ_HTTP_${response.status}: ${body.slice(0, 500)}`);
    err.status = response.status;
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) err.retryAfterSeconds = Number(retryAfter) || null;
    throw err;
  }
  return response.json();
}

function loadUniverseConfig() {
  let config = { assets: [] };
  try {
    config = JSON.parse(fs.readFileSync(DEFAULT_UNIVERSE_PATH, 'utf8'));
  } catch (error) {
    log('UNIVERSE_CONFIG_READ_FAILED', { error: String(error.message || error).slice(0, 500) }, 'warn');
  }
  const extras = String(process.env.SHADOW_EXTRA_SYMBOLS || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((symbol) => ({ symbol, bucket: 'ENV_EXTRA', priority: 3 }));
  const merged = [...(Array.isArray(config.assets) ? config.assets : []), ...extras];
  const deduped = new Map();
  for (const item of merged) {
    const symbol = String(item?.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    const current = deduped.get(symbol);
    const candidate = {
      symbol,
      bucket: String(item?.bucket || 'UNCLASSIFIED').slice(0, 60),
      priority: clampNumber(item?.priority, 2, 0, 10)
    };
    if (!current || candidate.priority > current.priority) deduped.set(symbol, candidate);
  }
  return [...deduped.values()]
    .sort((a, b) => b.priority - a.priority || a.symbol.localeCompare(b.symbol))
    .slice(0, MAX_UNIVERSE);
}

function pickArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['rates', 'instruments', 'results', 'items', 'data', 'markets']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function first(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] != null) return obj[key];
  }
  return null;
}

function instrumentIdFrom(item) {
  const value = first(item, ['instrumentId', 'InstrumentId', 'InstrumentID', 'id', 'ID']);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function symbolFrom(item) {
  return String(first(item, ['internalSymbolFull', 'InternalSymbolFull', 'symbol', 'Symbol', 'symbolName', 'SymbolName']) || '').trim().toUpperCase();
}

function displayNameFrom(item) {
  return String(first(item, ['displayname', 'displayName', 'DisplayName', 'name', 'Name']) || '').trim().slice(0, 160) || null;
}

async function resolveSymbol(asset) {
  const symbol = asset.symbol;
  if (state.instrumentMap[symbol]?.instrumentId) return state.instrumentMap[symbol];
  const failure = state.unresolvedSymbols[symbol];
  if (failure?.retryAfter && Date.now() < Date.parse(failure.retryAfter)) return null;

  const fields = 'instrumentId,internalSymbolFull,displayname,instrumentTypeId,exchangeId';
  const url = `${SEARCH_ENDPOINT}?internalSymbolFull=${encodeURIComponent(symbol)}&fields=${encodeURIComponent(fields)}`;
  try {
    const data = await etoroGet(url);
    const items = pickArray(data);
    const exact = items.find((item) => symbolFrom(item) === symbol) || (items.length === 1 ? items[0] : null);
    const instrumentId = instrumentIdFrom(exact);
    if (!exact || !instrumentId) throw new Error('NO_EXACT_INSTRUMENT_MATCH');
    const resolved = {
      symbol,
      instrumentId,
      displayName: displayNameFrom(exact),
      bucket: asset.bucket,
      priority: asset.priority,
      resolvedAt: iso(),
      resolutionSource: 'ETORO_SEARCH'
    };
    state.instrumentMap[symbol] = resolved;
    delete state.unresolvedSymbols[symbol];
    state.stats.resolvedSymbols = Object.keys(state.instrumentMap).length;
    return resolved;
  } catch (error) {
    const attempts = Number(failure?.attempts || 0) + 1;
    const retryHours = Math.min(168, 6 * (2 ** Math.min(4, attempts - 1)));
    state.unresolvedSymbols[symbol] = {
      attempts,
      lastAttemptAt: iso(),
      retryAfter: new Date(Date.now() + retryHours * 3600_000).toISOString(),
      error: String(error.message || error).slice(0, 300)
    };
    return null;
  }
}

async function enrichFromDefaultWatchlist(universe) {
  if (!USE_DEFAULT_WATCHLIST) return universe;
  try {
    const data = await etoroGet(`${DEFAULT_WATCHLIST_ENDPOINT}?itemsPerPage=100&itemsLimit=100`);
    const items = pickArray(data);
    const bySymbol = new Map(universe.map((item) => [item.symbol, item]));
    for (const item of items) {
      const market = item?.market || item?.Market || item;
      const symbol = symbolFrom(market);
      const instrumentId = instrumentIdFrom(item) || instrumentIdFrom(market) || Number(item?.itemId || item?.ItemId) || null;
      if (!symbol || !instrumentId) continue;
      const asset = bySymbol.get(symbol) || { symbol, bucket: 'USER_WATCHLIST', priority: 8 };
      bySymbol.set(symbol, { ...asset, priority: Math.max(Number(asset.priority || 0), 8) });
      if (!state.instrumentMap[symbol]?.instrumentId) {
        state.instrumentMap[symbol] = {
          symbol,
          instrumentId: Number(instrumentId),
          displayName: displayNameFrom(market),
          bucket: asset.bucket,
          priority: Math.max(Number(asset.priority || 0), 8),
          resolvedAt: iso(),
          resolutionSource: 'ETORO_DEFAULT_WATCHLIST'
        };
      }
    }
    return [...bySymbol.values()]
      .sort((a, b) => b.priority - a.priority || a.symbol.localeCompare(b.symbol))
      .slice(0, MAX_UNIVERSE);
  } catch (error) {
    log('DEFAULT_WATCHLIST_READ_FAILED', { error: String(error.message || error).slice(0, 400) }, 'warn');
    return universe;
  }
}

async function resolveMissing(universe) {
  let attempted = 0;
  for (const asset of universe) {
    if (state.instrumentMap[asset.symbol]?.instrumentId) {
      state.instrumentMap[asset.symbol].bucket = asset.bucket;
      state.instrumentMap[asset.symbol].priority = asset.priority;
      continue;
    }
    if (attempted >= MAX_RESOLUTIONS_PER_SCAN) break;
    const failure = state.unresolvedSymbols[asset.symbol];
    if (failure?.retryAfter && Date.now() < Date.parse(failure.retryAfter)) continue;
    attempted += 1;
    await resolveSymbol(asset);
    if (attempted < MAX_RESOLUTIONS_PER_SCAN) await sleep(RESOLUTION_DELAY_MS);
  }
  return attempted;
}

function chunk(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeRate(item) {
  const instrumentId = instrumentIdFrom(item);
  if (!instrumentId) return null;
  const bid = Number(first(item, ['bid', 'Bid', 'sell', 'Sell']));
  const ask = Number(first(item, ['ask', 'Ask', 'buy', 'Buy']));
  const last = Number(first(item, ['lastPrice', 'LastPrice', 'last', 'Last', 'rate', 'Rate']));
  const mid = Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0
    ? (bid + ask) / 2
    : (Number.isFinite(last) && last > 0 ? last : null);
  if (!mid) return null;
  const spreadPct = Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid
    ? ((ask - bid) / mid) * 100
    : null;
  const timestamp = parseTimestamp(first(item, ['timestamp', 'Timestamp', 'lastUpdate', 'LastUpdate', 'updatedAt', 'UpdatedAt']));
  const reportedChange = Number(first(item, ['change', 'Change', 'changePercent', 'ChangePercent', 'dailyChange', 'DailyChange']));
  return {
    instrumentId,
    symbol: symbolFrom(item) || null,
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
    mid,
    spreadPct: round(spreadPct, 5),
    timestamp,
    reportedChange: Number.isFinite(reportedChange) ? reportedChange : null
  };
}

async function fetchRates(instruments) {
  const ids = instruments.map((item) => item.instrumentId).filter(Boolean);
  const output = new Map();
  for (const group of chunk(ids, 40)) {
    const data = await etoroGet(`${RATES_ENDPOINT}?instrumentIds=${encodeURIComponent(group.join(','))}`);
    for (const raw of pickArray(data)) {
      const rate = normalizeRate(raw);
      if (rate) output.set(rate.instrumentId, rate);
    }
    if (ids.length > 40) await sleep(250);
  }
  return output;
}

function appendPrice(symbol, rate, scannedAt) {
  if (!state.priceHistory[symbol]) state.priceHistory[symbol] = [];
  const history = state.priceHistory[symbol];
  history.push({ at: scannedAt, mid: round(rate.mid, 8), spreadPct: rate.spreadPct, sourceTimestamp: rate.timestamp });
  state.priceHistory[symbol] = history
    .filter((point) => point && Number(point.mid) > 0 && Date.now() - Date.parse(point.at) < 45 * 24 * 3600_000)
    .slice(-MAX_HISTORY_PER_SYMBOL);
}

function nearestPastPoint(history, targetMs, toleranceMs) {
  if (!Array.isArray(history) || !history.length) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const point of history) {
    const at = Date.parse(point.at);
    if (!Number.isFinite(at) || at > Date.now()) continue;
    const distance = Math.abs(at - targetMs);
    if (distance <= toleranceMs && distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

function observedReturn(symbol, currentMid, hours) {
  const history = state.priceHistory[symbol] || [];
  const target = Date.now() - hours * 3600_000;
  const tolerance = Math.max(3, hours * 0.25) * 3600_000;
  const point = nearestPastPoint(history, target, tolerance);
  if (!point || !(Number(point.mid) > 0)) return null;
  return ((currentMid / Number(point.mid)) - 1) * 100;
}

function freshnessMinutes(rate) {
  if (!rate.timestamp) return null;
  const ms = Date.now() - Date.parse(rate.timestamp);
  return Number.isFinite(ms) ? Math.max(0, ms / 60_000) : null;
}

function scoreCandidate(asset, rate) {
  const reasons = [];
  const freshMin = freshnessMinutes(rate);
  const r24 = observedReturn(asset.symbol, rate.mid, 24);
  const r72 = observedReturn(asset.symbol, rate.mid, 72);
  const r168 = observedReturn(asset.symbol, rate.mid, 168);
  let score = 30;

  if (freshMin == null) {
    score -= 8;
    reasons.push('timestamp fournisseur absent');
  } else if (freshMin <= 5) {
    score += 18;
    reasons.push('prix très frais');
  } else if (freshMin <= 30) {
    score += 12;
    reasons.push('prix frais');
  } else if (freshMin <= MAX_RATE_AGE_MINUTES) {
    score += 3;
    reasons.push('prix utilisable mais moins frais');
  } else {
    score -= 25;
    reasons.push('prix trop ancien');
  }

  if (rate.spreadPct == null) {
    score -= 5;
    reasons.push('spread non mesurable');
  } else if (rate.spreadPct <= 0.10) {
    score += 20;
    reasons.push('spread excellent');
  } else if (rate.spreadPct <= 0.25) {
    score += 16;
    reasons.push('spread faible');
  } else if (rate.spreadPct <= 0.50) {
    score += 10;
    reasons.push('spread correct');
  } else if (rate.spreadPct <= 1.0) {
    score += 4;
    reasons.push('spread moyen');
  } else if (rate.spreadPct > MAX_SPREAD_PCT) {
    score -= 25;
    reasons.push('spread trop large');
  } else {
    score -= 8;
    reasons.push('spread élevé');
  }

  const momentum = [
    ['24h', r24, 12],
    ['3j', r72, 8],
    ['7j', r168, 8]
  ];
  let momentumObservations = 0;
  for (const [label, value, weight] of momentum) {
    if (!Number.isFinite(value)) continue;
    momentumObservations += 1;
    if (value > 0 && value <= 8) {
      score += Math.min(weight, value * (weight / 4));
      reasons.push(`momentum ${label} +${round(value, 2)}%`);
    } else if (value > 8) {
      score += weight * 0.35;
      reasons.push(`momentum ${label} fort (+${round(value, 2)}%), prudence extension`);
    } else if (value < -8) {
      score -= weight;
      reasons.push(`repli ${label} ${round(value, 2)}%`);
    } else if (value < 0) {
      score += value * (weight / 5);
      reasons.push(`momentum ${label} ${round(value, 2)}%`);
    }
  }

  score += Math.min(8, Number(asset.priority || 0));
  if (momentumObservations === 0) reasons.push('historique shadow en construction');

  const eligible = Number(rate.mid) > 0 &&
    (rate.spreadPct == null || rate.spreadPct <= MAX_SPREAD_PCT) &&
    (freshMin == null || freshMin <= MAX_RATE_AGE_MINUTES);

  return {
    symbol: asset.symbol,
    instrumentId: asset.instrumentId,
    displayName: asset.displayName || null,
    bucket: asset.bucket,
    score: round(Math.max(0, Math.min(100, score)), 2),
    eligible,
    mid: round(rate.mid, 8),
    spreadPct: rate.spreadPct,
    freshnessMinutes: round(freshMin, 2),
    observedReturnsPct: { h24: round(r24, 3), h72: round(r72, 3), h168: round(r168, 3) },
    reasons: reasons.slice(0, 8)
  };
}

function newShadowSignals(candidates, scannedAt) {
  const selected = candidates
    .filter((candidate) => candidate.eligible && candidate.score >= MIN_SIGNAL_SCORE)
    .slice(0, SIGNAL_COUNT);
  const created = [];
  for (const candidate of selected) {
    const recentDuplicate = state.signals.find((signal) =>
      signal.symbol === candidate.symbol &&
      Date.now() - Date.parse(signal.generatedAt) < 20 * 3600_000
    );
    if (recentDuplicate) continue;
    const signal = {
      id: `shadow-${hash(`${candidate.symbol}:${scannedAt}:${candidate.mid}`)}`,
      generatedAt: scannedAt,
      symbol: candidate.symbol,
      instrumentId: candidate.instrumentId,
      bucket: candidate.bucket,
      entryMid: candidate.mid,
      score: candidate.score,
      hypotheticalAction: 'SHADOW_BUY_CANDIDATE',
      reasons: candidate.reasons,
      source: 'DETERMINISTIC_PHASE_1',
      aiUsed: false,
      aiCostUsd: 0,
      outcomes: {}
    };
    state.signals.push(signal);
    created.push(signal);
  }
  state.signals = state.signals.slice(-MAX_SIGNALS);
  return created;
}

function evaluateSignals(currentBySymbol, scannedAt) {
  let evaluations = 0;
  for (const signal of state.signals) {
    const current = currentBySymbol.get(signal.symbol);
    if (!current || !(signal.entryMid > 0)) continue;
    const ageHours = (Date.parse(scannedAt) - Date.parse(signal.generatedAt)) / 3600_000;
    if (!Number.isFinite(ageHours) || ageHours < 0) continue;
    signal.outcomes = signal.outcomes || {};
    for (const [key, horizonHours] of Object.entries(HORIZONS_HOURS)) {
      if (signal.outcomes[key] || ageHours < horizonHours) continue;
      const returnPct = ((current.mid / signal.entryMid) - 1) * 100;
      signal.outcomes[key] = {
        evaluatedAt: scannedAt,
        horizonHours,
        price: round(current.mid, 8),
        returnPct: round(returnPct, 4),
        positive: returnPct > 0
      };
      evaluations += 1;
    }
  }
  return evaluations;
}

function outcomeSummary() {
  const result = {};
  for (const key of Object.keys(HORIZONS_HOURS)) {
    const values = state.signals.map((signal) => signal.outcomes?.[key]?.returnPct).filter(Number.isFinite);
    result[key] = {
      evaluatedSignals: values.length,
      hitRatePct: values.length ? round(values.filter((v) => v > 0).length / values.length * 100, 2) : null,
      averageReturnPct: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 4) : null,
      medianReturnPct: values.length ? round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)], 4) : null
    };
  }
  return result;
}

async function runShadowScan(trigger = 'manual-internal') {
  if (!ENABLED) return { ok: false, skipped: true, reason: 'DISABLED' };
  if (scanInProgress) return { ok: false, skipped: true, reason: 'SCAN_ALREADY_RUNNING' };
  scanInProgress = true;
  const startedAt = Date.now();
  const scannedAt = iso();
  try {
    await loadState();
    let universe = loadUniverseConfig();
    universe = await enrichFromDefaultWatchlist(universe);
    const resolutionAttempts = await resolveMissing(universe);

    const resolvedAssets = universe.map((asset) => {
      const mapped = state.instrumentMap[asset.symbol];
      return mapped?.instrumentId ? { ...asset, ...mapped } : null;
    }).filter(Boolean);

    const ratesById = await fetchRates(resolvedAssets);
    const currentBySymbol = new Map();
    const candidates = [];
    for (const asset of resolvedAssets) {
      const rate = ratesById.get(asset.instrumentId);
      if (!rate) continue;
      appendPrice(asset.symbol, rate, scannedAt);
      currentBySymbol.set(asset.symbol, rate);
      candidates.push(scoreCandidate(asset, rate));
    }
    candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));

    const evaluations = evaluateSignals(currentBySymbol, scannedAt);
    const createdSignals = newShadowSignals(candidates, scannedAt);
    state.stats.scans += 1;
    state.stats.resolvedSymbols = Object.keys(state.instrumentMap).length;
    const record = {
      scannedAt,
      trigger,
      durationMs: Date.now() - startedAt,
      configuredUniverse: universe.length,
      resolvedUniverse: resolvedAssets.length,
      ratesReceived: currentBySymbol.size,
      resolutionAttempts,
      shadowSignalsCreated: createdSignals.length,
      outcomesEvaluated: evaluations,
      topCandidates: candidates.slice(0, TOP_CANDIDATES),
      outcomeSummary: outcomeSummary(),
      safety: {
        readOnly: true,
        executionCalls: 0,
        apiWrites: 0,
        openAiCalls: 0,
        openAiCostUsd: 0,
        liveAllowlistModified: false
      }
    };
    state.scanHistory.push(record);
    state.scanHistory = state.scanHistory.slice(-MAX_SCAN_HISTORY);
    await saveState();
    log('SCAN_COMPLETED', {
      trigger,
      durationMs: record.durationMs,
      configuredUniverse: record.configuredUniverse,
      resolvedUniverse: record.resolvedUniverse,
      ratesReceived: record.ratesReceived,
      resolutionAttempts,
      shadowSignalsCreated: createdSignals.length,
      outcomesEvaluated: evaluations,
      top: record.topCandidates.slice(0, 5).map((c) => ({ symbol: c.symbol, score: c.score, spreadPct: c.spreadPct })),
      apiReads: state.stats.apiReads,
      openAiCalls: 0,
      executionCalls: 0
    });
    return { ok: true, ...record };
  } catch (error) {
    state.stats.scanFailures += 1;
    await saveState().catch(() => {});
    log('SCAN_FAILED', {
      trigger,
      durationMs: Date.now() - startedAt,
      error: String(error.message || error).slice(0, 1000),
      status: error.status || null,
      retryAfterSeconds: error.retryAfterSeconds || null,
      safety: { executionCalls: 0, apiWrites: 0, openAiCalls: 0 }
    }, 'warn');
    return { ok: false, error: String(error.message || error) };
  } finally {
    scanInProgress = false;
  }
}

async function stateSnapshot() {
  await loadState();
  const lastScan = state.scanHistory[state.scanHistory.length - 1] || null;
  return {
    version: VERSION,
    enabled: ENABLED,
    schedule: SCHEDULE,
    running: scanInProgress,
    persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
    configuredUniverse: loadUniverseConfig().length,
    resolvedSymbols: Object.keys(state.instrumentMap).length,
    unresolvedSymbols: Object.keys(state.unresolvedSymbols).length,
    signalsTracked: state.signals.length,
    stats: { ...state.stats, apiWrites: 0, executionCalls: 0, openAiCalls: 0, openAiCostUsd: 0 },
    outcomeSummary: outcomeSummary(),
    lastScan,
    lastEvent,
    safety: {
      phase: 'SHADOW_ONLY',
      canTrade: false,
      executionEndpointAllowed: false,
      liveAllowlistModified: false,
      openAiEnabled: false,
      openAiCostUsd: 0
    }
  };
}

global.__LEO_SHADOW_LAB_RUN__ = runShadowScan;
global.__LEO_SHADOW_LAB_STATE__ = stateSnapshot;

if (ENABLED) {
  try {
    cron.schedule(SCHEDULE, () => {
      runShadowScan('shadow-cron').catch((error) => log('CRON_UNHANDLED', { error: String(error.message || error) }, 'warn'));
    });
    started = true;
  } catch (error) {
    log('SCHEDULE_INVALID', { schedule: SCHEDULE, error: String(error.message || error) }, 'warn');
  }

  if (STARTUP_DELAY_MINUTES >= 0) {
    const timer = setTimeout(() => {
      runShadowScan('startup-delay').catch((error) => log('STARTUP_SCAN_UNHANDLED', { error: String(error.message || error) }, 'warn'));
    }, STARTUP_DELAY_MINUTES * 60_000);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

log('STARTED', {
  enabled: ENABLED,
  schedulerStarted: started,
  schedule: SCHEDULE,
  startupDelayMinutes: STARTUP_DELAY_MINUTES,
  maxUniverse: MAX_UNIVERSE,
  maxResolutionsPerScan: MAX_RESOLUTIONS_PER_SCAN,
  phase: 'SHADOW_ONLY',
  readOnlyEtoro: true,
  openAiCalls: 0,
  openAiCostUsd: 0,
  liveExecutionArmedModified: false,
  liveAllowlistModified: false,
  executionFunctionsPresent: false
});

module.exports = {
  VERSION,
  runShadowScan,
  stateSnapshot,
  scoreCandidate,
  normalizeRate,
  assertReadOnlyUrl
};
