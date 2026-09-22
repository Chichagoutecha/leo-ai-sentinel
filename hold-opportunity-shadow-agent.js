'use strict';

/**
 * LEO-AI SENTINEL v10.22.17.0 — HOLD Opportunity Shadow Agent.
 *
 * Purpose:
 * - Observe final HOLD decisions when the MultiAgentCouncil had one or more
 *   APPROVED_BUY candidates.
 * - Measure counterfactual market returns at +1h, +6h, +24h, +72h and +7d.
 * - Separate executable approved BUYs from candidates unavailable because their
 *   mapped UCITS venue was closed.
 * - Build evidence about whether final HOLD decisions avoid losses or miss gains.
 *
 * Governance contract:
 * - SHADOW ONLY: never changes a decision, risk threshold, council vote, sizing,
 *   order, schedule or portfolio state.
 * - Never creates, retries, cancels, blocks or delays a broker order.
 * - Never adds a market-data/provider request: mark-outs are learned only from
 *   eToro rate responses already requested by the existing runtime.
 * - Never promotes itself into LIVE enforcement.
 */
const crypto = require('crypto');
const CurrentOpenAI = require('openai');
const openAIPath = require.resolve('openai');

const VERSION = 'v10.22.17.0-hold-opportunity-shadow';
const COMPONENT = 'LEO_HOLD_OPPORTUNITY_SHADOW';
const MODE = 'shadow';
const ENABLED = process.env.HOLD_SHADOW_ENABLED !== 'false';
const RATES_PATH = '/api/v1/market-data/instruments/rates';
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const REDIS = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_PREFIX = String(process.env.HOLD_SHADOW_REDIS_PREFIX || 'leo:hold-shadow:v1');
const HISTORY_LIMIT = boundedNumber(process.env.HOLD_SHADOW_HISTORY_LIMIT, 500, 50, 2500, true);
const MIN_CALIBRATION_SAMPLES = boundedNumber(process.env.HOLD_SHADOW_MIN_CALIBRATION_SAMPLES, 10, 3, 200, true);
const QUOTE_MAX_STALENESS_MINUTES = boundedNumber(process.env.HOLD_SHADOW_QUOTE_MAX_STALENESS_MINUTES, 35, 5, 240);
const MARKOUT_HOURS = Object.freeze([1, 6, 24, 72, 168]);
const NEAR_HORIZON_TOLERANCE_HOURS = Object.freeze({ 1: 1, 6: 2, 24: 8, 72: 12, 168: 24 });

const GOVERNANCE = Object.freeze({
  analysisOnly: true,
  shadowOnly: true,
  canPlaceOrder: false,
  canBlockOrder: false,
  canModifyOrder: false,
  canModifyDecision: false,
  canModifySizing: false,
  canModifyCouncilVote: false,
  canChangeRiskThresholds: false,
  canChangeSchedule: false,
  canPromoteLive: false,
  canPromoteAutomatically: false,
  providerCallsAdded: 0,
  originatesOrders: false
});

let state = freshState();
let loaded = false;
let loadPromise = null;
let saveTimer = null;
let installedAgent = null;
const pendingTasks = new Set();
const latestRates = new Map();

function boundedNumber(value, fallback, min, max, integer = false) {
  const n = Number(value);
  const result = Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  return integer ? Math.round(result) : result;
}
function round(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}
function iso() { return new Date().toISOString(); }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function median(values) {
  const a = values.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}
function mean(values) {
  const a = values.map(Number).filter(Number.isFinite);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}
function freshState() {
  return {
    version: VERSION,
    mode: MODE,
    createdAt: iso(),
    updatedAt: iso(),
    opportunities: [],
    counters: {
      holdDecisionsObserved: 0,
      opportunitiesObserved: 0,
      executableApprovedBuysHeld: 0,
      unavailableApprovedBuysHeld: 0,
      markoutsRecorded: 0,
      lateMarkoutsRecorded: 0,
      entryPriceMissing: 0
    },
    lastEvent: null
  };
}
function normalizeState(value) {
  const base = freshState();
  if (!isObject(value)) return base;
  return {
    ...base,
    ...value,
    version: VERSION,
    mode: MODE,
    opportunities: Array.isArray(value.opportunities) ? value.opportunities.slice(-HISTORY_LIMIT) : [],
    counters: { ...base.counters, ...(value.counters || {}) }
  };
}
function numberField(object, names) {
  if (!isObject(object)) return null;
  for (const name of names) {
    const value = Number(object[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}
function stringField(object, names) {
  if (!isObject(object)) return null;
  for (const name of names) if (object[name] != null) return String(object[name]);
  return null;
}
function collectObjects(value, out = [], seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 10) return out;
  seen.add(value);
  if (!Array.isArray(value)) out.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (child && typeof child === 'object') collectObjects(child, out, seen, depth + 1);
  }
  return out;
}
function instrumentIdOf(object) {
  return numberField(object, ['instrumentId', 'instrumentID', 'InstrumentId', 'InstrumentID']);
}
function quoteTimestamp(rate) {
  const raw = stringField(rate, [
    'date', 'Date', 'timestamp', 'Timestamp', 'lastUpdate', 'LastUpdate',
    'lastExecutionTime', 'LastExecutionTime', 'updatedAt', 'UpdatedAt'
  ]);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}
function rateSnapshot(object) {
  if (!isObject(object)) return null;
  const instrumentId = instrumentIdOf(object);
  if (!Number.isFinite(instrumentId) || instrumentId <= 0) return null;
  const bid = numberField(object, ['bid', 'Bid', 'BID']);
  const ask = numberField(object, ['ask', 'Ask', 'ASK']);
  const last = numberField(object, ['lastExecution', 'LastExecution', 'last', 'Last', 'price', 'Price']);
  const mid = Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0
    ? (bid + ask) / 2
    : Number.isFinite(last) && last > 0
      ? last
      : Number.isFinite(bid) && bid > 0
        ? bid
        : Number.isFinite(ask) && ask > 0 ? ask : null;
  if (!Number.isFinite(mid) || mid <= 0) return null;
  return { instrumentId, bid, ask, last, mid, timestamp: quoteTimestamp(object) };
}
function ingestLatestRates(data, observedAt = new Date()) {
  let count = 0;
  for (const object of collectObjects(data)) {
    const rate = rateSnapshot(object);
    if (!rate) continue;
    latestRates.set(rate.instrumentId, { ...rate, observedAt: observedAt.toISOString() });
    count += 1;
  }
  return count;
}
function parseDecisionPayload(message) {
  if (!message || message.role !== 'user' || typeof message.content !== 'string') return null;
  try {
    const payload = JSON.parse(message.content);
    return payload && payload.trading_mode && payload.portfolio_summary && payload.market_data_summary && payload.foundation_agents
      ? payload
      : null;
  } catch { return null; }
}
function extractDecision(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    try { return JSON.parse(content); } catch {}
  }
  return isObject(response?.choices?.[0]?.message?.parsed) ? response.choices[0].message.parsed : null;
}
function approvedBuyAssetsFromCouncil(council) {
  const explicit = Array.isArray(council?.approvedBuyAssets) ? council.approvedBuyAssets : [];
  if (explicit.length) return [...new Set(explicit.map((x) => String(x).toUpperCase()))];
  if (!isObject(council?.assets)) return [];
  return Object.entries(council.assets)
    .filter(([, report]) => {
      const status = String(report?.status || '').toUpperCase();
      const recommendation = String(report?.recommendation || '').toUpperCase();
      return status === 'APPROVED_BUY' || recommendation === 'BUY';
    })
    .map(([asset]) => String(asset).toUpperCase());
}
function awarenessForDecision(payload) {
  try {
    const runtime = typeof global.__LEO_EXECUTION_AWARE_DECISION_STATE__ === 'function'
      ? global.__LEO_EXECUTION_AWARE_DECISION_STATE__()
      : null;
    const d = runtime?.lastDiagnostics;
    if (d && Array.isArray(d.approvedBuyAssets)) {
      return {
        approvedBuyAssets: d.approvedBuyAssets.map((x) => String(x).toUpperCase()),
        executableNow: Array.isArray(d.approvedBuyExecutableNow) ? d.approvedBuyExecutableNow.map((x) => String(x).toUpperCase()) : [],
        unavailableNow: Array.isArray(d.approvedBuyUnavailableNow) ? d.approvedBuyUnavailableNow.map((x) => String(x).toUpperCase()) : [],
        mappedAssets: isObject(d.executionAwareness?.mappedAssets) ? d.executionAwareness.mappedAssets : {}
      };
    }
  } catch {}
  const council = payload?.agent_council || payload?.foundation_agents?.agentCouncil || {};
  return { approvedBuyAssets: approvedBuyAssetsFromCouncil(council), executableNow: [], unavailableNow: [], mappedAssets: {} };
}
function assetNode(payload, asset) {
  const direct = payload?.market_data_summary?.assets?.[asset];
  if (isObject(direct)) return direct;
  for (const object of collectObjects(payload?.market_data_summary)) {
    const symbol = String(object.asset || object.symbol || object.ticker || '').toUpperCase();
    if (symbol === asset) return object;
  }
  return null;
}
function instrumentIdFor(payload, asset, node) {
  const watchValue = payload?.watchlist?.[asset];
  if (Number.isFinite(Number(watchValue))) return Number(watchValue);
  const fromNode = instrumentIdOf(node);
  return Number.isFinite(fromNode) ? fromNode : null;
}
function priceFromNode(node) {
  if (!isObject(node)) return null;
  const bid = numberField(node, ['bid', 'Bid']);
  const ask = numberField(node, ['ask', 'Ask']);
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) return (bid + ask) / 2;
  const direct = numberField(node, ['mid', 'price', 'last', 'lastExecution', 'close', 'rate']);
  if (Number.isFinite(direct) && direct > 0) return direct;
  for (const object of collectObjects(node)) {
    if (object === node) continue;
    const nested = numberField(object, ['mid', 'price', 'last', 'lastExecution', 'close', 'rate']);
    if (Number.isFinite(nested) && nested > 0) return nested;
  }
  return null;
}
function compactCouncilReport(report) {
  if (!isObject(report)) return null;
  const safe = {};
  for (const key of ['status','recommendation','supportPct','oppositionPct','disagreementPct','participationCount','buyVotes','sellVotes','holdVotes','reasons']) {
    if (report[key] !== undefined) safe[key] = report[key];
  }
  if (Array.isArray(report.hardVetoes)) safe.hardVetoCount = report.hardVetoes.length;
  return safe;
}
function decisionTimestamp(payload) {
  const d = new Date(payload?.time || payload?.generatedAt || Date.now());
  return Number.isFinite(d.getTime()) ? d : new Date();
}
function decisionAction(decision) {
  return String(decision?.action || decision?.decision || 'UNKNOWN').toUpperCase();
}
function opportunityId(payload, decision, asset) {
  const seed = `${payload?.source || 'unknown'}|${payload?.time || ''}|${decisionAction(decision)}|${asset}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}
function buildOpportunity(payload, decision, asset, awareness, now = new Date()) {
  const node = assetNode(payload, asset);
  const instrumentId = instrumentIdFor(payload, asset, node);
  const cached = Number.isFinite(instrumentId) ? latestRates.get(instrumentId) : null;
  const payloadPrice = priceFromNode(node);
  const entryMid = Number.isFinite(payloadPrice) && payloadPrice > 0
    ? payloadPrice
    : Number.isFinite(cached?.mid) && cached.mid > 0 ? cached.mid : null;
  const executable = awareness.executableNow.includes(asset);
  const unavailable = awareness.unavailableNow.includes(asset);
  const council = payload?.agent_council || payload?.foundation_agents?.agentCouncil || {};
  const report = isObject(council?.assets?.[asset]) ? council.assets[asset] : null;
  const at = decisionTimestamp(payload);
  return {
    id: opportunityId(payload, decision, asset),
    observedAt: now.toISOString(),
    decisionAt: at.toISOString(),
    source: String(payload?.source || 'unknown'),
    asset,
    analysisInstrumentId: instrumentId,
    entryMid: round(entryMid, 8),
    entryPriceSource: Number.isFinite(payloadPrice) && payloadPrice > 0 ? 'DECISION_PAYLOAD' : Number.isFinite(cached?.mid) ? 'RECENT_EXISTING_ETORO_RATE' : 'UNAVAILABLE',
    cohort: executable ? 'EXECUTABLE_APPROVED_BUY_HELD' : unavailable ? 'VENUE_UNAVAILABLE_APPROVED_BUY_HELD' : 'APPROVED_BUY_HELD_EXECUTION_UNKNOWN',
    executableAtDecision: executable ? true : unavailable ? false : null,
    finalDecision: {
      action: 'HOLD',
      confidence: Number.isFinite(Number(decision?.confidence)) ? Number(decision.confidence) : null,
      reason: decision?.reason ? String(decision.reason).slice(0, 1200) : null
    },
    council: compactCouncilReport(report),
    markouts: {},
    governance: GOVERNANCE
  };
}
function log(event, details = {}, level = 'log') {
  const record = { component: COMPONENT, version: VERSION, event, at: iso(), mode: MODE, ...details };
  state.lastEvent = record;
  global.__LEO_HOLD_SHADOW_LAST_EVENT__ = record;
  (console[level] || console.log)(`[LEO_HOLD_SHADOW] ${JSON.stringify(record)}`);
}
function redisKey() { return `${REDIS_PREFIX}:state`; }
async function redis(baseFetch, command) {
  if (!REDIS) return null;
  const response = await baseFetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`UPSTASH_HTTP_${response.status}`);
  const data = await response.json();
  if (data?.error) throw new Error('UPSTASH_COMMAND_ERROR');
  return data?.result ?? null;
}
async function loadState(baseFetch) {
  if (loaded) return state;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      if (REDIS) {
        const raw = await redis(baseFetch, ['GET', redisKey()]);
        state = raw ? normalizeState(JSON.parse(raw)) : freshState();
      }
    } catch (error) {
      log('STORE_READ_FALLBACK', { error: String(error?.message || error).slice(0, 160) }, 'warn');
    }
    loaded = true;
    return state;
  })();
  try { return await loadPromise; } finally { loadPromise = null; }
}
function scheduleSave(baseFetch) {
  state.updatedAt = iso();
  if (!REDIS || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await redis(baseFetch, ['SET', redisKey(), JSON.stringify(state)]); }
    catch (error) { log('STORE_WRITE_FALLBACK', { error: String(error?.message || error).slice(0, 160) }, 'warn'); }
  }, 250);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}
function trackTask(promise) {
  const task = Promise.resolve(promise).catch(() => null);
  pendingTasks.add(task);
  task.finally(() => pendingTasks.delete(task));
  return task;
}
async function drainPendingTasks() { await Promise.allSettled([...pendingTasks]); }
async function recordHoldOpportunities(payload, decision, baseFetch, now = new Date()) {
  if (!ENABLED || decisionAction(decision) !== 'HOLD') return [];
  const awareness = awarenessForDecision(payload);
  if (!awareness.approvedBuyAssets.length) return [];
  await loadState(baseFetch);
  state.counters.holdDecisionsObserved += 1;
  const added = [];
  for (const asset of awareness.approvedBuyAssets) {
    const opportunity = buildOpportunity(payload, decision, asset, awareness, now);
    if (state.opportunities.some((item) => item.id === opportunity.id)) continue;
    state.opportunities.push(opportunity);
    if (state.opportunities.length > HISTORY_LIMIT) state.opportunities = state.opportunities.slice(-HISTORY_LIMIT);
    state.counters.opportunitiesObserved += 1;
    if (opportunity.cohort === 'EXECUTABLE_APPROVED_BUY_HELD') state.counters.executableApprovedBuysHeld += 1;
    if (opportunity.cohort === 'VENUE_UNAVAILABLE_APPROVED_BUY_HELD') state.counters.unavailableApprovedBuysHeld += 1;
    if (!Number.isFinite(opportunity.entryMid)) state.counters.entryPriceMissing += 1;
    added.push(opportunity);
    log('HOLD_OPPORTUNITY_OBSERVED', {
      opportunityId: opportunity.id,
      asset,
      cohort: opportunity.cohort,
      executableAtDecision: opportunity.executableAtDecision,
      entryPriceAvailable: Number.isFinite(opportunity.entryMid),
      confidence: opportunity.finalDecision.confidence
    });
  }
  if (added.length) scheduleSave(baseFetch);
  return added;
}
function markoutToleranceHours(horizon) {
  return Number(NEAR_HORIZON_TOLERANCE_HOURS[horizon] || Math.max(1, horizon / 4));
}
function updateMarkoutsFromRates(data, baseFetch, now = new Date()) {
  ingestLatestRates(data, now);
  let changed = false;
  for (const opportunity of state.opportunities) {
    if (!Number.isFinite(Number(opportunity.entryMid)) || !Number.isFinite(Number(opportunity.analysisInstrumentId))) continue;
    const rate = latestRates.get(Number(opportunity.analysisInstrumentId));
    if (!rate?.timestamp || !Number.isFinite(rate.mid)) continue;
    const quoteMs = rate.timestamp.getTime();
    const nowMs = now.getTime();
    if (!Number.isFinite(quoteMs) || nowMs - quoteMs > QUOTE_MAX_STALENESS_MINUTES * 60000) continue;
    const decisionMs = new Date(opportunity.decisionAt).getTime();
    if (!Number.isFinite(decisionMs)) continue;
    opportunity.markouts = opportunity.markouts || {};
    for (const horizon of MARKOUT_HOURS) {
      const key = `h${horizon}`;
      if (opportunity.markouts[key]) continue;
      const targetMs = decisionMs + horizon * 3600000;
      if (quoteMs < targetMs) continue;
      const latenessHours = (quoteMs - targetMs) / 3600000;
      const nearHorizon = latenessHours <= markoutToleranceHours(horizon);
      opportunity.markouts[key] = {
        recordedAt: now.toISOString(),
        quoteAt: rate.timestamp.toISOString(),
        targetAt: new Date(targetMs).toISOString(),
        elapsedHours: round((quoteMs - decisionMs) / 3600000, 3),
        latenessHours: round(latenessHours, 3),
        nearHorizon,
        marketMid: round(rate.mid, 8),
        grossReturnPct: round(((rate.mid / Number(opportunity.entryMid)) - 1) * 100)
      };
      state.counters.markoutsRecorded += 1;
      if (!nearHorizon) state.counters.lateMarkoutsRecorded += 1;
      changed = true;
    }
  }
  if (changed) scheduleSave(baseFetch);
  return changed;
}
function horizonStats(rows, horizon, nearOnly = true) {
  const key = `h${horizon}`;
  const marks = rows.map((o) => o.markouts?.[key]).filter((m) => m && (!nearOnly || m.nearHorizon));
  const returns = marks.map((m) => Number(m.grossReturnPct)).filter(Number.isFinite);
  const positive = returns.filter((x) => x > 0).length;
  const negative = returns.filter((x) => x < 0).length;
  return {
    horizonHours: horizon,
    samples: returns.length,
    positive: positive,
    negative: negative,
    flat: returns.length - positive - negative,
    positiveRatePct: returns.length ? round((positive / returns.length) * 100, 2) : null,
    medianGrossReturnPct: round(median(returns)),
    meanGrossReturnPct: round(mean(returns))
  };
}
function calibrationSummary() {
  const executable = state.opportunities.filter((o) => o.cohort === 'EXECUTABLE_APPROVED_BUY_HELD');
  const unavailable = state.opportunities.filter((o) => o.cohort === 'VENUE_UNAVAILABLE_APPROVED_BUY_HELD');
  const assets = [...new Set(state.opportunities.map((o) => o.asset))].sort();
  const h24 = horizonStats(executable, 24, true);
  let interpretation24h = 'INSUFFICIENT_SAMPLES';
  if (h24.samples >= MIN_CALIBRATION_SAMPLES) {
    if (Number(h24.medianGrossReturnPct) > 0) interpretation24h = 'FINAL_HOLD_MEDIAN_MISSED_POSITIVE_RETURN';
    else if (Number(h24.medianGrossReturnPct) < 0) interpretation24h = 'FINAL_HOLD_MEDIAN_AVOIDED_NEGATIVE_RETURN';
    else interpretation24h = 'FINAL_HOLD_MEDIAN_FLAT';
  }
  return {
    generatedAt: iso(),
    minimumSamples: MIN_CALIBRATION_SAMPLES,
    ready: h24.samples >= MIN_CALIBRATION_SAMPLES,
    executableApprovedBuyHeld: {
      observations: executable.length,
      h1: horizonStats(executable, 1, true),
      h6: horizonStats(executable, 6, true),
      h24,
      h72: horizonStats(executable, 72, true),
      h168: horizonStats(executable, 168, true),
      interpretation24h
    },
    venueUnavailableApprovedBuyHeld: {
      observations: unavailable.length,
      h24: horizonStats(unavailable, 24, true),
      h168: horizonStats(unavailable, 168, true)
    },
    byAsset: assets.map((asset) => {
      const rows = executable.filter((o) => o.asset === asset);
      return { asset, observations: rows.length, h24: horizonStats(rows, 24, true), h168: horizonStats(rows, 168, true) };
    }),
    methodology: {
      counterfactualOnly: true,
      usesOnlyAlreadyRequestedEtoroRates: true,
      nearHorizonOnlyInCalibration: true,
      quoteMaxStalenessMinutes: QUOTE_MAX_STALENESS_MINUTES,
      noTransactionCostsAppliedYet: true,
      noLiveInfluence: true
    },
    governance: GOVERNANCE
  };
}
function statusPayload() {
  return {
    version: VERSION,
    enabled: ENABLED,
    mode: MODE,
    persistent: REDIS,
    counts: { ...state.counters, opportunities: state.opportunities.length },
    calibration: calibrationSummary(),
    lastOpportunity: state.opportunities.length ? state.opportunities[state.opportunities.length - 1] : null,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
    governance: GOVERNANCE
  };
}
function safeUrl(input) {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input && typeof input.url === 'string') return new URL(input.url);
  } catch {}
  return null;
}
function requestMethod(input, init) { return String(init?.method || input?.method || 'GET').toUpperCase(); }
function installExpressRoutes() {
  let express;
  try { express = require('express'); } catch { return false; }
  const proto = express?.application;
  if (!proto || proto.__leoHoldShadowListenPatched) return Boolean(proto);
  const originalListen = proto.listen;
  proto.listen = function leoHoldShadowListen(...args) {
    if (!this.__leoHoldShadowRoutesInstalled) {
      this.__leoHoldShadowRoutesInstalled = true;
      this.get('/hold-shadow-status', async (_req, res) => {
        try { await loadState(installedAgent?.baseFetch || global.fetch); res.json(statusPayload()); }
        catch { res.status(500).json({ ok: false, error: 'HOLD_SHADOW_STATUS_FAILED' }); }
      });
      this.get('/hold-shadow-history', async (_req, res) => {
        try { await loadState(installedAgent?.baseFetch || global.fetch); res.json({ version: VERSION, mode: MODE, governance: GOVERNANCE, opportunities: state.opportunities.slice(-150) }); }
        catch { res.status(500).json({ ok: false, error: 'HOLD_SHADOW_HISTORY_FAILED' }); }
      });
      this.get('/hold-shadow-calibration', async (_req, res) => {
        try { await loadState(installedAgent?.baseFetch || global.fetch); res.json(calibrationSummary()); }
        catch { res.status(500).json({ ok: false, error: 'HOLD_SHADOW_CALIBRATION_FAILED' }); }
      });
    }
    return originalListen.apply(this, args);
  };
  proto.__leoHoldShadowListenPatched = true;
  return true;
}
function installFetchObserver(options = {}) {
  const baseFetch = options.fetch || global.fetch;
  if (typeof baseFetch !== 'function') return { installed: false, reason: 'FETCH_UNAVAILABLE', version: VERSION };
  if (options.installRoutes !== false) installExpressRoutes();
  async function wrappedFetch(input, init = {}) {
    const response = await baseFetch(input, init);
    const url = safeUrl(input);
    if (ENABLED && url?.origin === 'https://public-api.etoro.com' && requestMethod(input, init) === 'GET' && url.pathname === RATES_PATH && response?.ok) {
      trackTask(response.clone().json().then(async (data) => {
        await loadState(baseFetch);
        updateMarkoutsFromRates(data, baseFetch, new Date());
      }).catch(() => null));
    }
    return response;
  }
  if (!options.fetch) global.fetch = wrappedFetch;
  installedAgent = { installed: true, version: VERSION, mode: MODE, baseFetch, fetch: wrappedFetch, governance: GOVERNANCE };
  loadState(baseFetch).catch(() => {});
  return installedAgent;
}

class HoldShadowOpenAI extends CurrentOpenAI {
  constructor(options) {
    super(options);
    if (!this.chat?.completions?.create) return;
    const create = this.chat.completions.create.bind(this.chat.completions);
    this.chat.completions.create = async (params, requestOptions) => {
      let payload = null;
      if (ENABLED && Array.isArray(params?.messages)) {
        for (let i = params.messages.length - 1; i >= 0; i -= 1) {
          payload = parseDecisionPayload(params.messages[i]);
          if (payload) break;
        }
      }
      const response = await create(params, requestOptions);
      if (payload) {
        const decision = extractDecision(response);
        if (decision && decisionAction(decision) === 'HOLD') {
          // Never delay the production decision path for shadow persistence/calibration.
          trackTask(recordHoldOpportunities(payload, decision, installedAgent?.baseFetch || global.fetch, new Date()).catch((error) => {
            log('HOLD_SHADOW_OBSERVATION_FAILED_OPEN', { error: String(error?.message || error).slice(0, 160) }, 'warn');
            return [];
          }));
        }
      }
      return response;
    };
  }
}
for (const key of Reflect.ownKeys(CurrentOpenAI)) {
  if (['length','name','prototype'].includes(String(key))) continue;
  try { const d = Object.getOwnPropertyDescriptor(CurrentOpenAI, key); if (d) Object.defineProperty(HoldShadowOpenAI, key, d); } catch {}
}
HoldShadowOpenAI.OpenAI = HoldShadowOpenAI;
HoldShadowOpenAI.default = HoldShadowOpenAI;
if (require.cache[openAIPath]) require.cache[openAIPath].exports = HoldShadowOpenAI;

const autoInstalled = process.env.HOLD_SHADOW_AUTO_INSTALL === 'false' ? null : installFetchObserver();
global.__LEO_HOLD_OPPORTUNITY_SHADOW_STATE__ = () => statusPayload();

log('STARTED', {
  enabled: ENABLED,
  persistent: REDIS,
  markoutHours: MARKOUT_HOURS,
  endpoints: ['/hold-shadow-status','/hold-shadow-history','/hold-shadow-calibration'],
  providerCallsAdded: 0,
  governance: GOVERNANCE,
  secretsLogged: false
});

module.exports = {
  decisionAction,
  VERSION, GOVERNANCE, MARKOUT_HOURS, NEAR_HORIZON_TOLERANCE_HOURS,
  parseDecisionPayload, extractDecision, approvedBuyAssetsFromCouncil,
  buildOpportunity, recordHoldOpportunities, ingestLatestRates, updateMarkoutsFromRates,
  horizonStats, calibrationSummary, statusPayload, installFetchObserver, autoInstalled,
  _test: {
    freshState,
    normalizeState,
    getState: () => state,
    setState: (next) => { state = normalizeState(next); loaded = true; },
    resetState: () => { state = freshState(); loaded = true; latestRates.clear(); },
    latestRates,
    drainPendingTasks
  }
};
