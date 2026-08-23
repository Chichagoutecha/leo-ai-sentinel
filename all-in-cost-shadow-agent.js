'use strict';

/**
 * LEO-AI SENTINEL — All-In Cost Shadow Agent.
 *
 * Purpose:
 * - Observe already-authorized LIVE BUY attempts without changing them.
 * - Estimate the economic friction of entering and later exiting a position.
 * - Accumulate empirical mark-outs so gross edge can be calibrated from LEO's own
 *   decisions instead of inventing a return from confidence scores.
 * - Expose read-only status/history/calibration endpoints.
 *
 * Governance contract:
 * - SHADOW ONLY: never blocks, delays intentionally, rewrites, sizes, originates,
 *   cancels, retries, or promotes an order.
 * - Any failure in this module fails open for the existing LIVE path: the original
 *   fetch is executed unchanged.
 * - Unknown fee components remain explicitly unresolved; they are never silently
 *   assumed away in the all-in estimate.
 */

const crypto = require('crypto');

const VERSION = 'v10.22.13.0-all-in-cost-shadow';
const COMPONENT = 'LEO_ALL_IN_COST_SHADOW';
const ENABLED = process.env.COST_SHADOW_ENABLED !== 'false';
const MODE = 'shadow';
const REAL_ORDER_URL = 'https://public-api.etoro.com/api/v2/trading/execution/orders';
const REAL_PNL_PATH = '/api/v1/trading/info/real/pnl';
const SEARCH_URL = 'https://public-api.etoro.com/api/v1/market-data/search';
const RATES_PATH = '/api/v1/market-data/instruments/rates';
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const REDIS = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_PREFIX = String(process.env.COST_SHADOW_REDIS_PREFIX || 'leo:cost-shadow:v1');
const HISTORY_LIMIT = boundedNumber(process.env.COST_SHADOW_HISTORY_LIMIT, 200, 20, 1000, true);
const SLIPPAGE_BPS_PER_SIDE = boundedNumber(process.env.COST_SHADOW_SLIPPAGE_BPS_PER_SIDE, 5, 0, 100);
const HOLDING_DAYS = boundedNumber(process.env.COST_SHADOW_EXPECTED_HOLDING_DAYS, 30, 1, 365);
const MIN_NET_EDGE_PCT = boundedNumber(process.env.COST_SHADOW_MIN_NET_EDGE_PCT, 0.30, 0, 20);
const MIN_COST_COVERAGE_RATIO = boundedNumber(process.env.COST_SHADOW_MIN_COST_COVERAGE_RATIO, 2.0, 0.1, 20);
const MIN_CALIBRATION_SAMPLES = boundedNumber(process.env.COST_SHADOW_MIN_CALIBRATION_SAMPLES, 10, 3, 200, true);
const CRYPTO_FEE_PER_SIDE = optionalBoundedNumber(process.env.COST_SHADOW_CRYPTO_FEE_PCT_PER_SIDE, 0, 20);
const DIRECT_FEE_PER_SIDE = optionalBoundedNumber(process.env.COST_SHADOW_DIRECT_FEE_PCT_PER_SIDE, 0, 20);
const FX_FEE_PER_SIDE = optionalBoundedNumber(process.env.COST_SHADOW_FX_PCT_PER_SIDE, 0, 10);
const RENDER_MONTHLY_USD = boundedNumber(process.env.COST_SHADOW_RENDER_MONTHLY_USD, 0, 0, 10000);
const DATA_MONTHLY_USD = boundedNumber(process.env.COST_SHADOW_DATA_MONTHLY_USD, 0, 0, 10000);
const MARKOUT_HOURS = Object.freeze([1, 6, 24, 72]);

const GOVERNANCE = Object.freeze({
  analysisOnly: true,
  shadowOnly: true,
  canPlaceOrder: false,
  canBlockOrder: false,
  canModifyOrder: false,
  canModifyDecision: false,
  canModifySizing: false,
  canPromoteLive: false,
  canPromoteAutomatically: false,
  liveDecisionModified: false,
  orderModified: false,
  sizingModified: false,
  originatesOrders: false
});

const UCITS = Object.freeze({
  3417: Object.freeze({ analysisAsset: 'SPY', executionSymbol: 'CSPX.L', executionCurrency: 'USD', annualExpenseRatioPct: 0.07, brokerFeePctPerSide: 0 }),
  3418: Object.freeze({ analysisAsset: 'QQQ', executionSymbol: 'CNDX.L', executionCurrency: 'USD', annualExpenseRatioPct: 0.30, brokerFeePctPerSide: 0 }),
  15634: Object.freeze({ analysisAsset: 'GLD', executionSymbol: 'IGLN.L', executionCurrency: 'USD', annualExpenseRatioPct: 0.12, brokerFeePctPerSide: 0 }),
  3100: Object.freeze({ analysisAsset: 'SHY', executionSymbol: 'IBTA.L', executionCurrency: 'USD', annualExpenseRatioPct: 0.07, brokerFeePctPerSide: 0 }),
  3020: Object.freeze({ analysisAsset: 'TLT', executionSymbol: 'DTLA.L', executionCurrency: 'USD', annualExpenseRatioPct: 0.07, brokerFeePctPerSide: 0 }),
  3017: Object.freeze({ analysisAsset: 'XLV', executionSymbol: 'ZPDH.DE', executionCurrency: 'EUR', annualExpenseRatioPct: 0.15, brokerFeePctPerSide: 0 }),
  3022: Object.freeze({ analysisAsset: 'XLP', executionSymbol: 'XDWS.DE', executionCurrency: 'EUR', annualExpenseRatioPct: 0.25, brokerFeePctPerSide: 0 }),
  3008: Object.freeze({ analysisAsset: 'XLE', executionSymbol: 'ZPDE.DE', executionCurrency: 'EUR', annualExpenseRatioPct: 0.15, brokerFeePctPerSide: 0 })
});

const CRYPTO_BY_ID = Object.freeze({ 100109: 'BTC', 100001: 'ETH', 100063: 'SOL' });

let state = freshState();
let loaded = false;
let loadPromise = null;
let saveTimer = null;
let installedAgent = null;
const pendingTasks = new Set();

function iso() { return new Date().toISOString(); }
function boundedNumber(value, fallback, min, max, integer = false) {
  const parsed = Number(value);
  const result = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  return integer ? Math.round(result) : result;
}
function optionalBoundedNumber(value, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : null;
}
function round(value, digits = 6) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}
function median(values) {
  const a = values.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function freshState() {
  return {
    version: VERSION,
    mode: MODE,
    createdAt: iso(),
    updatedAt: iso(),
    observations: [],
    lastEvent: null,
    counters: { buyAttemptsObserved: 0, orderHttpSuccess: 0, orderHttpFailure: 0, quoteFailures: 0, markoutsRecorded: 0 }
  };
}
function normalizeState(value) {
  const base = freshState();
  if (!value || typeof value !== 'object') return base;
  return {
    ...base,
    ...value,
    version: VERSION,
    mode: MODE,
    observations: Array.isArray(value.observations) ? value.observations.slice(-HISTORY_LIMIT) : [],
    counters: { ...base.counters, ...(value.counters || {}) }
  };
}
function safeUrl(input) {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input && typeof input.url === 'string') return new URL(input.url);
  } catch {}
  return null;
}
function methodOf(input, init) { return String(init?.method || input?.method || 'GET').toUpperCase(); }
function bodyObject(init) {
  if (!init || init.body == null) return null;
  const text = typeof init.body === 'string' ? init.body : Buffer.isBuffer(init.body) ? init.body.toString('utf8') : null;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
function numberField(object, names) {
  if (!object || typeof object !== 'object') return null;
  for (const name of names) {
    const value = Number(object[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}
function stringField(object, names) {
  if (!object || typeof object !== 'object') return null;
  for (const name of names) if (object[name] != null) return String(object[name]);
  return null;
}
function instrumentIdOf(object) { return numberField(object, ['instrumentId', 'instrumentID', 'InstrumentId', 'InstrumentID']); }
function symbolOf(object) { return stringField(object, ['internalSymbolFull', 'InternalSymbolFull', 'symbol', 'Symbol']); }
function collectObjects(value, out = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (!Array.isArray(value)) out.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) if (child && typeof child === 'object') collectObjects(child, out, seen);
  return out;
}
function exactInstrumentMatch(data, symbol) {
  const wanted = String(symbol || '').trim().toUpperCase();
  const ids = collectObjects(data)
    .filter((item) => String(symbolOf(item) || '').trim().toUpperCase() === wanted)
    .map(instrumentIdOf)
    .filter((id) => Number.isFinite(id) && id > 0);
  const unique = [...new Set(ids)];
  return unique.length === 1 ? unique[0] : null;
}
function exactRate(data, instrumentId) {
  const target = Number(instrumentId);
  for (const item of collectObjects(data)) {
    if (instrumentIdOf(item) !== target) continue;
    const bid = numberField(item, ['bid', 'Bid', 'BID']);
    const ask = numberField(item, ['ask', 'Ask', 'ASK']);
    const last = numberField(item, ['lastExecution', 'LastExecution', 'last', 'Last', 'price', 'Price']);
    const mid = Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0
      ? (bid + ask) / 2
      : Number.isFinite(last) && last > 0 ? last : Number.isFinite(bid) && bid > 0 ? bid : Number.isFinite(ask) && ask > 0 ? ask : null;
    if (!Number.isFinite(mid) || mid <= 0) continue;
    return { bid, ask, last, mid };
  }
  return null;
}
function assetDescriptor(analysisInstrumentId) {
  const id = Number(analysisInstrumentId);
  if (UCITS[id]) return { analysisInstrumentId: id, asset: UCITS[id].analysisAsset, assetClass: 'UCITS_ETF_ETC', ...UCITS[id] };
  if (CRYPTO_BY_ID[id]) return { analysisInstrumentId: id, asset: CRYPTO_BY_ID[id], assetClass: 'CRYPTO', executionSymbol: CRYPTO_BY_ID[id], executionCurrency: 'USD', annualExpenseRatioPct: 0, brokerFeePctPerSide: CRYPTO_FEE_PER_SIDE };
  return { analysisInstrumentId: id, asset: `INSTRUMENT_${id}`, assetClass: 'DIRECT_ASSET_UNCALIBRATED', executionSymbol: null, executionCurrency: 'USD', annualExpenseRatioPct: 0, brokerFeePctPerSide: DIRECT_FEE_PER_SIDE };
}
function buildCostEstimate({ descriptor, executionRate, holdingDays = HOLDING_DAYS, empiricalGrossEdgePct = null }) {
  const unresolved = [];
  const bid = Number(executionRate?.bid);
  const ask = Number(executionRate?.ask);
  let spreadPct = null;
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
    const mid = (bid + ask) / 2;
    spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : null;
  } else unresolved.push('EXECUTION_SPREAD');

  const slippagePctRoundTrip = (2 * SLIPPAGE_BPS_PER_SIDE) / 100;
  const brokerFeePctPerSide = descriptor?.brokerFeePctPerSide;
  const brokerFeePctRoundTrip = brokerFeePctPerSide !== null && brokerFeePctPerSide !== undefined && Number.isFinite(Number(brokerFeePctPerSide))
    ? Number(brokerFeePctPerSide) * 2
    : null;
  if (brokerFeePctRoundTrip === null) unresolved.push('BROKER_TRANSACTION_FEE');

  let fxPctRoundTrip = 0;
  if (String(descriptor?.executionCurrency || 'USD').toUpperCase() !== 'USD') {
    if (FX_FEE_PER_SIDE === null) {
      fxPctRoundTrip = null;
      unresolved.push('FX_CONVERSION_FEE');
    } else fxPctRoundTrip = FX_FEE_PER_SIDE * 2;
  }

  const expenseRatioPct = Number(descriptor?.annualExpenseRatioPct || 0);
  const holdingCostPct = Math.max(0, expenseRatioPct) * (Math.max(0, Number(holdingDays) || 0) / 365);
  const knownComponents = [spreadPct, slippagePctRoundTrip, brokerFeePctRoundTrip, fxPctRoundTrip, holdingCostPct]
    .filter((v) => Number.isFinite(Number(v)))
    .map(Number);
  const knownCostFloorPct = knownComponents.reduce((a, b) => a + b, 0);
  const allInCostPct = unresolved.length ? null : knownCostFloorPct;
  const gross = empiricalGrossEdgePct !== null && empiricalGrossEdgePct !== undefined && Number.isFinite(Number(empiricalGrossEdgePct))
    ? Number(empiricalGrossEdgePct)
    : null;
  const netEdgePct = gross !== null && Number.isFinite(allInCostPct) ? gross - allInCostPct : null;
  const costCoverageRatio = gross !== null && Number.isFinite(allInCostPct) && allInCostPct > 0 ? gross / allInCostPct : null;

  let shadowVerdict = 'SHADOW_UNCALIBRATED';
  if (!unresolved.length && gross !== null) {
    shadowVerdict = netEdgePct >= MIN_NET_EDGE_PCT && (allInCostPct === 0 || costCoverageRatio >= MIN_COST_COVERAGE_RATIO)
      ? 'SHADOW_ALLOW'
      : 'SHADOW_TOO_EXPENSIVE';
  }

  return {
    estimatedAt: iso(), holdingDays,
    spreadPct: round(spreadPct), slippagePctRoundTrip: round(slippagePctRoundTrip),
    brokerFeePctRoundTrip: round(brokerFeePctRoundTrip), fxPctRoundTrip: round(fxPctRoundTrip),
    holdingCostPct: round(holdingCostPct), knownCostFloorPct: round(knownCostFloorPct), allInCostPct: round(allInCostPct),
    empiricalGrossEdgePct: round(empiricalGrossEdgePct), netEdgePct: round(netEdgePct), costCoverageRatio: round(costCoverageRatio),
    unresolvedComponents: unresolved, shadowVerdict,
    assumptions: {
      slippageBpsPerSide: SLIPPAGE_BPS_PER_SIDE,
      annualExpenseRatioPct: round(expenseRatioPct),
      expenseRatioSource: descriptor?.assetClass === 'UCITS_ETF_ETC' ? 'STATIC_REFERENCE_SHADOW_ONLY' : 'NOT_APPLICABLE_OR_ZERO',
      brokerFeeSource: descriptor?.assetClass === 'UCITS_ETF_ETC' ? 'UCITS_REAL_ASSET_ZERO_COMMISSION_ASSUMPTION_SHADOW_ONLY' : brokerFeePctRoundTrip === null ? 'UNRESOLVED' : 'ENV_CONFIG',
      fxFeeSource: fxPctRoundTrip === null ? 'UNRESOLVED' : String(descriptor?.executionCurrency || 'USD').toUpperCase() === 'USD' ? 'NO_AGENT_LAYER_FX_EXPECTED' : 'ENV_CONFIG',
      copyReplicationLayerIncluded: false
    }
  };
}
function calibrationForAsset(asset) {
  const rows = state.observations.filter((o) => o.asset === asset);
  const returns24h = rows.map((o) => o.markouts?.h24?.grossReturnPct).filter(Number.isFinite);
  const costs = rows.map((o) => o.costEstimate?.allInCostPct).filter(Number.isFinite);
  const knownFloors = rows.map((o) => o.costEstimate?.knownCostFloorPct).filter(Number.isFinite);
  const samples = returns24h.length;
  return {
    asset, observations: rows.length, samples24h: samples, minimumSamples: MIN_CALIBRATION_SAMPLES,
    ready: samples >= MIN_CALIBRATION_SAMPLES,
    empiricalGrossEdgePct24hMedian: round(median(returns24h)), medianAllInCostPct: round(median(costs)),
    medianKnownCostFloorPct: round(median(knownFloors))
  };
}
function empiricalGrossEdge(asset) {
  const c = calibrationForAsset(asset);
  return c.ready ? c.empiricalGrossEdgePct24hMedian : null;
}
function calibrationSummary() {
  const assets = [...new Set(state.observations.map((o) => o.asset))];
  return {
    generatedAt: iso(), minimumSamples: MIN_CALIBRATION_SAMPLES,
    assets: assets.map(calibrationForAsset), readyAssets: assets.filter((asset) => calibrationForAsset(asset).ready),
    governance: GOVERNANCE
  };
}
function log(event, details = {}, level = 'log') {
  const payload = { component: COMPONENT, version: VERSION, event, at: iso(), mode: MODE, ...details, liveDecisionModified: false, orderModified: false };
  state.lastEvent = payload;
  global.__LEO_ALL_IN_COST_SHADOW_LAST_EVENT__ = payload;
  (console[level] || console.log)(`[LEO_COST_SHADOW] ${JSON.stringify(payload)}`);
}
function safeObservation(observation) {
  if (!observation || typeof observation !== 'object') return observation;
  const { requestHeaders, responseBody, token, referenceId, ...safe } = observation;
  return safe;
}
function redisKey() { return `${REDIS_PREFIX}:state`; }
async function redis(baseFetch, command) {
  if (!REDIS) return null;
  const response = await baseFetch(UPSTASH_URL, {
    method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command)
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
function headersForRead(input, init) {
  const source = new Headers(input?.headers || undefined);
  if (init?.headers) for (const [k, v] of new Headers(init.headers)) source.set(k, v);
  const headers = new Headers();
  for (const key of ['x-api-key', 'x-user-key']) {
    const value = source.get(key);
    if (value) headers.set(key, value);
  }
  headers.set('x-request-id', crypto.randomUUID());
  return headers;
}
async function resolveExecutionInstrument(baseFetch, descriptor, input, init) {
  if (!descriptor.executionSymbol || descriptor.assetClass !== 'UCITS_ETF_ETC') return descriptor.analysisInstrumentId;
  const url = `${SEARCH_URL}?internalSymbolFull=${encodeURIComponent(descriptor.executionSymbol)}`;
  const response = await baseFetch(url, { method: 'GET', headers: headersForRead(input, init) });
  if (!response.ok) throw new Error(`SEARCH_HTTP_${response.status}`);
  const data = await response.json();
  const id = exactInstrumentMatch(data, descriptor.executionSymbol);
  if (!id) throw new Error('EXACT_EXECUTION_SYMBOL_NOT_FOUND');
  return id;
}
async function fetchRates(baseFetch, ids, input, init) {
  const unique = [...new Set(ids.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  const url = `https://public-api.etoro.com${RATES_PATH}?instrumentIds=${encodeURIComponent(unique.join(','))}`;
  const response = await baseFetch(url, { method: 'GET', headers: headersForRead(input, init) });
  if (!response.ok) throw new Error(`RATES_HTTP_${response.status}`);
  return response.json();
}
async function aiCostSnapshot() {
  try {
    if (typeof global.__LEO_AI_COST_STATE__ === 'function') {
      const result = await global.__LEO_AI_COST_STATE__();
      return {
        monthCostUsd: round(result?.state?.monthCostUsd ?? result?.monthCostUsd),
        dailyCalls: result?.state?.daily?.calls ?? result?.daily?.calls ?? null,
        monthlyBudgetUsd: result?.monthlyBudgetUsd ?? null,
        persistent: result?.persistent ?? null
      };
    }
  } catch {}
  return null;
}
function lastAiCallCost() {
  const event = global.__LEO_AI_COST_LAST_EVENT__;
  if (!event || event.event !== 'CALL_COMPLETED') return null;
  const at = new Date(event.at).getTime();
  if (!Number.isFinite(at) || Date.now() - at > 10 * 60 * 1000) return null;
  return round(event.callCostUsd);
}
function appendObservation(observation, baseFetch) {
  state.observations.push(safeObservation(observation));
  if (state.observations.length > HISTORY_LIMIT) state.observations = state.observations.slice(-HISTORY_LIMIT);
  scheduleSave(baseFetch);
}
function updateMarkoutsFromRates(data, baseFetch, now = new Date()) {
  let changed = false;
  for (const observation of state.observations) {
    if (!observation?.analysisMidAtDecision || !observation?.observedAt) continue;
    const rate = exactRate(data, observation.analysisInstrumentId);
    if (!rate?.mid) continue;
    const elapsedHours = (now.getTime() - new Date(observation.observedAt).getTime()) / 3600000;
    if (!Number.isFinite(elapsedHours) || elapsedHours < 0) continue;
    observation.markouts = observation.markouts || {};
    for (const horizon of MARKOUT_HOURS) {
      const key = `h${horizon}`;
      if (observation.markouts[key] || elapsedHours < horizon) continue;
      observation.markouts[key] = {
        recordedAt: now.toISOString(), elapsedHours: round(elapsedHours, 3), marketMid: round(rate.mid, 8),
        grossReturnPct: round(((rate.mid / observation.analysisMidAtDecision) - 1) * 100)
      };
      state.counters.markoutsRecorded += 1;
      changed = true;
    }
  }
  if (changed) scheduleSave(baseFetch);
}
function attachOrderResult(observationId, response, baseFetch) {
  const observation = state.observations.find((o) => o.id === observationId);
  if (!observation) return;
  observation.orderHttp = { status: response.status, ok: response.ok, observedAt: iso() };
  if (response.ok) state.counters.orderHttpSuccess += 1;
  else state.counters.orderHttpFailure += 1;
  scheduleSave(baseFetch);
}
function observePnlData(data, baseFetch) {
  const positions = collectObjects(data).filter((item) => Number.isFinite(instrumentIdOf(item)));
  if (!positions.length) return;
  const latest = [...state.observations].reverse().find((o) => o.orderHttp?.ok && !o.portfolioSeenAfterOrder);
  if (!latest) return;
  const found = positions.some((item) => instrumentIdOf(item) === latest.analysisInstrumentId || item?.leoAnalysisAsset === latest.asset);
  if (found) {
    latest.portfolioSeenAfterOrder = { observedAt: iso(), evidence: 'POSITION_VISIBLE_ON_REAL_PNL_READ' };
    scheduleSave(baseFetch);
  }
}
async function statusPayload() {
  const ai = await aiCostSnapshot();
  const confirmed = state.observations.filter((o) => o.portfolioSeenAfterOrder).length;
  const allInKnown = state.observations.map((o) => o.costEstimate?.allInCostPct).filter(Number.isFinite);
  return {
    version: VERSION, enabled: ENABLED, mode: MODE, persistent: REDIS, governance: GOVERNANCE,
    counts: {
      observations: state.observations.length, postOrderPortfolioVisibilityObserved: confirmed,
      markoutsRecorded: state.counters.markoutsRecorded, calibratedAssets: calibrationSummary().readyAssets.length
    },
    costModel: {
      expectedHoldingDays: HOLDING_DAYS, slippageBpsPerSide: SLIPPAGE_BPS_PER_SIDE,
      minNetEdgePct: MIN_NET_EDGE_PCT, minCostCoverageRatio: MIN_COST_COVERAGE_RATIO,
      medianKnownAllInCostPct: round(median(allInKnown)), unresolvedFeesAreExplicit: true, copyReplicationLayerIncluded: false
    },
    systemCosts: {
      ai, configuredRenderMonthlyUsd: RENDER_MONTHLY_USD, configuredDataMonthlyUsd: DATA_MONTHLY_USD,
      configuredNonAiInfrastructureMonthlyUsd: round(RENDER_MONTHLY_USD + DATA_MONTHLY_USD), allocatedIntoTradeEdge: false
    },
    lastObservation: state.observations.length ? state.observations[state.observations.length - 1] : null,
    lastEvent: state.lastEvent, updatedAt: state.updatedAt
  };
}
function installExpressRoutes() {
  let express;
  try { express = require('express'); } catch { return false; }
  const proto = express?.application;
  if (!proto || proto.__leoCostShadowListenPatched) return Boolean(proto);
  const originalListen = proto.listen;
  proto.listen = function leoCostShadowListen(...args) {
    if (!this.__leoCostShadowRoutesInstalled) {
      this.__leoCostShadowRoutesInstalled = true;
      this.get('/cost-shadow-status', async (_req, res) => {
        try { await loadState(installedAgent?.baseFetch || global.fetch); res.json(await statusPayload()); }
        catch { res.status(500).json({ ok: false, error: 'COST_SHADOW_STATUS_FAILED' }); }
      });
      this.get('/cost-shadow-history', async (_req, res) => {
        try { await loadState(installedAgent?.baseFetch || global.fetch); res.json({ version: VERSION, mode: MODE, governance: GOVERNANCE, observations: state.observations.slice(-100) }); }
        catch { res.status(500).json({ ok: false, error: 'COST_SHADOW_HISTORY_FAILED' }); }
      });
      this.get('/cost-shadow-calibration', async (_req, res) => {
        try { await loadState(installedAgent?.baseFetch || global.fetch); res.json(calibrationSummary()); }
        catch { res.status(500).json({ ok: false, error: 'COST_SHADOW_CALIBRATION_FAILED' }); }
      });
    }
    return originalListen.apply(this, args);
  };
  proto.__leoCostShadowListenPatched = true;
  return true;
}
function trackTask(promise) {
  const task = Promise.resolve(promise).catch(() => null);
  pendingTasks.add(task);
  task.finally(() => pendingTasks.delete(task));
  return task;
}
async function drainPendingTasks() { await Promise.allSettled([...pendingTasks]); }
async function observeBuyAttempt(baseFetch, input, init, body) {
  await loadState(baseFetch);
  const analysisInstrumentId = Number(body.instrumentId ?? body.InstrumentId ?? body.instrumentID ?? body.InstrumentID);
  const descriptor = assetDescriptor(analysisInstrumentId);
  let executionInstrumentId = analysisInstrumentId;
  let analysisRate = null;
  let executionRate = null;
  let quoteError = null;
  try {
    executionInstrumentId = await resolveExecutionInstrument(baseFetch, descriptor, input, init);
    const rateData = await fetchRates(baseFetch, [analysisInstrumentId, executionInstrumentId], input, init);
    analysisRate = exactRate(rateData, analysisInstrumentId);
    executionRate = exactRate(rateData, executionInstrumentId);
    if (!analysisRate) throw new Error('ANALYSIS_QUOTE_NOT_FOUND');
    if (!executionRate) throw new Error('EXECUTION_QUOTE_NOT_FOUND');
  } catch (error) {
    quoteError = String(error?.message || error).slice(0, 120);
    state.counters.quoteFailures += 1;
  }
  const grossEdge = empiricalGrossEdge(descriptor.asset);
  const costEstimate = buildCostEstimate({ descriptor, executionRate, empiricalGrossEdgePct: grossEdge });
  const observation = {
    id: crypto.randomUUID(), observedAt: iso(), mode: MODE, asset: descriptor.asset, assetClass: descriptor.assetClass,
    analysisInstrumentId, executionSymbol: descriptor.executionSymbol,
    executionInstrumentId: Number.isFinite(executionInstrumentId) ? executionInstrumentId : null,
    executionCurrency: descriptor.executionCurrency, amountUsdVirtual: round(body.amount), leverageObserved: Number(body.leverage ?? 1),
    analysisMidAtDecision: round(analysisRate?.mid, 8),
    executionQuote: executionRate ? { bid: round(executionRate.bid, 8), ask: round(executionRate.ask, 8), mid: round(executionRate.mid, 8) } : null,
    quoteError, costEstimate, aiMarginalCallCostUsd: lastAiCallCost(), markouts: {}, governance: GOVERNANCE
  };
  state.counters.buyAttemptsObserved += 1;
  appendObservation(observation, baseFetch);
  log('BUY_SHADOW_OBSERVED', {
    observationId: observation.id, asset: descriptor.asset, executionSymbol: descriptor.executionSymbol,
    amountUsdVirtual: observation.amountUsdVirtual, knownCostFloorPct: costEstimate.knownCostFloorPct,
    allInCostPct: costEstimate.allInCostPct, empiricalGrossEdgePct: costEstimate.empiricalGrossEdgePct,
    netEdgePct: costEstimate.netEdgePct, shadowVerdict: costEstimate.shadowVerdict,
    unresolvedComponents: costEstimate.unresolvedComponents
  });
  return observation;
}
function installAgent(options = {}) {
  const baseFetch = options.fetch || global.fetch;
  if (typeof baseFetch !== 'function') return { installed: false, reason: 'FETCH_UNAVAILABLE', version: VERSION };
  if (options.installRoutes !== false) installExpressRoutes();

  async function wrappedFetch(input, init = {}) {
    const url = safeUrl(input);
    const method = methodOf(input, init);
    if (ENABLED && url?.origin === 'https://public-api.etoro.com' && method === 'POST' && url.toString() === REAL_ORDER_URL) {
      const body = bodyObject(init);
      const isBuy = String(body?.action || '').toLowerCase() === 'open' && String(body?.transaction || '').toLowerCase() === 'buy';
      if (isBuy) {
        const observationTask = trackTask(
          observeBuyAttempt(baseFetch, input, init, body).catch((error) => {
            log('SHADOW_OBSERVATION_FAILED_OPEN', { error: String(error?.message || error).slice(0, 160) }, 'warn');
            return null;
          })
        );
        // Governance invariant: the exact original request is forwarded unchanged
        // and is not delayed waiting for shadow calculations.
        const response = await baseFetch(input, init);
        trackTask(observationTask.then((observation) => {
          if (observation) attachOrderResult(observation.id, response, baseFetch);
        }));
        return response;
      }
    }
    const response = await baseFetch(input, init);
    if (ENABLED && url?.origin === 'https://public-api.etoro.com' && method === 'GET' && response?.ok) {
      if (url.pathname === RATES_PATH) response.clone().json().then((data) => updateMarkoutsFromRates(data, baseFetch)).catch(() => {});
      else if (url.pathname === REAL_PNL_PATH) response.clone().json().then((data) => observePnlData(data, baseFetch)).catch(() => {});
    }
    return response;
  }

  if (!options.fetch) global.fetch = wrappedFetch;
  installedAgent = { installed: true, version: VERSION, mode: MODE, baseFetch, fetch: wrappedFetch, governance: GOVERNANCE };
  global.__LEO_ALL_IN_COST_SHADOW__ = installedAgent;
  loadState(baseFetch).catch(() => {});
  log('STARTED', {
    enabled: ENABLED, persistent: REDIS,
    endpoints: ['/cost-shadow-status', '/cost-shadow-history', '/cost-shadow-calibration'],
    unresolvedFeesAreExplicit: true, copyReplicationLayerIncluded: false, governance: GOVERNANCE
  });
  return installedAgent;
}

const autoInstalled = process.env.COST_SHADOW_AUTO_INSTALL === 'false' ? null : installAgent();

module.exports = {
  VERSION, GOVERNANCE, UCITS, CRYPTO_BY_ID, assetDescriptor, exactInstrumentMatch, exactRate,
  buildCostEstimate, calibrationForAsset, calibrationSummary, updateMarkoutsFromRates, installAgent, autoInstalled,
  _test: {
    freshState, normalizeState, getState: () => state,
    setState: (next) => { state = normalizeState(next); loaded = true; },
    resetState: () => { state = freshState(); loaded = true; }, drainPendingTasks
  }
};
