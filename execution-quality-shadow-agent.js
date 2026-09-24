'use strict';

/**
 * LEO-AI SENTINEL — Execution Quality & Copy Calibration Shadow Agent.
 *
 * Purpose:
 * - Observe the exact eToro request that reaches the broker layer after any
 *   approved UCITS rewrite, without modifying or delaying the order logic.
 * - Measure broker-response latency, portfolio-confirmation latency, observed
 *   virtual fill amount, observed open rate and slippage when the data exists.
 * - Keep copy sizing facts separated by provenance: OBSERVED on the agent
 *   portfolio, CONFIGURED from env, and ESTIMATED for the copier layer.
 * - Build a conservative estimate of the virtual minimum required to target the
 *   configured copied-position floor, but NEVER apply that estimate to LIVE.
 *
 * Placement:
 * This preload is intentionally loaded BEFORE etoro-ucits-execution-bridge.js.
 * The bridge therefore delegates its final rewritten BUY request through this
 * observer. That lets the observer see the true execution instrumentId and the
 * raw REAL PnL response while remaining unable to originate or rewrite orders.
 *
 * Governance:
 * - shadow / analysis only
 * - zero additional eToro market/provider calls
 * - never blocks, retries, delays intentionally, sizes, rewrites or originates
 * - calibration is estimate-only until a copier-side source can be observed
 */

const crypto = require('crypto');

const VERSION = 'v10.22.22.0-execution-quality-readiness';
const COMPONENT = 'LEO_EXECUTION_QUALITY_SHADOW';
const MODE = 'shadow';
const ENABLED = process.env.EXECUTION_QUALITY_SHADOW_ENABLED !== 'false';

const ETORO_ORIGIN = 'https://public-api.etoro.com';
const REAL_ORDER_PATH = '/api/v2/trading/execution/orders';
const REAL_CLOSE_PREFIX = '/api/v1/trading/execution/market-close-orders/positions/';
const REAL_PNL_PATH = '/api/v1/trading/info/real/pnl';
const RATES_PATH = '/api/v1/market-data/instruments/rates';
const SEARCH_PATH = '/api/v1/market-data/search';

const HISTORY_LIMIT = boundedNumber(process.env.EXECUTION_QUALITY_HISTORY_LIMIT, 250, 25, 1000, true);
const QUOTE_MAX_AGE_SECONDS = boundedNumber(process.env.EXECUTION_QUALITY_QUOTE_MAX_AGE_SECONDS, 600, 30, 3600, true);
const MIN_CALIBRATION_SAMPLES = boundedNumber(process.env.COPY_CALIBRATION_MIN_SAMPLES, 5, 3, 100, true);

const MIN_REAL_COPIED_POSITION_USD = boundedNumber(process.env.MIN_REAL_COPIED_POSITION_USD, 10, 1, 1000);
const REAL_COPY_CAPITAL_AMOUNT = boundedNumber(process.env.REAL_COPY_CAPITAL_AMOUNT, 173.94, 0, 1000000);
const REAL_COPY_CAPITAL_CURRENCY = ['EUR', 'USD'].includes(
  String(process.env.REAL_COPY_CAPITAL_CURRENCY || 'EUR').trim().toUpperCase()
) ? String(process.env.REAL_COPY_CAPITAL_CURRENCY || 'EUR').trim().toUpperCase() : 'EUR';
const REAL_COPY_CAPITAL_USD_OVERRIDE = boundedNumber(process.env.REAL_COPY_CAPITAL_USD, 0, 0, 1000000);
const REAL_COPY_EUR_USD_RATE = boundedNumber(process.env.REAL_COPY_EUR_USD_RATE, 1.15, 0.5, 2);
const REAL_COPY_REPLICATION_BUFFER_PCT = boundedNumber(process.env.REAL_COPY_REPLICATION_BUFFER_PCT, 5, 0, 25);

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const REDIS = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_PREFIX = String(process.env.EXECUTION_QUALITY_REDIS_PREFIX || 'leo:execution-quality:v1');

const GOVERNANCE = Object.freeze({
  analysisOnly: true,
  shadowOnly: true,
  canPlaceOrder: false,
  canBlockOrder: false,
  canModifyOrder: false,
  canModifyDecision: false,
  canModifySizing: false,
  canChangeMinimumOrder: false,
  canRetryOrder: false,
  canPromoteLive: false,
  providerCallsAdded: 0,
  brokerReadCallsAdded: 0,
  orderCallsAdded: 0,
  observesRawBrokerRequest: true,
  copyCalibrationAutoApply: false
});

const WATCHLIST_BY_ID = Object.freeze({
  8760: 'NVDA', 1832: 'AMD', 1135: 'ORCL', 8757: 'MSFT', 8758: 'GOOG',
  8753: 'AMZN', 2490: 'BABA', 9401: 'COIN', 7991: 'PLTR', 14320: 'RKLB',
  13596: 'IONQ', 10088: 'ASTS', 100109: 'BTC', 100001: 'ETH', 100063: 'SOL',
  3417: 'SPY', 3418: 'QQQ', 15634: 'GLD', 3020: 'TLT', 3100: 'SHY',
  3017: 'XLV', 3022: 'XLP', 3008: 'XLE', 2870: 'BRK.B', 13624: 'JPM',
  9422: 'PANW', 9419: 'CRWD'
});

const EXECUTION_SYMBOL_TO_ASSET = Object.freeze({
  'CSPX.L': 'SPY',
  'CNDX.L': 'QQQ',
  'IGLN.L': 'GLD',
  'IBTA.L': 'SHY',
  'DTLA.L': 'TLT',
  'ZPDH.DE': 'XLV',
  'XDWS.DE': 'XLP',
  'ZPDE.DE': 'XLE'
});

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

function round(value, digits = 6) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function median(values) {
  const sorted = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, q) {
  const sorted = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const index = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * q));
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  const weight = index - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function ceilCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.ceil(n * 100) / 100;
}

function freshState() {
  return {
    version: VERSION,
    mode: MODE,
    createdAt: iso(),
    updatedAt: iso(),
    observations: [],
    quotesByInstrument: {},
    executionAliases: {},
    lastPnlSnapshot: null,
    lastEvent: null,
    counters: {
      buyAttemptsObserved: 0,
      sellAttemptsObserved: 0,
      orderHttpSuccess: 0,
      orderHttpFailure: 0,
      pnlReadsObserved: 0,
      quoteReadsObserved: 0,
      exactBuyConfirmations: 0,
      exactSellConfirmations: 0
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
    mode: MODE,
    observations: Array.isArray(value.observations) ? value.observations.slice(-HISTORY_LIMIT) : [],
    quotesByInstrument: value.quotesByInstrument && typeof value.quotesByInstrument === 'object'
      ? value.quotesByInstrument
      : {},
    executionAliases: value.executionAliases && typeof value.executionAliases === 'object'
      ? value.executionAliases
      : {},
    lastPnlSnapshot: value.lastPnlSnapshot && typeof value.lastPnlSnapshot === 'object'
      ? value.lastPnlSnapshot
      : null,
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

function methodOf(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function bodyObject(init) {
  if (!init || init.body == null) return null;
  const text = typeof init.body === 'string'
    ? init.body
    : Buffer.isBuffer(init.body)
      ? init.body.toString('utf8')
      : null;
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
  for (const name of names) {
    if (object[name] !== null && object[name] !== undefined) return String(object[name]);
  }
  return null;
}

function collectObjects(value, out = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (!Array.isArray(value)) out.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (child && typeof child === 'object') collectObjects(child, out, seen);
  }
  return out;
}

function instrumentIdOf(object) {
  return numberField(object, ['instrumentId', 'instrumentID', 'InstrumentId', 'InstrumentID']);
}

function positionIdOf(object) {
  const value = numberField(object, ['positionId', 'positionID', 'PositionId', 'PositionID']);
  return value === null ? null : String(value);
}

function orderIdOf(object) {
  const value = object?.orderId ?? object?.orderID ?? object?.OrderId ?? object?.OrderID ?? null;
  return value === null || value === undefined ? null : String(value);
}

function symbolOf(object) {
  return stringField(object, ['internalSymbolFull', 'InternalSymbolFull', 'symbol', 'Symbol']);
}

function log(event, details = {}, level = 'log') {
  const payload = {
    component: COMPONENT,
    version: VERSION,
    event,
    at: iso(),
    mode: MODE,
    ...details,
    liveDecisionModified: false,
    orderModified: false,
    sizingModified: false
  };
  state.lastEvent = payload;
  global.__LEO_EXECUTION_QUALITY_SHADOW_LAST_EVENT__ = payload;
  (console[level] || console.log)('[LEO_EXECUTION_QUALITY] ' + JSON.stringify(payload));
}

function trackTask(promise) {
  const task = Promise.resolve(promise).catch(() => null);
  pendingTasks.add(task);
  task.finally(() => pendingTasks.delete(task));
  return task;
}

async function drainPendingTasks() {
  await Promise.allSettled([...pendingTasks]);
}

function redisKey() {
  return REDIS_PREFIX + ':state';
}

async function redis(baseFetch, command) {
  if (!REDIS) return null;
  const response = await baseFetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + UPSTASH_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error('UPSTASH_HTTP_' + response.status);
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
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function scheduleSave(baseFetch) {
  state.updatedAt = iso();
  if (!REDIS || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const persistable = {
        ...state,
        quotesByInstrument: Object.fromEntries(
          Object.entries(state.quotesByInstrument || {})
            .sort((a, b) => String(b[1]?.observedAt || '').localeCompare(String(a[1]?.observedAt || '')))
            .slice(0, 80)
        ),
        observations: (state.observations || []).slice(-HISTORY_LIMIT)
      };
      await redis(baseFetch, ['SET', redisKey(), JSON.stringify(persistable)]);
    } catch (error) {
      log('STORE_WRITE_FALLBACK', { error: String(error?.message || error).slice(0, 160) }, 'warn');
    }
  }, 250);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function appendObservation(observation, baseFetch) {
  state.observations.push(observation);
  if (state.observations.length > HISTORY_LIMIT) {
    state.observations = state.observations.slice(-HISTORY_LIMIT);
  }
  scheduleSave(baseFetch);
}

function configuredCopyCapitalUsd() {
  if (REAL_COPY_CAPITAL_USD_OVERRIDE > 0) return round(REAL_COPY_CAPITAL_USD_OVERRIDE, 2);
  if (REAL_COPY_CAPITAL_AMOUNT <= 0) return 0;
  return round(
    REAL_COPY_CAPITAL_CURRENCY === 'EUR'
      ? REAL_COPY_CAPITAL_AMOUNT * REAL_COPY_EUR_USD_RATE
      : REAL_COPY_CAPITAL_AMOUNT,
    2
  );
}

function aliasForInstrument(instrumentId) {
  const id = String(Number(instrumentId));
  const learned = state.executionAliases?.[id];
  if (learned) return learned;
  const direct = WATCHLIST_BY_ID[Number(instrumentId)];
  if (direct) {
    return {
      asset: direct,
      analysisInstrumentId: Number(instrumentId),
      executionInstrumentId: Number(instrumentId),
      executionSymbol: direct,
      source: 'STATIC_ANALYSIS_INSTRUMENT'
    };
  }
  return {
    asset: 'INSTRUMENT_' + id,
    analysisInstrumentId: null,
    executionInstrumentId: Number(instrumentId),
    executionSymbol: null,
    source: 'UNMAPPED_EXECUTION_INSTRUMENT'
  };
}

function learnUcitsAliasFromBridge(instrumentId) {
  const event = global.__LEO_ETORO_UCITS_EXECUTION_BRIDGE_LAST_EVENT__;
  if (!event || event.event !== 'BUY_REWRITTEN_TO_UCITS') return null;
  if (Number(event.executionInstrumentId) !== Number(instrumentId)) return null;
  const eventTime = new Date(event.at).getTime();
  if (!Number.isFinite(eventTime) || Math.abs(Date.now() - eventTime) > 15000) return null;
  const alias = {
    asset: String(event.analysisAsset || 'UNKNOWN').toUpperCase(),
    analysisInstrumentId: Number(event.analysisInstrumentId) || null,
    executionInstrumentId: Number(event.executionInstrumentId),
    executionSymbol: event.executionSymbol || null,
    source: 'UCITS_BRIDGE_REWRITE_EVENT'
  };
  state.executionAliases[String(alias.executionInstrumentId)] = alias;
  return alias;
}

function learnSearchAlias(url, data, baseFetch) {
  const symbol = String(url?.searchParams?.get('internalSymbolFull') || '').trim().toUpperCase();
  const asset = EXECUTION_SYMBOL_TO_ASSET[symbol];
  if (!symbol || !asset) return;
  const matches = collectObjects(data)
    .filter((object) => String(symbolOf(object) || '').trim().toUpperCase() === symbol)
    .map(instrumentIdOf)
    .filter((id) => Number.isFinite(id) && id > 0);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) return;
  const executionInstrumentId = unique[0];
  const analysisEntry = Object.entries(WATCHLIST_BY_ID)
    .find(([, value]) => value === asset);
  const alias = {
    asset,
    analysisInstrumentId: analysisEntry ? Number(analysisEntry[0]) : null,
    executionInstrumentId,
    executionSymbol: symbol,
    source: 'ETORO_EXACT_SYMBOL_SEARCH_OBSERVED'
  };
  state.executionAliases[String(executionInstrumentId)] = alias;
  scheduleSave(baseFetch);
}

function quoteFromObject(object) {
  const instrumentId = instrumentIdOf(object);
  if (!Number.isFinite(instrumentId)) return null;
  const bid = numberField(object, ['bid', 'Bid', 'BID']);
  const ask = numberField(object, ['ask', 'Ask', 'ASK']);
  const last = numberField(object, ['lastExecution', 'LastExecution', 'last', 'Last', 'price', 'Price']);
  let mid = null;
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) mid = (bid + ask) / 2;
  else if (Number.isFinite(last) && last > 0) mid = last;
  else if (Number.isFinite(bid) && bid > 0) mid = bid;
  else if (Number.isFinite(ask) && ask > 0) mid = ask;
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const spreadPct = Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0
    ? ((ask - bid) / mid) * 100
    : null;
  return {
    instrumentId,
    bid: round(bid, 10),
    ask: round(ask, 10),
    last: round(last, 10),
    mid: round(mid, 10),
    spreadPct: round(spreadPct, 6),
    observedAt: iso(),
    source: 'ETORO_RATE_RESPONSE_OBSERVED'
  };
}

function ingestRates(data, baseFetch) {
  let count = 0;
  for (const object of collectObjects(data)) {
    const quote = quoteFromObject(object);
    if (!quote) continue;
    state.quotesByInstrument[String(quote.instrumentId)] = quote;
    count += 1;
  }
  if (count > 0) {
    state.counters.quoteReadsObserved += 1;
    scheduleSave(baseFetch);
  }
  return count;
}

function recentQuote(instrumentId, now = Date.now()) {
  const quote = state.quotesByInstrument?.[String(Number(instrumentId))] || null;
  if (!quote) return null;
  const observed = new Date(quote.observedAt).getTime();
  const ageSeconds = Number.isFinite(observed) ? Math.max(0, (now - observed) / 1000) : null;
  return {
    ...quote,
    ageSeconds: round(ageSeconds, 3),
    freshEnoughForSlippage: Number.isFinite(ageSeconds) && ageSeconds <= QUOTE_MAX_AGE_SECONDS
  };
}

function extractSafeExecutionResponse(data) {
  if (!data || typeof data !== 'object') return {
    orderId: null,
    positionId: null,
    executionRate: null,
    statusId: null,
    success: null
  };
  const objects = collectObjects(data);
  let orderId = null;
  let positionId = null;
  let executionRate = null;
  let statusId = null;
  let success = null;
  for (const object of objects) {
    if (orderId === null) orderId = orderIdOf(object);
    if (positionId === null) positionId = positionIdOf(object);
    if (executionRate === null) {
      executionRate = numberField(object, [
        'executionRate', 'ExecutionRate', 'openRate', 'OpenRate',
        'closeRate', 'CloseRate', 'rate', 'Rate'
      ]);
    }
    if (statusId === null) statusId = numberField(object, ['statusId', 'statusID', 'StatusId', 'StatusID']);
    if (success === null && typeof object.success === 'boolean') success = object.success;
  }
  return {
    orderId,
    positionId,
    executionRate: round(executionRate, 10),
    statusId,
    success
  };
}

function portfolioRoot(data) {
  const candidates = collectObjects(data).filter((object) => Array.isArray(object.positions));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.positions.length - a.positions.length)[0];
}

function assetForExecutionInstrument(instrumentId) {
  return aliasForInstrument(instrumentId);
}

function extractPnlSnapshot(data) {
  const root = portfolioRoot(data);
  if (!root) return {
    observedAt: iso(),
    credit: null,
    positions: [],
    positionsById: {},
    agentPortfolioValueUsd: null,
    source: 'REAL_PNL_RESPONSE_OBSERVED'
  };
  const positions = [];
  for (const raw of root.positions) {
    const positionId = positionIdOf(raw);
    const instrumentId = instrumentIdOf(raw);
    if (!positionId || !Number.isFinite(instrumentId)) continue;
    const alias = assetForExecutionInstrument(instrumentId);
    const amount = numberField(raw, ['amount', 'Amount', 'invested', 'Invested']);
    const units = numberField(raw, ['units', 'Units', 'amountInUnits', 'AmountInUnits']);
    const profit = numberField(raw, ['profit', 'Profit', 'netProfit', 'NetProfit']);
    const openRate = numberField(raw, ['openRate', 'OpenRate']);
    const currentRate = numberField(raw, ['currentRate', 'CurrentRate']);
    const estimatedValue = Number.isFinite(amount)
      ? amount + (Number.isFinite(profit) ? profit : 0)
      : null;
    positions.push({
      positionId,
      instrumentId,
      asset: alias.asset,
      aliasSource: alias.source,
      analysisInstrumentId: alias.analysisInstrumentId,
      executionSymbol: alias.executionSymbol,
      amountUsdVirtual: round(amount, 6),
      units: round(units, 12),
      profitUsdVirtual: round(profit, 6),
      estimatedValueUsdVirtual: round(estimatedValue, 6),
      openRate: round(openRate, 10),
      currentRate: round(currentRate, 10)
    });
  }
  const credit = numberField(root, ['credit', 'Credit']);
  const gross = positions
    .map((position) => Number(position.estimatedValueUsdVirtual))
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
  const portfolioValue = Number.isFinite(credit) ? credit + gross : null;
  return {
    observedAt: iso(),
    credit: round(credit, 6),
    positions,
    positionsById: Object.fromEntries(positions.map((position) => [String(position.positionId), position])),
    agentPortfolioValueUsd: round(portfolioValue, 6),
    source: 'REAL_PNL_RESPONSE_OBSERVED'
  };
}

function preRequestContext(instrumentId, side, positionId = null) {
  const alias = learnUcitsAliasFromBridge(instrumentId) || aliasForInstrument(instrumentId);
  const quote = recentQuote(instrumentId);
  const beforePnl = state.lastPnlSnapshot;
  const beforeIdsForInstrument = (beforePnl?.positions || [])
    .filter((position) => Number(position.instrumentId) === Number(instrumentId))
    .map((position) => String(position.positionId));
  const targetPosition = positionId && beforePnl?.positionsById
    ? beforePnl.positionsById[String(positionId)] || null
    : null;
  return {
    alias,
    quote,
    beforePnlObservedAt: beforePnl?.observedAt || null,
    beforeCreditUsdVirtual: beforePnl?.credit ?? null,
    beforeAgentPortfolioValueUsd: beforePnl?.agentPortfolioValueUsd ?? null,
    beforePositionIdsForInstrument: beforeIdsForInstrument,
    targetPosition,
    side
  };
}

function makeBuyObservation(body) {
  const instrumentId = Number(body?.instrumentId ?? body?.InstrumentId ?? body?.instrumentID ?? body?.InstrumentID);
  const context = preRequestContext(instrumentId, 'BUY');
  return {
    id: crypto.randomUUID(),
    version: VERSION,
    mode: MODE,
    side: 'BUY',
    status: 'ORDER_REQUEST_OBSERVED',
    requestObservedAt: iso(),
    asset: context.alias.asset,
    analysisInstrumentId: context.alias.analysisInstrumentId,
    executionInstrumentId: instrumentId,
    executionSymbol: context.alias.executionSymbol,
    aliasSource: context.alias.source,
    virtualOrderAmountUsd: round(body?.amount, 6),
    leverageObserved: Number(body?.leverage ?? 1),
    orderTypeObserved: body?.orderType || null,
    preSendQuote: context.quote,
    beforePnlObservedAt: context.beforePnlObservedAt,
    beforeCreditUsdVirtual: context.beforeCreditUsdVirtual,
    beforeAgentPortfolioValueUsd: context.beforeAgentPortfolioValueUsd,
    beforePositionIdsForInstrument: context.beforePositionIdsForInstrument,
    brokerResponse: null,
    confirmation: null,
    executionQuality: null,
    copyEstimate: null,
    provenance: {
      virtualOrderAmountUsd: 'OBSERVED_ORDER_BODY',
      preSendQuote: context.quote ? 'OBSERVED_ETORO_RATE_RESPONSE' : 'NOT_OBSERVED',
      copyLayer: 'ESTIMATED_ONLY_NOT_DIRECTLY_OBSERVED'
    },
    governance: GOVERNANCE
  };
}

function positionIdFromCloseUrl(url) {
  if (!url?.pathname?.startsWith(REAL_CLOSE_PREFIX)) return null;
  const raw = url.pathname.slice(REAL_CLOSE_PREFIX.length).split('/')[0];
  return raw ? decodeURIComponent(raw) : null;
}

function makeSellObservation(url, body) {
  const positionId = positionIdFromCloseUrl(url);
  const before = state.lastPnlSnapshot?.positionsById?.[String(positionId)] || null;
  const instrumentId = Number(before?.instrumentId);
  const context = Number.isFinite(instrumentId)
    ? preRequestContext(instrumentId, 'SELL', positionId)
    : {
        alias: { asset: 'UNKNOWN', analysisInstrumentId: null, executionSymbol: null, source: 'TARGET_POSITION_NOT_IN_LAST_PNL' },
        quote: null,
        beforePnlObservedAt: state.lastPnlSnapshot?.observedAt || null,
        beforeCreditUsdVirtual: state.lastPnlSnapshot?.credit ?? null,
        beforeAgentPortfolioValueUsd: state.lastPnlSnapshot?.agentPortfolioValueUsd ?? null,
        targetPosition: before,
        beforePositionIdsForInstrument: []
      };
  return {
    id: crypto.randomUUID(),
    version: VERSION,
    mode: MODE,
    side: 'SELL',
    status: 'ORDER_REQUEST_OBSERVED',
    requestObservedAt: iso(),
    asset: before?.asset || context.alias.asset,
    analysisInstrumentId: before?.analysisInstrumentId ?? context.alias.analysisInstrumentId,
    executionInstrumentId: Number.isFinite(instrumentId) ? instrumentId : null,
    executionSymbol: before?.executionSymbol || context.alias.executionSymbol,
    aliasSource: before?.aliasSource || context.alias.source,
    targetPositionId: positionId,
    fullCloseRequested: body?.UnitsToDeduct === null,
    unitsToDeductObserved: body?.UnitsToDeduct ?? null,
    preSendQuote: context.quote,
    beforePnlObservedAt: context.beforePnlObservedAt,
    beforeCreditUsdVirtual: context.beforeCreditUsdVirtual,
    beforeAgentPortfolioValueUsd: context.beforeAgentPortfolioValueUsd,
    targetPositionBefore: before,
    brokerResponse: null,
    confirmation: null,
    executionQuality: null,
    copyEstimate: null,
    provenance: {
      targetPositionBefore: before ? 'OBSERVED_REAL_PNL' : 'NOT_OBSERVED',
      preSendQuote: context.quote ? 'OBSERVED_ETORO_RATE_RESPONSE' : 'NOT_OBSERVED',
      copyLayer: 'ESTIMATED_ONLY_NOT_DIRECTLY_OBSERVED'
    },
    governance: GOVERNANCE
  };
}

function attachOrderResponse(observation, response, data, baseFetch) {
  if (!observation) return;
  const now = Date.now();
  const start = new Date(observation.requestObservedAt).getTime();
  const safe = extractSafeExecutionResponse(data);
  observation.brokerResponse = {
    observedAt: iso(),
    httpStatus: response.status,
    httpOk: response.ok,
    latencyMs: Number.isFinite(start) ? Math.max(0, now - start) : null,
    orderId: safe.orderId,
    positionId: safe.positionId,
    executionRate: safe.executionRate,
    statusId: safe.statusId,
    success: safe.success,
    provenance: 'OBSERVED_BROKER_RESPONSE'
  };
  observation.status = response.ok ? 'BROKER_HTTP_OK' : 'BROKER_HTTP_FAILED';
  if (response.ok) state.counters.orderHttpSuccess += 1;
  else state.counters.orderHttpFailure += 1;
  scheduleSave(baseFetch);
}

function slippageBps(side, executionRate, quote) {
  const rate = Number(executionRate);
  const mid = Number(quote?.mid);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(mid) || mid <= 0) return null;
  if (!quote?.freshEnoughForSlippage) return null;
  return side === 'SELL'
    ? ((mid - rate) / mid) * 10000
    : ((rate - mid) / mid) * 10000;
}

function copyEstimateForObservation(observation, pnlSnapshot) {
  const configuredCapitalUsd = configuredCopyCapitalUsd();
  const agentValue = Number(pnlSnapshot?.agentPortfolioValueUsd || observation?.beforeAgentPortfolioValueUsd);
  const replicationRatioEstimate = configuredCapitalUsd > 0 && Number.isFinite(agentValue) && agentValue > 0
    ? configuredCapitalUsd / agentValue
    : null;
  const virtualAmount = observation.side === 'BUY'
    ? Number(observation.confirmation?.virtualInvestedAmountUsd)
    : Number(observation.targetPositionBefore?.estimatedValueUsdVirtual ?? observation.targetPositionBefore?.amountUsdVirtual);
  const estimatedCopiedAmountUsd = Number.isFinite(replicationRatioEstimate) && Number.isFinite(virtualAmount)
    ? virtualAmount * replicationRatioEstimate
    : null;
  return {
    configuredCopyCapitalUsd: configuredCapitalUsd || null,
    configuredCopyCapitalSource: REAL_COPY_CAPITAL_USD_OVERRIDE > 0
      ? 'CONFIGURED_REAL_COPY_CAPITAL_USD'
      : 'CONFIGURED_REAL_COPY_CAPITAL_' + REAL_COPY_CAPITAL_CURRENCY,
    agentPortfolioValueUsd: Number.isFinite(agentValue) ? round(agentValue, 6) : null,
    agentPortfolioValueSource: Number.isFinite(agentValue) ? 'OBSERVED_REAL_AGENT_PNL' : 'NOT_OBSERVED',
    replicationRatioEstimate: round(replicationRatioEstimate, 10),
    estimatedCopiedAmountUsd: round(estimatedCopiedAmountUsd, 6),
    copiedAmountSource: 'ESTIMATED_NOT_DIRECTLY_OBSERVED',
    directCopierObservationAvailable: false,
    eligibleForAutomaticSizingChange: false
  };
}

function confirmBuyObservation(observation, pnlSnapshot) {
  const brokerPositionId = observation.brokerResponse?.positionId;
  let position = brokerPositionId ? pnlSnapshot.positionsById?.[String(brokerPositionId)] || null : null;
  let proof = null;

  if (position) {
    proof = 'BROKER_POSITION_ID_VISIBLE_IN_REAL_PNL';
  } else {
    const before = new Set((observation.beforePositionIdsForInstrument || []).map(String));
    const newPositions = (pnlSnapshot.positions || []).filter((candidate) =>
      Number(candidate.instrumentId) === Number(observation.executionInstrumentId) &&
      !before.has(String(candidate.positionId))
    );
    if (newPositions.length === 1) {
      position = newPositions[0];
      proof = 'SINGLE_NEW_EXECUTION_POSITION_VISIBLE_IN_REAL_PNL';
    }
  }

  if (!position) return false;

  const requestTime = new Date(observation.requestObservedAt).getTime();
  const confirmedTime = new Date(pnlSnapshot.observedAt).getTime();
  const executionRate = Number(position.openRate || observation.brokerResponse?.executionRate);
  const virtualOrder = Number(observation.virtualOrderAmountUsd);
  const virtualInvested = Number(position.amountUsdVirtual);
  const fillRatio = Number.isFinite(virtualOrder) && virtualOrder > 0 && Number.isFinite(virtualInvested)
    ? virtualInvested / virtualOrder
    : null;
  const slippage = slippageBps('BUY', executionRate, observation.preSendQuote);

  observation.confirmation = {
    confirmedAt: pnlSnapshot.observedAt,
    proof,
    positionId: position.positionId,
    virtualInvestedAmountUsd: position.amountUsdVirtual,
    units: position.units,
    executionRateObserved: round(executionRate, 10),
    confirmationLatencyMs: Number.isFinite(requestTime) && Number.isFinite(confirmedTime)
      ? Math.max(0, confirmedTime - requestTime)
      : null,
    provenance: 'OBSERVED_REAL_AGENT_PNL'
  };
  observation.executionQuality = {
    preSendMid: observation.preSendQuote?.mid ?? null,
    preSendSpreadPct: observation.preSendQuote?.spreadPct ?? null,
    preSendQuoteAgeSeconds: observation.preSendQuote?.ageSeconds ?? null,
    executionRateObserved: round(executionRate, 10),
    slippageBps: round(slippage, 4),
    slippageSource: Number.isFinite(slippage)
      ? 'OBSERVED_OPEN_RATE_VS_RECENT_EXECUTION_INSTRUMENT_QUOTE'
      : 'UNAVAILABLE_OR_NONCOMPARABLE',
    virtualFillRatio: round(fillRatio, 10),
    virtualFillDeltaUsd: Number.isFinite(virtualInvested) && Number.isFinite(virtualOrder)
      ? round(virtualInvested - virtualOrder, 6)
      : null,
    brokerResponseLatencyMs: observation.brokerResponse?.latencyMs ?? null,
    portfolioConfirmationLatencyMs: observation.confirmation.confirmationLatencyMs
  };
  observation.copyEstimate = copyEstimateForObservation(observation, pnlSnapshot);
  observation.status = 'PORTFOLIO_CONFIRMED';
  state.counters.exactBuyConfirmations += 1;
  return true;
}

function confirmSellObservation(observation, pnlSnapshot) {
  const target = String(observation.targetPositionId || '');
  if (!target || !observation.targetPositionBefore) return false;
  if (pnlSnapshot.positionsById?.[target]) return false;

  const requestTime = new Date(observation.requestObservedAt).getTime();
  const confirmedTime = new Date(pnlSnapshot.observedAt).getTime();
  const responseRate = Number(observation.brokerResponse?.executionRate);
  const slippage = slippageBps('SELL', responseRate, observation.preSendQuote);
  const beforeCash = Number(observation.beforeCreditUsdVirtual);
  const afterCash = Number(pnlSnapshot.credit);
  const cashDelta = Number.isFinite(beforeCash) && Number.isFinite(afterCash)
    ? afterCash - beforeCash
    : null;

  observation.confirmation = {
    confirmedAt: pnlSnapshot.observedAt,
    proof: 'EXACT_TARGET_POSITION_ID_REMOVED_FROM_REAL_PNL',
    positionId: target,
    executionRateObserved: Number.isFinite(responseRate) ? round(responseRate, 10) : null,
    cashDeltaUsdVirtual: round(cashDelta, 6),
    confirmationLatencyMs: Number.isFinite(requestTime) && Number.isFinite(confirmedTime)
      ? Math.max(0, confirmedTime - requestTime)
      : null,
    provenance: 'OBSERVED_REAL_AGENT_PNL'
  };
  observation.executionQuality = {
    preSendMid: observation.preSendQuote?.mid ?? null,
    preSendSpreadPct: observation.preSendQuote?.spreadPct ?? null,
    preSendQuoteAgeSeconds: observation.preSendQuote?.ageSeconds ?? null,
    executionRateObserved: Number.isFinite(responseRate) ? round(responseRate, 10) : null,
    slippageBps: round(slippage, 4),
    slippageSource: Number.isFinite(slippage)
      ? 'OBSERVED_BROKER_CLOSE_RATE_VS_RECENT_EXECUTION_INSTRUMENT_QUOTE'
      : 'SELL_EXECUTION_RATE_NOT_OBSERVED',
    brokerResponseLatencyMs: observation.brokerResponse?.latencyMs ?? null,
    portfolioConfirmationLatencyMs: observation.confirmation.confirmationLatencyMs,
    cashDeltaUsdVirtual: round(cashDelta, 6),
    cashDeltaIsExecutionPriceProof: false
  };
  observation.copyEstimate = copyEstimateForObservation(observation, pnlSnapshot);
  observation.status = 'PORTFOLIO_CONFIRMED';
  state.counters.exactSellConfirmations += 1;
  return true;
}

function reconcileObservationsWithPnl(pnlSnapshot, baseFetch) {
  let changed = 0;
  for (const observation of state.observations) {
    if (!observation || observation.status === 'PORTFOLIO_CONFIRMED') continue;
    if (!observation.brokerResponse?.httpOk) continue;
    const confirmed = observation.side === 'SELL'
      ? confirmSellObservation(observation, pnlSnapshot)
      : confirmBuyObservation(observation, pnlSnapshot);
    if (confirmed) {
      changed += 1;
      log('EXECUTION_QUALITY_CONFIRMED', {
        observationId: observation.id,
        side: observation.side,
        asset: observation.asset,
        executionInstrumentId: observation.executionInstrumentId,
        slippageBps: observation.executionQuality?.slippageBps ?? null,
        virtualFillRatio: observation.executionQuality?.virtualFillRatio ?? null,
        copiedAmountSource: observation.copyEstimate?.copiedAmountSource || null
      });
    }
  }
  if (changed > 0) scheduleSave(baseFetch);
  return changed;
}

function ingestPnl(data, baseFetch) {
  const snapshot = extractPnlSnapshot(data);
  state.lastPnlSnapshot = snapshot;
  state.counters.pnlReadsObserved += 1;
  const changed = reconcileObservationsWithPnl(snapshot, baseFetch);
  scheduleSave(baseFetch);
  return { snapshot, reconciled: changed };
}

function calibrationRows() {
  return state.observations.filter((observation) =>
    observation.side === 'BUY' &&
    observation.status === 'PORTFOLIO_CONFIRMED' &&
    Number.isFinite(Number(observation.executionQuality?.virtualFillRatio)) &&
    Number(observation.executionQuality.virtualFillRatio) > 0 &&
    Number.isFinite(Number(observation.copyEstimate?.replicationRatioEstimate)) &&
    Number(observation.copyEstimate.replicationRatioEstimate) > 0
  );
}

function calibrationSummary() {
  const rows = calibrationRows();
  const fillRatios = rows.map((row) => Number(row.executionQuality.virtualFillRatio));
  const replicationRatios = rows.map((row) => Number(row.copyEstimate.replicationRatioEstimate));
  const fillMedian = median(fillRatios);
  const replicationMedian = median(replicationRatios);
  const targetCopiedPositionUsd = MIN_REAL_COPIED_POSITION_USD * (1 + REAL_COPY_REPLICATION_BUFFER_PCT / 100);
  const effectiveRatio = Number.isFinite(fillMedian) && Number.isFinite(replicationMedian)
    ? fillMedian * replicationMedian
    : null;
  const estimatedVirtualMinimum = Number.isFinite(effectiveRatio) && effectiveRatio > 0
    ? targetCopiedPositionUsd / effectiveRatio
    : null;
  const configuredCapitalUsd = configuredCopyCapitalUsd();
  const latestAgentValue = Number(state.lastPnlSnapshot?.agentPortfolioValueUsd);
  const currentTheoreticalRatio = configuredCapitalUsd > 0 && Number.isFinite(latestAgentValue) && latestAgentValue > 0
    ? configuredCapitalUsd / latestAgentValue
    : null;
  const currentTheoreticalMinimum = Number.isFinite(currentTheoreticalRatio) && currentTheoreticalRatio > 0
    ? targetCopiedPositionUsd / currentTheoreticalRatio
    : null;
  const enoughSamples = rows.length >= MIN_CALIBRATION_SAMPLES;

  return {
    version: VERSION,
    generatedAt: iso(),
    mode: MODE,
    status: enoughSamples ? 'READY_FOR_HUMAN_REVIEW_ESTIMATE_ONLY' : 'COLLECTING',
    observationsUsed: rows.length,
    minimumSamples: MIN_CALIBRATION_SAMPLES,
    directCopierObservationAvailable: false,
    calibrationLayer: 'AGENT_PORTFOLIO_OBSERVED__COPIER_LAYER_ESTIMATED',
    configuredCopyCapitalUsd: configuredCapitalUsd || null,
    targetCopiedPositionUsd: round(targetCopiedPositionUsd, 4),
    minimumRealCopiedPositionUsd: MIN_REAL_COPIED_POSITION_USD,
    replicationBufferPct: REAL_COPY_REPLICATION_BUFFER_PCT,
    medianVirtualFillRatioObserved: round(fillMedian, 10),
    medianReplicationRatioEstimate: round(replicationMedian, 10),
    currentTheoreticalMinimumVirtualOrderUsd: ceilCents(currentTheoreticalMinimum),
    estimatedCalibratedMinimumVirtualOrderUsd: enoughSamples ? ceilCents(estimatedVirtualMinimum) : null,
    estimateBeforeEnoughSamplesUsd: ceilCents(estimatedVirtualMinimum),
    recommendationSource: 'ESTIMATED_NOT_DIRECTLY_OBSERVED_ON_COPIER_ACCOUNT',
    automaticApplication: false,
    eligibleForAutomaticSizingChange: false,
    reviewRequired: true,
    caveat: 'Le portefeuille-agent est observé directement; le montant réellement copié sur le compte copieur ne l’est pas. Cette calibration reste une estimation tant qu’une source copier-side fiable n’est pas disponible.',
    governance: GOVERNANCE
  };
}

// Read-only operational diagnostics. Counts cover the retained observation window,
// while counters in statusPayload cover the whole persisted lifetime.
function observationReadiness(nowMs = Date.now()) {
  const observations = state.observations;
  const confirmed = observations.filter((row) => row?.status === 'PORTFOLIO_CONFIRMED');
  const awaiting = observations.filter((row) => row?.brokerResponse?.httpOk && row.status !== 'PORTFOLIO_CONFIRMED');
  const reviewAfterMs = 180 * 60 * 1000;
  const overdue = awaiting.filter((row) => {
    const at = Date.parse(row.requestObservedAt);
    return Number.isFinite(at) && nowMs - at >= reviewAfterMs;
  });
  const withoutResponse = observations.filter((row) => row?.status === 'ORDER_REQUEST_OBSERVED' && !row.brokerResponse);
  const rejected = observations.filter((row) => row?.brokerResponse?.httpOk === false);
  const missingSlippage = confirmed.filter((row) => !Number.isFinite(row.executionQuality?.slippageBps));
  const missingFill = confirmed.filter((row) => row.side === 'BUY' && !Number.isFinite(row.executionQuality?.virtualFillRatio));
  const missingSellProof = confirmed.filter((row) => row.side === 'SELL' &&
    row.confirmation?.proof !== 'EXACT_TARGET_POSITION_ID_REMOVED_FROM_REAL_PNL');
  const pnlObserved = state.counters.pnlReadsObserved > 0 || Boolean(state.lastPnlSnapshot?.observedAt);
  const status = !ENABLED ? 'DISABLED'
    : !pnlObserved ? 'NO_REAL_PNL_OBSERVED'
    : observations.length === 0 ? 'WAITING_FOR_ORDER'
    : overdue.length || missingSellProof.length ? 'REVIEW_REQUIRED'
    : awaiting.length || withoutResponse.length ? 'WAITING_FOR_CONFIRMATION'
    : 'OBSERVING';

  return {
    status,
    scope: 'RETAINED_OBSERVATIONS_ONLY',
    historyLimit: HISTORY_LIMIT,
    persistence: REDIS ? 'UPSTASH_CONFIGURED' : 'MEMORY_ONLY',
    realPnlObserved: pnlObserved,
    lastRealPnlObservedAt: state.lastPnlSnapshot?.observedAt || null,
    latestOrderObservedAt: observations.length ? observations[observations.length - 1]?.requestObservedAt || null : null,
    reviewAfterMinutes: 180,
    counts: {
      observedOrders: observations.length,
      confirmedPositions: confirmed.length,
      brokerHttpRejected: rejected.length,
      brokerResponseNotObserved: withoutResponse.length,
      brokerAcceptedAwaitingPortfolio: awaiting.length,
      awaitingPortfolioOverReviewAge: overdue.length,
      confirmedWithoutComparableSlippage: missingSlippage.length,
      confirmedBuysWithoutFillRatio: missingFill.length,
      confirmedSellsWithoutExactCloseProof: missingSellProof.length
    },
    caveat: 'HTTP success is not execution proof. An overdue observation requires review; it does not prove that an order failed. No order is created by this status.'
  };
}

function qualitySummary() {
  const confirmed = state.observations.filter((observation) => observation.status === 'PORTFOLIO_CONFIRMED');
  const slippages = confirmed
    .map((observation) => observation.executionQuality?.slippageBps)
    .filter(Number.isFinite);
  const responseLatencies = state.observations
    .map((observation) => observation.brokerResponse?.latencyMs)
    .filter(Number.isFinite);
  const confirmationLatencies = confirmed
    .map((observation) => observation.executionQuality?.portfolioConfirmationLatencyMs)
    .filter(Number.isFinite);

  const byAssetMap = {};
  for (const observation of confirmed) {
    const key = observation.asset || 'UNKNOWN';
    if (!byAssetMap[key]) byAssetMap[key] = { asset: key, confirmed: 0, slippageBps: [], fillRatios: [] };
    byAssetMap[key].confirmed += 1;
    if (Number.isFinite(observation.executionQuality?.slippageBps)) {
      byAssetMap[key].slippageBps.push(observation.executionQuality.slippageBps);
    }
    if (Number.isFinite(observation.executionQuality?.virtualFillRatio)) {
      byAssetMap[key].fillRatios.push(observation.executionQuality.virtualFillRatio);
    }
  }

  return {
    version: VERSION,
    generatedAt: iso(),
    mode: MODE,
    governance: GOVERNANCE,
    observationReadiness: observationReadiness(),
    counts: {
      observations: state.observations.length,
      confirmed: confirmed.length,
      confirmedBuys: confirmed.filter((observation) => observation.side === 'BUY').length,
      confirmedSells: confirmed.filter((observation) => observation.side === 'SELL').length,
      slippageSamples: slippages.length
    },
    executionQuality: {
      medianSlippageBps: round(median(slippages), 4),
      p90SlippageBps: round(quantile(slippages, 0.90), 4),
      medianBrokerResponseLatencyMs: round(median(responseLatencies), 2),
      medianPortfolioConfirmationLatencyMs: round(median(confirmationLatencies), 2),
      positiveSlippageBpsMeansWorseExecution: true,
      quoteMaxAgeSeconds: QUOTE_MAX_AGE_SECONDS
    },
    byAsset: Object.values(byAssetMap).map((row) => ({
      asset: row.asset,
      confirmed: row.confirmed,
      medianSlippageBps: round(median(row.slippageBps), 4),
      medianVirtualFillRatio: round(median(row.fillRatios), 10)
    })),
    latestConfirmed: confirmed.length ? confirmed[confirmed.length - 1] : null,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt
  };
}

function historyPayload(limit = 100) {
  const safeLimit = Math.max(1, Math.min(HISTORY_LIMIT, Number(limit) || 100));
  return {
    version: VERSION,
    mode: MODE,
    governance: GOVERNANCE,
    observations: state.observations.slice(-safeLimit),
    directCopierObservationAvailable: false
  };
}

async function statusPayload(baseFetch = installedAgent?.baseFetch || global.fetch) {
  if (typeof baseFetch === 'function') await loadState(baseFetch);
  return {
    ...qualitySummary(),
    persistent: REDIS,
    enabled: ENABLED,
    counters: { ...state.counters },
    copyCalibration: calibrationSummary()
  };
}

async function calibrationPayload(baseFetch = installedAgent?.baseFetch || global.fetch) {
  if (typeof baseFetch === 'function') await loadState(baseFetch);
  return calibrationSummary();
}

async function getHistory(limit = 100, baseFetch = installedAgent?.baseFetch || global.fetch) {
  if (typeof baseFetch === 'function') await loadState(baseFetch);
  return historyPayload(limit);
}

function installAgent(options = {}) {
  const baseFetch = options.fetch || global.fetch;
  if (typeof baseFetch !== 'function') {
    return { installed: false, reason: 'FETCH_UNAVAILABLE', version: VERSION };
  }

  async function wrappedFetch(input, init = {}) {
    const url = safeUrl(input);
    const method = methodOf(input, init);

    if (!ENABLED || !url || url.origin !== ETORO_ORIGIN) {
      return baseFetch(input, init);
    }

    if (method === 'POST' && url.pathname === REAL_ORDER_PATH) {
      const body = bodyObject(init);
      const isBuy = String(body?.action || '').toLowerCase() === 'open' &&
        String(body?.transaction || '').toLowerCase() === 'buy';

      if (isBuy) {
        await loadState(baseFetch);
        const observation = makeBuyObservation(body);
        state.counters.buyAttemptsObserved += 1;
        appendObservation(observation, baseFetch);
        log('BUY_REQUEST_OBSERVED', {
          observationId: observation.id,
          asset: observation.asset,
          executionInstrumentId: observation.executionInstrumentId,
          virtualOrderAmountUsd: observation.virtualOrderAmountUsd,
          quoteObserved: Boolean(observation.preSendQuote),
          providerCallsAdded: 0
        });

        // The exact broker request is forwarded unchanged. Shadow bookkeeping
        // never controls whether the order is sent.
        const response = await baseFetch(input, init);
        trackTask((async () => {
          let data = null;
          try { data = await response.clone().json(); } catch {}
          attachOrderResponse(observation, response, data, baseFetch);
        })());
        return response;
      }
    }

    if (method === 'POST' && url.pathname.startsWith(REAL_CLOSE_PREFIX)) {
      await loadState(baseFetch);
      const body = bodyObject(init);
      const observation = makeSellObservation(url, body);
      state.counters.sellAttemptsObserved += 1;
      appendObservation(observation, baseFetch);
      log('SELL_REQUEST_OBSERVED', {
        observationId: observation.id,
        asset: observation.asset,
        targetPositionId: observation.targetPositionId,
        fullCloseRequested: observation.fullCloseRequested,
        quoteObserved: Boolean(observation.preSendQuote),
        providerCallsAdded: 0
      });

      const response = await baseFetch(input, init);
      trackTask((async () => {
        let data = null;
        try { data = await response.clone().json(); } catch {}
        attachOrderResponse(observation, response, data, baseFetch);
      })());
      return response;
    }

    const response = await baseFetch(input, init);

    if (method === 'GET' && response?.ok) {
      if (url.pathname === RATES_PATH) {
        trackTask(response.clone().json()
          .then((data) => ingestRates(data, baseFetch))
          .catch(() => null));
      } else if (url.pathname === SEARCH_PATH) {
        trackTask(response.clone().json()
          .then((data) => learnSearchAlias(url, data, baseFetch))
          .catch(() => null));
      } else if (url.pathname === REAL_PNL_PATH) {
        trackTask(response.clone().json()
          .then((data) => ingestPnl(data, baseFetch))
          .catch(() => null));
      }
    }

    return response;
  }

  if (!options.fetch) global.fetch = wrappedFetch;

  installedAgent = {
    installed: true,
    enabled: ENABLED,
    version: VERSION,
    mode: MODE,
    baseFetch,
    fetch: wrappedFetch,
    governance: GOVERNANCE,
    status: () => statusPayload(baseFetch),
    history: (limit) => getHistory(limit, baseFetch),
    calibration: () => calibrationPayload(baseFetch)
  };

  global.__LEO_EXECUTION_QUALITY_SHADOW__ = installedAgent;
  loadState(baseFetch).catch(() => {});
  log('STARTED', {
    enabled: ENABLED,
    persistent: REDIS,
    placement: 'BEFORE_UCITS_BRIDGE',
    providerCallsAdded: 0,
    orderCallsAdded: 0,
    copyCalibrationAutoApply: false
  });

  return installedAgent;
}

const autoInstalled = process.env.EXECUTION_QUALITY_AUTO_INSTALL === 'false'
  ? null
  : installAgent();

module.exports = {
  VERSION,
  GOVERNANCE,
  WATCHLIST_BY_ID,
  EXECUTION_SYMBOL_TO_ASSET,
  quoteFromObject,
  extractPnlSnapshot,
  extractSafeExecutionResponse,
  slippageBps,
  calibrationSummary,
  qualitySummary,
  observationReadiness,
  installAgent,
  autoInstalled,
  _test: {
    freshState,
    normalizeState,
    getState: () => state,
    setState: (next) => { state = normalizeState(next); loaded = true; },
    resetState: () => { state = freshState(); loaded = true; },
    ingestRates,
    ingestPnl,
    learnSearchAlias,
    makeBuyObservation,
    makeSellObservation,
    attachOrderResponse,
    reconcileObservationsWithPnl,
    configuredCopyCapitalUsd,
    recentQuote,
    drainPendingTasks
  }
};
