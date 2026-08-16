'use strict';

/**
 * LEO-AI SENTINEL v10.23.2 — Alpaca Independent Data Validator
 *
 * Shadow/research only. This module has no network client and no trading surface.
 * It consumes an eToro market observation plus an Alpaca snapshot supplied by a
 * trusted research adapter (for example the connected Alpaca plugin in ChatGPT),
 * compares the two providers, persists a compact audit trail, and can feed
 * normalized ALPACA evidence into the Shadow Research Layer.
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const VERSION = 'v10.23.2-alpaca-independent-data-validator';
const PREFIX = '[LEO_ALPACA_VALIDATOR]';
const ENABLED = process.env.SHADOW_ALPACA_VALIDATOR_ENABLED !== 'false';
const MAX_AUDIT = Math.round(clamp(process.env.SHADOW_ALPACA_MAX_AUDIT, 300, 50, 3000));
const DEFAULT_STOCK_DIVERGENCE_PCT = clamp(process.env.SHADOW_ALPACA_STOCK_MAX_DIVERGENCE_PCT, 0.8, 0.05, 10);
const DEFAULT_CRYPTO_DIVERGENCE_PCT = clamp(process.env.SHADOW_ALPACA_CRYPTO_MAX_DIVERGENCE_PCT, 1.5, 0.05, 20);
const DEFAULT_STOCK_SPREAD_PCT = clamp(process.env.SHADOW_ALPACA_STOCK_MAX_SPREAD_PCT, 1.0, 0.02, 10);
const DEFAULT_CRYPTO_SPREAD_PCT = clamp(process.env.SHADOW_ALPACA_CRYPTO_MAX_SPREAD_PCT, 2.0, 0.02, 20);
const DEFAULT_ETORO_MAX_AGE_MIN = clamp(process.env.SHADOW_ALPACA_ETORO_MAX_AGE_MINUTES, 20, 1, 1440);
const DEFAULT_ALPACA_MAX_AGE_MIN = clamp(process.env.SHADOW_ALPACA_MAX_AGE_MINUTES, 20, 1, 1440);
const FUTURE_TOLERANCE_MINUTES = clamp(process.env.SHADOW_ALPACA_FUTURE_TOLERANCE_MINUTES, 5, 0, 60);

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const HAS_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const STATE_KEY = String(process.env.SHADOW_ALPACA_STATE_KEY || 'leo:shadow-alpaca:v10.23.2:state');
const STATE_FILE = process.env.SHADOW_ALPACA_STATE_FILE || path.join(
  process.env.PERSISTENT_DISK_PATH || '/tmp',
  'leo-shadow-alpaca-validator-state.json'
);

let loaded = false;
let loadPromise = null;
let state = freshState();
let lastEvent = null;

function clamp(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
function iso(ms = Date.now()) { return new Date(ms).toISOString(); }
function hash(value) { return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24); }
function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function validDate(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function normalizeSymbol(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  return raw.endsWith('/USD') ? raw.slice(0, -4) : raw;
}
function isCryptoSymbol(symbol) {
  return new Set(['BTC', 'ETH', 'SOL', 'LTC', 'BCH', 'DOGE', 'AVAX', 'LINK', 'UNI', 'AAVE']).has(normalizeSymbol(symbol));
}
function ageMinutes(timestamp, nowMs = Date.now()) {
  const ms = Date.parse(String(timestamp || ''));
  if (!Number.isFinite(ms)) return null;
  return (nowMs - ms) / 60000;
}
function spreadPct(bid, ask) {
  const b = finite(bid);
  const a = finite(ask);
  if (!(b > 0) || !(a > 0) || a < b) return null;
  const mid = (a + b) / 2;
  return ((a - b) / mid) * 100;
}
function log(event, details = {}, level = 'log') {
  const payload = { component: 'LEO_ALPACA_VALIDATOR', version: VERSION, event, at: iso(), ...details };
  lastEvent = payload;
  global.__LEO_ALPACA_VALIDATOR_LAST_EVENT__ = payload;
  (console[level] || console.log)(`${PREFIX} ${JSON.stringify(payload)}`);
}

function freshState() {
  return {
    version: VERSION,
    createdAt: iso(),
    updatedAt: iso(),
    audit: [],
    stats: {
      validations: 0,
      confirmed: 0,
      divergent: 0,
      stale: 0,
      inconclusive: 0,
      evidenceIngested: 0,
      evidenceRejected: 0,
      networkCalls: 0,
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
    audit: Array.isArray(value.audit) ? value.audit.slice(-MAX_AUDIT) : [],
    stats: {
      ...base.stats,
      ...(value.stats || {}),
      networkCalls: 0,
      executionCalls: 0,
      openAiCalls: 0,
      openAiCostUsd: 0
    }
  };
}
async function redis(command) {
  if (!HAS_UPSTASH) throw new Error('UPSTASH_NOT_CONFIGURED');
  const response = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`UPSTASH_HTTP_${response.status}`);
  const json = await response.json();
  if (json?.error) throw new Error(`UPSTASH_${json.error}`);
  return json?.result ?? null;
}
async function loadState() {
  if (loaded) return state;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      if (HAS_UPSTASH) {
        const raw = await redis(['GET', STATE_KEY]);
        state = raw ? normalizeState(JSON.parse(raw)) : freshState();
      } else if (fs.existsSync(STATE_FILE)) {
        state = normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      }
    } catch (error) {
      log('STATE_LOAD_FALLBACK', { error: String(error?.message || error).slice(0, 400) }, 'warn');
      state = normalizeState(state);
    }
    loaded = true;
    return state;
  })();
  try { return await loadPromise; } finally { loadPromise = null; }
}
async function saveState() {
  state.updatedAt = iso();
  const body = JSON.stringify(state);
  try {
    if (HAS_UPSTASH) {
      await redis(['SET', STATE_KEY, body]);
      return;
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    log('STATE_SAVE_FAILED', { error: String(error?.message || error).slice(0, 400) }, 'warn');
  }
}

function unwrapAlpacaSnapshot(payload, requestedSymbol = '') {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.latest_quote || payload.latest_trade || payload.daily_bar) return payload;
  const snapshots = payload.snapshots && typeof payload.snapshots === 'object' ? payload.snapshots : null;
  if (!snapshots) return null;
  const requested = String(requestedSymbol || '').toUpperCase();
  const normalized = normalizeSymbol(requested);
  const candidates = [requested, normalized, normalized ? `${normalized}/USD` : ''].filter(Boolean);
  for (const key of candidates) {
    if (snapshots[key]) return snapshots[key];
  }
  const entries = Object.entries(snapshots);
  if (entries.length === 1) return entries[0][1];
  return null;
}

function normalizeAlpacaSnapshot(payload, requestedSymbol = '') {
  const snapshot = unwrapAlpacaSnapshot(payload, requestedSymbol);
  if (!snapshot) return null;
  const symbol = normalizeSymbol(snapshot.symbol || requestedSymbol);
  if (!symbol) return null;

  const quote = snapshot.latest_quote || {};
  const trade = snapshot.latest_trade || {};
  const minute = snapshot.minute_bar || {};
  const daily = snapshot.daily_bar || {};
  const previous = snapshot.previous_daily_bar || {};
  const bid = finite(quote.bid_price ?? quote.bidPrice);
  const ask = finite(quote.ask_price ?? quote.askPrice);
  const quoteMid = bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : null;
  const tradePrice = finite(trade.price);
  const minuteClose = finite(minute.close);
  const price = quoteMid || (tradePrice > 0 ? tradePrice : null) || (minuteClose > 0 ? minuteClose : null);
  if (!(price > 0)) return null;

  const timestamp = validDate(quote.timestamp) || validDate(trade.timestamp) || validDate(minute.timestamp) || validDate(daily.timestamp);
  const dailyHigh = finite(daily.high);
  const dailyLow = finite(daily.low);
  const dailyClose = finite(daily.close);
  const dailyRangePct = dailyHigh > 0 && dailyLow > 0 && dailyClose > 0 && dailyHigh >= dailyLow
    ? ((dailyHigh - dailyLow) / dailyClose) * 100
    : null;
  const previousClose = finite(previous.close);
  const dailyReturnPct = dailyClose > 0 && previousClose > 0 ? ((dailyClose / previousClose) - 1) * 100 : null;

  return {
    source: 'ALPACA',
    symbol,
    rawSymbol: String(snapshot.symbol || requestedSymbol || '').toUpperCase(),
    timestamp,
    price: round(price, 8),
    priceBasis: quoteMid ? 'QUOTE_MID' : (tradePrice > 0 ? 'LATEST_TRADE' : 'MINUTE_CLOSE'),
    bid: bid > 0 ? bid : null,
    ask: ask > 0 ? ask : null,
    spreadPct: round(spreadPct(bid, ask), 5),
    dailyVolume: finite(daily.volume),
    dailyTradeCount: finite(daily.trade_count ?? daily.tradeCount),
    dailyRangePct: round(dailyRangePct, 4),
    dailyReturnPct: round(dailyReturnPct, 4),
    quoteComplete: Boolean(bid > 0 && ask > 0 && ask >= bid)
  };
}

function normalizeEtoroObservation(input = {}) {
  const symbol = normalizeSymbol(input.symbol || input.asset);
  const bid = finite(input.bid);
  const ask = finite(input.ask);
  const explicitMid = finite(input.mid ?? input.price);
  const mid = explicitMid > 0 ? explicitMid : (bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : null);
  if (!symbol || !(mid > 0)) return null;
  return {
    source: 'ETORO_SHADOW',
    symbol,
    timestamp: validDate(input.sourceTimestamp || input.timestamp || input.at),
    price: round(mid, 8),
    bid: bid > 0 ? bid : null,
    ask: ask > 0 ? ask : null,
    spreadPct: round(input.spreadPct != null ? finite(input.spreadPct) : spreadPct(bid, ask), 5)
  };
}

function freshnessQuality(age, maxAge, futureTolerance = FUTURE_TOLERANCE_MINUTES) {
  if (!Number.isFinite(age)) return { ok: false, quality: 0, reason: 'TIMESTAMP_MISSING' };
  if (age < -futureTolerance) return { ok: false, quality: 0, reason: 'TIMESTAMP_FROM_FUTURE' };
  if (age > maxAge) return { ok: false, quality: 0, reason: 'STALE' };
  const normalizedAge = Math.max(0, age);
  return { ok: true, quality: clamp(1 - normalizedAge / Math.max(1, maxAge), 0, 0, 1), reason: 'FRESH' };
}

function compareMarketObservations(etoroInput, alpacaPayload, options = {}) {
  const etoro = normalizeEtoroObservation(etoroInput);
  const requestedSymbol = etoro?.symbol || normalizeSymbol(options.symbol || '');
  const alpaca = normalizeAlpacaSnapshot(alpacaPayload, requestedSymbol);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  if (!etoro || !alpaca || etoro.symbol !== alpaca.symbol) {
    return {
      id: `alpaca-validation-${hash(JSON.stringify({ etoroInput, requestedSymbol }))}`,
      status: 'INCONCLUSIVE',
      reason: !etoro ? 'ETORO_OBSERVATION_INVALID' : (!alpaca ? 'ALPACA_SNAPSHOT_INVALID' : 'SYMBOL_MISMATCH'),
      symbol: etoro?.symbol || alpaca?.symbol || requestedSymbol || null,
      etoro,
      alpaca,
      canTrade: false,
      canAuthorizeLive: false
    };
  }

  const crypto = isCryptoSymbol(etoro.symbol);
  const maxDivergencePct = clamp(options.maxPriceDivergencePct,
    crypto ? DEFAULT_CRYPTO_DIVERGENCE_PCT : DEFAULT_STOCK_DIVERGENCE_PCT, 0.01, 25);
  const maxSpreadPct = clamp(options.maxSpreadPct,
    crypto ? DEFAULT_CRYPTO_SPREAD_PCT : DEFAULT_STOCK_SPREAD_PCT, 0.01, 25);
  const etoroMaxAge = clamp(options.etoroMaxAgeMinutes, DEFAULT_ETORO_MAX_AGE_MIN, 1, 10080);
  const alpacaMaxAge = clamp(options.alpacaMaxAgeMinutes, DEFAULT_ALPACA_MAX_AGE_MIN, 1, 10080);

  const etoroAge = ageMinutes(etoro.timestamp, nowMs);
  const alpacaAge = ageMinutes(alpaca.timestamp, nowMs);
  const etoroFresh = freshnessQuality(etoroAge, etoroMaxAge);
  const alpacaFresh = freshnessQuality(alpacaAge, alpacaMaxAge);
  const divergencePct = Math.abs(etoro.price - alpaca.price) / ((etoro.price + alpaca.price) / 2) * 100;
  const etoroSpreadOk = etoro.spreadPct == null || etoro.spreadPct <= maxSpreadPct;
  const alpacaSpreadOk = alpaca.spreadPct == null || alpaca.spreadPct <= maxSpreadPct;

  let status = 'INCONCLUSIVE';
  let reason = 'INSUFFICIENT_QUALITY';
  if (!etoroFresh.ok || !alpacaFresh.ok) {
    status = 'STALE';
    reason = !etoroFresh.ok ? `ETORO_${etoroFresh.reason}` : `ALPACA_${alpacaFresh.reason}`;
  } else if (divergencePct > maxDivergencePct) {
    status = 'DIVERGENT';
    reason = 'PRICE_DIVERGENCE';
  } else if (!etoroSpreadOk || !alpacaSpreadOk) {
    status = 'INCONCLUSIVE';
    reason = !etoroSpreadOk ? 'ETORO_SPREAD_TOO_WIDE' : 'ALPACA_SPREAD_TOO_WIDE';
  } else {
    status = 'CONFIRMED';
    reason = 'INDEPENDENT_PRICE_CONFIRMATION';
  }

  const divergenceQuality = clamp(1 - divergencePct / Math.max(0.0001, maxDivergencePct), 0, 0, 1);
  const quoteQuality = alpaca.quoteComplete ? 1 : 0.65;
  const confidence = round(clamp(
    0.4 * etoroFresh.quality + 0.3 * alpacaFresh.quality + 0.2 * divergenceQuality + 0.1 * quoteQuality,
    0, 0, 1
  ), 4);

  return {
    id: `alpaca-validation-${hash(`${etoro.symbol}:${etoro.timestamp}:${alpaca.timestamp}:${etoro.price}:${alpaca.price}`)}`,
    evaluatedAt: iso(nowMs),
    status,
    reason,
    symbol: etoro.symbol,
    assetClass: crypto ? 'CRYPTO' : 'STOCK_OR_ETF',
    priceDivergencePct: round(divergencePct, 5),
    maxPriceDivergencePct: maxDivergencePct,
    etoroAgeMinutes: round(etoroAge, 3),
    alpacaAgeMinutes: round(alpacaAge, 3),
    maxSpreadPct,
    confidence,
    etoro,
    alpaca,
    quality: {
      etoroFresh: etoroFresh.ok,
      alpacaFresh: alpacaFresh.ok,
      etoroSpreadOk,
      alpacaSpreadOk,
      alpacaQuoteComplete: alpaca.quoteComplete
    },
    canTrade: false,
    canAuthorizeLive: false,
    researchOnly: true
  };
}

function evidenceFromValidation(report) {
  if (!report || !report.symbol || report.status === 'STALE' || report.status === 'INCONCLUSIVE') return [];
  const observedAt = report.alpaca?.timestamp || report.evaluatedAt || iso();
  const confirmationScore = report.status === 'CONFIRMED'
    ? clamp(0.45 + 0.5 * Number(report.confidence || 0), 0.45, 0, 0.95)
    : -0.9;
  const liquiditySpread = finite(report.alpaca?.spreadPct);
  let liquidityScore = 0;
  if (liquiditySpread != null) {
    if (liquiditySpread <= 0.15) liquidityScore = 0.8;
    else if (liquiditySpread <= 0.5) liquidityScore = 0.5;
    else if (liquiditySpread <= report.maxSpreadPct) liquidityScore = 0.15;
    else liquidityScore = -0.7;
  }
  const range = finite(report.alpaca?.dailyRangePct);
  let volatilityScore = 0;
  if (range != null) {
    if (range <= 1.5) volatilityScore = 0.4;
    else if (range <= 3) volatilityScore = 0.2;
    else if (range <= 6) volatilityScore = -0.2;
    else volatilityScore = -0.6;
  }

  const base = {
    source: 'ALPACA',
    symbol: report.symbol,
    confidence: clamp(report.confidence, 0.5, 0, 1),
    observedAt,
    reference: `urn:alpaca:snapshot:${report.symbol}`
  };
  return [
    {
      ...base,
      kind: 'MARKET_CONFIRMATION',
      score: round(confirmationScore, 4),
      ttlHours: 8,
      title: `Alpaca independent market confirmation ${report.symbol}`,
      summary: `${report.status}; divergence ${report.priceDivergencePct}% (limit ${report.maxPriceDivergencePct}%).`
    },
    ...(liquiditySpread != null ? [{
      ...base,
      kind: 'LIQUIDITY',
      score: liquidityScore,
      ttlHours: 12,
      title: `Alpaca quote liquidity ${report.symbol}`,
      summary: `Observed quote spread ${round(liquiditySpread, 4)}%. IEX/SIP coverage must be interpreted according to the feed used.`
    }] : []),
    ...(range != null ? [{
      ...base,
      kind: 'VOLATILITY',
      score: volatilityScore,
      ttlHours: 24,
      title: `Alpaca daily range ${report.symbol}`,
      summary: `Observed daily high-low range ${round(range, 4)}%. This is a risk-quality feature, not a directional forecast.`
    }] : [])
  ];
}

async function ingestValidation(etoroInput, alpacaPayload, options = {}) {
  await loadState();
  if (!ENABLED) return { ok: false, reason: 'DISABLED' };
  const report = compareMarketObservations(etoroInput, alpacaPayload, options);
  state.stats.validations += 1;
  const bucket = String(report.status || 'INCONCLUSIVE').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(state.stats, bucket)) state.stats[bucket] += 1;
  else state.stats.inconclusive += 1;

  let evidenceResults = [];
  const evidence = evidenceFromValidation(report);
  const researchIngest = global.__LEO_SHADOW_RESEARCH_BULK_INGEST__;
  if (evidence.length && typeof researchIngest === 'function') {
    evidenceResults = await researchIngest(evidence);
    for (const result of evidenceResults) {
      if (result?.ok) state.stats.evidenceIngested += 1;
      else state.stats.evidenceRejected += 1;
    }
  }

  state.audit.push({
    id: report.id,
    evaluatedAt: report.evaluatedAt || iso(),
    symbol: report.symbol || null,
    status: report.status,
    reason: report.reason,
    priceDivergencePct: report.priceDivergencePct ?? null,
    confidence: report.confidence ?? null,
    evidenceAttempted: evidence.length,
    evidenceAccepted: evidenceResults.filter((item) => item?.ok).length
  });
  state.audit = state.audit.slice(-MAX_AUDIT);
  await saveState();
  log('VALIDATION_COMPLETED', {
    symbol: report.symbol || null,
    status: report.status,
    reason: report.reason,
    divergencePct: report.priceDivergencePct ?? null,
    confidence: report.confidence ?? null,
    evidenceAccepted: evidenceResults.filter((item) => item?.ok).length,
    networkCalls: 0,
    executionCalls: 0,
    openAiCalls: 0
  }, report.status === 'DIVERGENT' ? 'warn' : 'log');
  return { ok: true, report, evidence, evidenceResults };
}

async function stateSnapshot() {
  await loadState();
  return {
    version: VERSION,
    enabled: ENABLED,
    persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
    stats: { ...state.stats, networkCalls: 0, executionCalls: 0, openAiCalls: 0, openAiCostUsd: 0 },
    recentAudit: state.audit.slice(-30),
    lastEvent,
    thresholds: {
      stockMaxDivergencePct: DEFAULT_STOCK_DIVERGENCE_PCT,
      cryptoMaxDivergencePct: DEFAULT_CRYPTO_DIVERGENCE_PCT,
      stockMaxSpreadPct: DEFAULT_STOCK_SPREAD_PCT,
      cryptoMaxSpreadPct: DEFAULT_CRYPTO_SPREAD_PCT,
      etoroMaxAgeMinutes: DEFAULT_ETORO_MAX_AGE_MIN,
      alpacaMaxAgeMinutes: DEFAULT_ALPACA_MAX_AGE_MIN,
      futureToleranceMinutes: FUTURE_TOLERANCE_MINUTES
    },
    safety: {
      researchOnly: true,
      canTrade: false,
      canAuthorizeLive: false,
      networkClientPresent: false,
      executionFunctionsPresent: false,
      automaticLivePromotion: false,
      openAiEnabled: false,
      openAiCostUsd: 0
    }
  };
}

global.__LEO_ALPACA_VALIDATE__ = ingestValidation;
global.__LEO_ALPACA_VALIDATOR_STATE__ = stateSnapshot;

log('STARTED', {
  enabled: ENABLED,
  persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
  networkClientPresent: false,
  executionFunctionsPresent: false,
  automaticLivePromotion: false,
  openAiCalls: 0,
  openAiCostUsd: 0
});

module.exports = {
  VERSION,
  normalizeSymbol,
  normalizeAlpacaSnapshot,
  normalizeEtoroObservation,
  compareMarketObservations,
  evidenceFromValidation,
  ingestValidation,
  stateSnapshot
};
