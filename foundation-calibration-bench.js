'use strict';

/**
 * LEO-AI SENTINEL v10.23.5 — Foundation Calibration Bench
 *
 * Research-only calibration ledger for Stage 3 (Alpaca) and Stage 5 (Exa).
 * It makes no market-data request, no eToro execution request and no OpenAI call.
 * It only reads snapshots exposed by the already-loaded Shadow modules and may
 * persist its own isolated research state to Upstash (or a local file fallback).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 'v10.23.5-foundation-calibration-bench';
const PREFIX = '[LEO_FOUNDATION_CALIBRATION]';
const ENABLED = process.env.FOUNDATION_CALIBRATION_ENABLED !== 'false';
const INTERVAL_MINUTES = clamp(process.env.FOUNDATION_CALIBRATION_INTERVAL_MINUTES, 60, 15, 1440);
const STARTUP_DELAY_SECONDS = clamp(process.env.FOUNDATION_CALIBRATION_STARTUP_DELAY_SECONDS, 45, 0, 900);
const MAX_ALPACA_PAIRS = Math.round(clamp(process.env.FOUNDATION_CALIBRATION_MAX_ALPACA_PAIRS, 1000, 100, 10000));
const MAX_EXA_EVENTS = Math.round(clamp(process.env.FOUNDATION_CALIBRATION_MAX_EXA_EVENTS, 1000, 100, 10000));
const MAX_ANCHOR_LAG_MINUTES = clamp(process.env.FOUNDATION_CALIBRATION_MAX_ANCHOR_LAG_MINUTES, 360, 15, 1440);
const HORIZONS_HOURS = Object.freeze({ d1: 24, d3: 72, d7: 168 });

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const HAS_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const STATE_KEY = String(process.env.FOUNDATION_CALIBRATION_STATE_KEY || 'leo:foundation-calibration:v10.23.5');
const STATE_FILE = process.env.FOUNDATION_CALIBRATION_STATE_FILE || path.join(
  process.env.PERSISTENT_DISK_PATH || '/tmp',
  'leo-foundation-calibration-v10.23.5.json'
);

let state = freshState();
let loaded = false;
let loadPromise = null;
let captureInProgress = false;
let lastEvent = null;
let interval = null;

function clamp(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function iso(ms = Date.now()) { return new Date(ms).toISOString(); }
function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}
function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function hash(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24);
}
function sanitize(value, max = 300) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function log(event, details = {}, level = 'log') {
  const payload = { component: 'LEO_FOUNDATION_CALIBRATION_BENCH', version: VERSION, event, at: iso(), ...details };
  lastEvent = payload;
  global.__LEO_FOUNDATION_CALIBRATION_LAST_EVENT__ = payload;
  (console[level] || console.log)(`${PREFIX} ${JSON.stringify(payload)}`);
}

function freshState() {
  return {
    version: VERSION,
    createdAt: iso(),
    updatedAt: iso(),
    alpacaPairs: [],
    exaEvents: [],
    stats: {
      captures: 0,
      captureFailures: 0,
      alpacaPairsAdded: 0,
      exaEventsAdded: 0,
      exaEventsAnchored: 0,
      exaOutcomesAdded: 0,
      marketNetworkCalls: 0,
      executionCalls: 0,
      openAiCalls: 0
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
    alpacaPairs: Array.isArray(value.alpacaPairs) ? value.alpacaPairs.slice(-MAX_ALPACA_PAIRS) : [],
    exaEvents: Array.isArray(value.exaEvents) ? value.exaEvents.slice(-MAX_EXA_EVENTS) : [],
    stats: {
      ...base.stats,
      ...(value.stats || {}),
      marketNetworkCalls: 0,
      executionCalls: 0,
      openAiCalls: 0
    }
  };
}

async function redis(command) {
  if (!HAS_UPSTASH) throw new Error('UPSTASH_NOT_CONFIGURED');
  const response = await global.fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`UPSTASH_HTTP_${response.status}`);
  const body = await response.json();
  if (body?.error) throw new Error(`UPSTASH_${sanitize(body.error, 200)}`);
  return body?.result ?? null;
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
      } else {
        state = freshState();
      }
    } catch (error) {
      log('STATE_LOAD_FALLBACK', { error: sanitize(error?.message || error, 500) }, 'warn');
      state = normalizeState(state);
    }
    loaded = true;
    return state;
  })();
  try { return await loadPromise; } finally { loadPromise = null; }
}

async function saveState() {
  state.updatedAt = iso();
  const raw = JSON.stringify(state);
  try {
    if (HAS_UPSTASH) {
      await redis(['SET', STATE_KEY, raw]);
      return;
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const temp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, raw, 'utf8');
    fs.renameSync(temp, STATE_FILE);
  } catch (error) {
    log('STATE_SAVE_FAILED', { error: sanitize(error?.message || error, 500) }, 'warn');
  }
}

async function safeSnapshot(globalName) {
  try {
    const fn = global[globalName];
    if (typeof fn !== 'function') return null;
    return await fn();
  } catch (error) {
    log('SOURCE_SNAPSHOT_FAILED', { source: globalName, error: sanitize(error?.message || error, 500) }, 'warn');
    return null;
  }
}

function shadowPriceMap(shadowSnapshot) {
  const map = new Map();
  const scan = shadowSnapshot?.lastScan || null;
  const at = scan?.scannedAt || null;
  for (const item of Array.isArray(scan?.topCandidates) ? scan.topCandidates : []) {
    const symbol = String(item?.symbol || '').trim().toUpperCase();
    const price = finite(item?.mid);
    if (!symbol || !(price > 0)) continue;
    map.set(symbol, { symbol, price, at });
  }
  return map;
}

function alpacaPairFromAudit(item) {
  if (!item || typeof item !== 'object') return null;
  const symbol = String(item.symbol || '').trim().toUpperCase();
  const evaluatedAt = item.evaluatedAt || null;
  const status = String(item.status || 'INCONCLUSIVE').toUpperCase();
  if (!symbol || !evaluatedAt) return null;
  return {
    id: String(item.id || `alpaca-${hash(`${symbol}:${evaluatedAt}:${status}:${item.priceDivergencePct}`)}`),
    symbol,
    evaluatedAt,
    status,
    reason: sanitize(item.reason || '', 180) || null,
    priceDivergencePct: finite(item.priceDivergencePct),
    confidence: finite(item.confidence)
  };
}

function exaEventFromAudit(item, priceMap, nowMs = Date.now()) {
  if (!item || typeof item !== 'object') return null;
  const symbol = String(item.symbol || '').trim().toUpperCase();
  const evaluatedAt = item.evaluatedAt || null;
  if (!symbol || !evaluatedAt) return null;
  const eventKey = sanitize(item.eventKey || item.id || '', 220) || `event-${hash(JSON.stringify(item))}`;
  const id = String(item.id || `exa-${hash(`${symbol}:${eventKey}:${evaluatedAt}`)}`);
  const current = priceMap.get(symbol) || null;
  const eventMs = Date.parse(evaluatedAt);
  const priceMs = current?.at ? Date.parse(current.at) : NaN;
  const lagMinutes = Number.isFinite(eventMs) && Number.isFinite(priceMs) ? Math.abs(priceMs - eventMs) / 60_000 : null;
  const anchorAllowed = current && lagMinutes != null && lagMinutes <= MAX_ANCHOR_LAG_MINUTES;
  return {
    id,
    eventKey,
    symbol,
    evaluatedAt,
    eventType: sanitize(item.eventType || '', 80) || null,
    status: String(item.status || 'INCONCLUSIVE').toUpperCase(),
    directionScore: finite(item.directionScore),
    confidence: finite(item.confidence),
    independentSourceGroups: Math.max(0, Number(item.independentSourceGroups || 0)),
    conflictRatio: finite(item.conflictRatio),
    rumorRatio: finite(item.rumorRatio),
    baselinePrice: anchorAllowed ? current.price : null,
    anchorAt: anchorAllowed ? current.at : null,
    anchorLagMinutes: anchorAllowed ? round(lagMinutes, 2) : null,
    outcomes: {},
    firstSeenAt: iso(nowMs)
  };
}

function mergeCaptureIntoState(targetState, input, nowMs = Date.now()) {
  const next = normalizeState(targetState);
  const priceMap = input?.priceMap instanceof Map ? input.priceMap : new Map();
  const alpacaAudit = Array.isArray(input?.alpacaAudit) ? input.alpacaAudit : [];
  const exaAudit = Array.isArray(input?.exaAudit) ? input.exaAudit : [];
  const existingPairs = new Set(next.alpacaPairs.map((item) => item.id));
  const existingEvents = new Map(next.exaEvents.map((item) => [item.id, item]));
  let alpacaAdded = 0;
  let exaAdded = 0;
  let anchored = 0;
  let outcomesAdded = 0;

  for (const raw of alpacaAudit) {
    const pair = alpacaPairFromAudit(raw);
    if (!pair || existingPairs.has(pair.id)) continue;
    next.alpacaPairs.push(pair);
    existingPairs.add(pair.id);
    alpacaAdded += 1;
  }

  for (const raw of exaAudit) {
    const candidate = exaEventFromAudit(raw, priceMap, nowMs);
    if (!candidate) continue;
    const existing = existingEvents.get(candidate.id);
    if (!existing) {
      next.exaEvents.push(candidate);
      existingEvents.set(candidate.id, candidate);
      exaAdded += 1;
      if (candidate.baselinePrice > 0) anchored += 1;
      continue;
    }
    if (!(existing.baselinePrice > 0)) {
      const current = priceMap.get(existing.symbol);
      const eventMs = Date.parse(existing.evaluatedAt);
      const priceMs = current?.at ? Date.parse(current.at) : NaN;
      const lagMinutes = Number.isFinite(eventMs) && Number.isFinite(priceMs) ? Math.abs(priceMs - eventMs) / 60_000 : null;
      if (current && lagMinutes != null && lagMinutes <= MAX_ANCHOR_LAG_MINUTES) {
        existing.baselinePrice = current.price;
        existing.anchorAt = current.at;
        existing.anchorLagMinutes = round(lagMinutes, 2);
        anchored += 1;
      }
    }
  }

  for (const event of next.exaEvents) {
    if (!(event.baselinePrice > 0) || !event.anchorAt) continue;
    const current = priceMap.get(event.symbol);
    if (!current || !(current.price > 0) || !current.at) continue;
    const ageHours = (Date.parse(current.at) - Date.parse(event.anchorAt)) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours < 0) continue;
    event.outcomes = event.outcomes || {};
    for (const [key, horizonHours] of Object.entries(HORIZONS_HOURS)) {
      if (event.outcomes[key] || ageHours < horizonHours) continue;
      const returnPct = ((current.price / event.baselinePrice) - 1) * 100;
      const direction = Math.sign(Number(event.directionScore || 0));
      const hit = direction === 0 ? null : Math.sign(returnPct) === direction;
      event.outcomes[key] = {
        evaluatedAt: current.at,
        horizonHours,
        price: round(current.price, 8),
        returnPct: round(returnPct, 5),
        directionalHit: hit,
        signedEdgePct: direction === 0 ? null : round(returnPct * direction, 5)
      };
      outcomesAdded += 1;
    }
  }

  next.alpacaPairs = next.alpacaPairs.slice(-MAX_ALPACA_PAIRS);
  next.exaEvents = next.exaEvents.slice(-MAX_EXA_EVENTS);
  next.stats.alpacaPairsAdded = Number(next.stats.alpacaPairsAdded || 0) + alpacaAdded;
  next.stats.exaEventsAdded = Number(next.stats.exaEventsAdded || 0) + exaAdded;
  next.stats.exaEventsAnchored = Number(next.stats.exaEventsAnchored || 0) + anchored;
  next.stats.exaOutcomesAdded = Number(next.stats.exaOutcomesAdded || 0) + outcomesAdded;
  next.updatedAt = iso(nowMs);
  return { state: next, delta: { alpacaAdded, exaAdded, anchored, outcomesAdded } };
}

function summarizeAlpaca(pairs) {
  const items = Array.isArray(pairs) ? pairs : [];
  const byStatus = {};
  const divergences = [];
  for (const item of items) {
    const status = String(item.status || 'INCONCLUSIVE').toUpperCase();
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (Number.isFinite(Number(item.priceDivergencePct))) divergences.push(Number(item.priceDivergencePct));
  }
  const total = items.length;
  const confirmed = byStatus.CONFIRMED || 0;
  const divergent = byStatus.DIVERGENT || 0;
  return {
    observations: total,
    byStatus,
    confirmedPct: total ? round(confirmed / total * 100, 2) : null,
    divergentPct: total ? round(divergent / total * 100, 2) : null,
    averagePriceDivergencePct: divergences.length ? round(divergences.reduce((a, b) => a + b, 0) / divergences.length, 5) : null
  };
}

function summarizeExa(events) {
  const items = Array.isArray(events) ? events : [];
  const result = {
    events: items.length,
    anchoredEvents: items.filter((event) => event.baselinePrice > 0).length,
    byStatus: {},
    horizons: {}
  };
  for (const event of items) {
    const status = String(event.status || 'INCONCLUSIVE').toUpperCase();
    result.byStatus[status] = (result.byStatus[status] || 0) + 1;
  }
  for (const key of Object.keys(HORIZONS_HOURS)) {
    const outcomes = items.map((event) => event.outcomes?.[key]).filter(Boolean);
    const directional = outcomes.filter((outcome) => typeof outcome.directionalHit === 'boolean');
    const edges = directional.map((outcome) => Number(outcome.signedEdgePct)).filter(Number.isFinite);
    const returns = outcomes.map((outcome) => Number(outcome.returnPct)).filter(Number.isFinite);
    result.horizons[key] = {
      outcomes: outcomes.length,
      directionalOutcomes: directional.length,
      hitRatePct: directional.length ? round(directional.filter((outcome) => outcome.directionalHit).length / directional.length * 100, 2) : null,
      averageSignedEdgePct: edges.length ? round(edges.reduce((a, b) => a + b, 0) / edges.length, 5) : null,
      averageRawReturnPct: returns.length ? round(returns.reduce((a, b) => a + b, 0) / returns.length, 5) : null
    };
  }
  return result;
}

function calibrationSummary(sourceState = state) {
  const normalized = normalizeState(sourceState);
  return {
    alpaca: summarizeAlpaca(normalized.alpacaPairs),
    exa: summarizeExa(normalized.exaEvents)
  };
}

async function capture(trigger = 'manual') {
  if (!ENABLED) return { ok: false, skipped: true, reason: 'DISABLED' };
  if (captureInProgress) return { ok: false, skipped: true, reason: 'CAPTURE_ALREADY_RUNNING' };
  captureInProgress = true;
  try {
    await loadState();
    const [shadow, alpaca, exa] = await Promise.all([
      safeSnapshot('__LEO_SHADOW_LAB_STATE__'),
      safeSnapshot('__LEO_ALPACA_VALIDATOR_STATE__'),
      safeSnapshot('__LEO_EXA_CATALYST_STATE__')
    ]);
    const priceMap = shadowPriceMap(shadow);
    const merged = mergeCaptureIntoState(state, {
      priceMap,
      alpacaAudit: alpaca?.recentAudit || [],
      exaAudit: exa?.recentAudit || []
    });
    state = merged.state;
    state.stats.captures = Number(state.stats.captures || 0) + 1;
    await saveState();
    const summary = calibrationSummary(state);
    log('CAPTURE_COMPLETED', {
      trigger,
      priceSymbols: priceMap.size,
      ...merged.delta,
      alpacaObservations: summary.alpaca.observations,
      exaEvents: summary.exa.events,
      exaAnchoredEvents: summary.exa.anchoredEvents,
      exaD1Outcomes: summary.exa.horizons.d1.outcomes,
      persistenceBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
      marketNetworkCalls: 0,
      executionCalls: 0,
      openAiCalls: 0
    });
    return { ok: true, delta: merged.delta, summary };
  } catch (error) {
    state.stats.captureFailures = Number(state.stats.captureFailures || 0) + 1;
    await saveState().catch(() => {});
    log('CAPTURE_FAILED', { trigger, error: sanitize(error?.message || error, 700) }, 'warn');
    return { ok: false, error: sanitize(error?.message || error, 700) };
  } finally {
    captureInProgress = false;
  }
}

async function stateSnapshot() {
  await loadState();
  return {
    version: VERSION,
    enabled: ENABLED,
    running: captureInProgress,
    intervalMinutes: INTERVAL_MINUTES,
    persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
    stats: { ...state.stats, marketNetworkCalls: 0, executionCalls: 0, openAiCalls: 0 },
    summary: calibrationSummary(state),
    lastEvent,
    safety: {
      researchOnly: true,
      canTrade: false,
      canAuthorizeLive: false,
      marketNetworkCalls: 0,
      persistenceNetworkOnly: HAS_UPSTASH,
      executionCalls: 0,
      openAiCalls: 0,
      automaticLivePromotion: false
    }
  };
}

global.__LEO_FOUNDATION_CALIBRATION_CAPTURE__ = capture;
global.__LEO_FOUNDATION_CALIBRATION_STATE__ = stateSnapshot;

if (ENABLED) {
  const startup = setTimeout(() => {
    capture('startup-delay').catch((error) => log('STARTUP_CAPTURE_UNHANDLED', { error: sanitize(error?.message || error, 500) }, 'warn'));
  }, STARTUP_DELAY_SECONDS * 1000);
  if (typeof startup.unref === 'function') startup.unref();

  interval = setInterval(() => {
    capture('interval').catch((error) => log('INTERVAL_CAPTURE_UNHANDLED', { error: sanitize(error?.message || error, 500) }, 'warn'));
  }, INTERVAL_MINUTES * 60_000);
  if (typeof interval.unref === 'function') interval.unref();
}

log('STARTED', {
  enabled: ENABLED,
  intervalMinutes: INTERVAL_MINUTES,
  startupDelaySeconds: STARTUP_DELAY_SECONDS,
  persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
  marketNetworkCalls: 0,
  executionCalls: 0,
  openAiCalls: 0,
  automaticLivePromotion: false
});

module.exports = {
  VERSION,
  HORIZONS_HOURS,
  alpacaPairFromAudit,
  exaEventFromAudit,
  shadowPriceMap,
  mergeCaptureIntoState,
  summarizeAlpaca,
  summarizeExa,
  calibrationSummary,
  capture,
  stateSnapshot,
  freshState
};
