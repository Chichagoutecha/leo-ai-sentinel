'use strict';

/**
 * LEO-AI SENTINEL v10.22.10.3 — passive execution evidence observer.
 *
 * Purpose: correlate an already-existing eToro OPEN request with subsequent
 * already-existing P&L reads. It never adds provider calls, never blocks a
 * request, never mutates a response and never authorizes LIVE execution.
 */

const VERSION = 'v10.22.10.3-execution-evidence-observer';
const PNL_REAL_URL = 'https://public-api.etoro.com/api/v1/trading/info/real/pnl';
const OPEN_BY_AMOUNT_URL = 'https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-amount';
const OPEN_BY_UNITS_URL = 'https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-units';
const OPEN_URLS = new Set([OPEN_BY_AMOUNT_URL, OPEN_BY_UNITS_URL].map((url) => url.toLowerCase()));
const BASELINE_MAX_AGE_MS = Math.max(10_000, Number(process.env.ETORO_EVIDENCE_BASELINE_MAX_AGE_MS || 300_000));
const NO_EFFECT_MIN_AGE_MS = Math.max(0, Number(process.env.ETORO_EVIDENCE_NO_EFFECT_MIN_AGE_MS || 60_000));
const NO_EFFECT_MIN_SNAPSHOTS = Math.max(2, Math.min(12, Number(process.env.ETORO_EVIDENCE_NO_EFFECT_MIN_SNAPSHOTS || 4)));

const originalFetch = global.fetch;
if (typeof originalFetch !== 'function') throw new Error('LEO execution evidence observer requires global fetch.');

let lastPnlSnapshot = null;
let pendingOpen = null;
let lastEvidence = null;
const stats = { pnlSnapshots: 0, openRequestsObserved: 0, blockedOpenResponsesIgnored: 0, positionEvidence: 0, orderEvidence: 0, noEffectObserved: 0, parseErrors: 0 };

function nowIso() { return new Date().toISOString(); }
function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(value || '').split('?')[0];
  }
}
function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return String(input?.url || input || '');
}
function requestMethod(input, init = {}) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}
function isPnlRead(url, method) {
  return String(method).toUpperCase() === 'GET' && normalizeUrl(url).toLowerCase() === PNL_REAL_URL.toLowerCase();
}
function isNewOpen(url, method) {
  return String(method).toUpperCase() === 'POST' && OPEN_URLS.has(normalizeUrl(url).toLowerCase());
}
function parseJsonMaybe(text) {
  try { return JSON.parse(String(text || '')); } catch { return null; }
}
function parseOpenBody(body) {
  if (typeof body !== 'string') return { instrumentId: null, amount: null, isBuy: null };
  const parsed = parseJsonMaybe(body);
  if (!parsed || typeof parsed !== 'object') return { instrumentId: null, amount: null, isBuy: null };
  return {
    instrumentId: parsed.InstrumentId ?? parsed.instrumentId ?? null,
    amount: Number.isFinite(Number(parsed.Amount ?? parsed.amount)) ? Number(parsed.Amount ?? parsed.amount) : null,
    isBuy: parsed.IsBuy ?? parsed.isBuy ?? null
  };
}
function firstValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  return null;
}
function rowId(row, kind) {
  const value = kind === 'position'
    ? firstValue(row, ['positionId','PositionId','positionID','PositionID','id','Id'])
    : firstValue(row, ['orderId','OrderId','orderID','OrderID','id','Id']);
  return value == null ? null : String(value);
}
function rowInstrumentId(row) {
  const direct = firstValue(row, ['instrumentId','InstrumentId','instrumentID','InstrumentID']);
  const nested = firstValue(row?.instrument || row?.market || {}, ['id','Id','instrumentId','InstrumentId']);
  const value = direct ?? nested;
  return value == null ? null : String(value);
}
function collectArrays(node, keyMatcher, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectArrays(item, keyMatcher, out, depth + 1);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value) && keyMatcher(key)) out.push(...value.filter((item) => item && typeof item === 'object'));
    if (value && typeof value === 'object') collectArrays(value, keyMatcher, out, depth + 1);
  }
  return out;
}
function numericCandidates(node, keys, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return [];
  if (Array.isArray(node)) return node.flatMap((item) => numericCandidates(item, keys, depth + 1));
  const values = [];
  for (const [key, value] of Object.entries(node)) {
    if (keys.has(String(key).toLowerCase()) && Number.isFinite(Number(value))) values.push(Number(value));
    else if (value && typeof value === 'object') values.push(...numericCandidates(value, keys, depth + 1));
  }
  return values;
}
function snapshotFromPnl(payload, capturedAtMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  const positions = collectArrays(payload, (key) => /^positions$/i.test(key));
  const orders = collectArrays(payload, (key) => /^(orders|ordersforopen|openorders)$/i.test(key));
  const positionIds = [...new Set(positions.map((row) => rowId(row, 'position')).filter(Boolean))].sort();
  const orderIds = [...new Set(orders.map((row) => rowId(row, 'order')).filter(Boolean))].sort();
  const positionsByInstrument = {};
  for (const row of positions) {
    const instrumentId = rowInstrumentId(row);
    if (!instrumentId) continue;
    positionsByInstrument[instrumentId] = (positionsByInstrument[instrumentId] || 0) + 1;
  }
  const ordersByInstrument = {};
  for (const row of orders) {
    const instrumentId = rowInstrumentId(row);
    if (!instrumentId) continue;
    ordersByInstrument[instrumentId] = (ordersByInstrument[instrumentId] || 0) + 1;
  }
  const credits = numericCandidates(payload, new Set(['credit','availablecash','cash']));
  return {
    capturedAtMs,
    capturedAt: new Date(capturedAtMs).toISOString(),
    positionIds,
    orderIds,
    positionsByInstrument,
    ordersByInstrument,
    credit: credits.length ? credits[0] : null
  };
}
function diffSet(before = [], after = []) {
  const prior = new Set(before);
  return after.filter((value) => !prior.has(value));
}
function compareEvidence(pending, after) {
  const before = pending?.baseline || null;
  if (!before || !after) return { status: 'INSUFFICIENT_BASELINE', confirmed: false, reason: 'No recent pre-order P&L baseline' };
  const newPositionIds = diffSet(before.positionIds, after.positionIds);
  const newOrderIds = diffSet(before.orderIds, after.orderIds);
  const instrumentKey = pending.instrumentId == null ? null : String(pending.instrumentId);
  const beforePositionCount = instrumentKey ? Number(before.positionsByInstrument[instrumentKey] || 0) : 0;
  const afterPositionCount = instrumentKey ? Number(after.positionsByInstrument[instrumentKey] || 0) : 0;
  const beforeOrderCount = instrumentKey ? Number(before.ordersByInstrument[instrumentKey] || 0) : 0;
  const afterOrderCount = instrumentKey ? Number(after.ordersByInstrument[instrumentKey] || 0) : 0;

  if (newPositionIds.length > 0 || afterPositionCount > beforePositionCount) {
    return { status: 'POSITION_EVIDENCE', confirmed: true, newPositionIds, newOrderIds, beforePositionCount, afterPositionCount, beforeOrderCount, afterOrderCount };
  }
  if (newOrderIds.length > 0 || afterOrderCount > beforeOrderCount) {
    return { status: 'ORDER_EVIDENCE', confirmed: true, newPositionIds, newOrderIds, beforePositionCount, afterPositionCount, beforeOrderCount, afterOrderCount };
  }
  const creditDelta = Number.isFinite(before.credit) && Number.isFinite(after.credit) ? after.credit - before.credit : null;
  return { status: 'NO_POSITION_OR_ORDER_EFFECT_YET', confirmed: false, newPositionIds, newOrderIds, beforePositionCount, afterPositionCount, beforeOrderCount, afterOrderCount, creditDelta };
}
function publishEvidence(event, details = {}, level = 'log') {
  lastEvidence = { component: 'LEO_ETORO_EXECUTION_EVIDENCE', version: VERSION, event, at: nowIso(), ...details };
  (console[level] || console.log)(`[LEO_ETORO_EXECUTION_EVIDENCE] ${JSON.stringify(lastEvidence)}`);
}
function requestIdFrom(input, init = {}) {
  const headers = init?.headers || input?.headers;
  if (!headers) return null;
  try { if (typeof headers.get === 'function') return headers.get('x-request-id'); } catch {}
  if (Array.isArray(headers)) {
    const row = headers.find(([key]) => String(key).toLowerCase() === 'x-request-id');
    return row ? String(row[1]) : null;
  }
  for (const [key, value] of Object.entries(headers || {})) if (String(key).toLowerCase() === 'x-request-id') return String(value);
  return null;
}

async function inspectPnlResponse(response) {
  let text;
  try { text = await response.clone().text(); }
  catch { stats.parseErrors += 1; return; }
  const parsed = parseJsonMaybe(text);
  const snapshot = snapshotFromPnl(parsed);
  if (!snapshot) { stats.parseErrors += 1; return; }
  stats.pnlSnapshots += 1;
  lastPnlSnapshot = snapshot;
  if (!pendingOpen) return;

  pendingOpen.observedSnapshots += 1;
  const evidence = compareEvidence(pendingOpen, snapshot);
  const ageMs = Math.max(0, Date.now() - pendingOpen.startedAtMs);
  if (evidence.status === 'POSITION_EVIDENCE') {
    stats.positionEvidence += 1;
    publishEvidence('POSITION_EVIDENCE', { requestId: pendingOpen.requestId, instrumentId: pendingOpen.instrumentId, amount: pendingOpen.amount, ageMs, ...evidence });
    pendingOpen = null;
    return;
  }
  if (evidence.status === 'ORDER_EVIDENCE') {
    stats.orderEvidence += 1;
    publishEvidence('ORDER_EVIDENCE', { requestId: pendingOpen.requestId, instrumentId: pendingOpen.instrumentId, amount: pendingOpen.amount, ageMs, ...evidence });
    pendingOpen = null;
    return;
  }
  if (pendingOpen.observedSnapshots >= NO_EFFECT_MIN_SNAPSHOTS && ageMs >= NO_EFFECT_MIN_AGE_MS) {
    stats.noEffectObserved += 1;
    publishEvidence('NO_EFFECT_OBSERVED', { requestId: pendingOpen.requestId, instrumentId: pendingOpen.instrumentId, amount: pendingOpen.amount, ageMs, observedSnapshots: pendingOpen.observedSnapshots, definitive: false, ...evidence }, 'warn');
    pendingOpen = null;
  }
}

global.fetch = async function leoExecutionEvidenceFetch(input, init = {}) {
  const url = requestUrl(input);
  const method = requestMethod(input, init);
  const pnlRead = isPnlRead(url, method);
  const newOpen = isNewOpen(url, method);
  const openBody = newOpen ? parseOpenBody(init?.body) : null;
  const baseline = newOpen && lastPnlSnapshot && (Date.now() - lastPnlSnapshot.capturedAtMs <= BASELINE_MAX_AGE_MS)
    ? lastPnlSnapshot
    : null;

  const response = await originalFetch(input, init);

  if (newOpen) {
    const locallyBlocked = response?.headers?.get?.('x-leo-local-open-order-breaker') === '1';
    if (locallyBlocked) {
      stats.blockedOpenResponsesIgnored += 1;
      publishEvidence('LOCAL_BLOCK_IGNORED', { requestId: requestIdFrom(input, init), instrumentId: openBody.instrumentId, amount: openBody.amount, providerCallAdded: false });
    } else {
      stats.openRequestsObserved += 1;
      pendingOpen = {
        requestId: requestIdFrom(input, init),
        instrumentId: openBody.instrumentId,
        amount: openBody.amount,
        isBuy: openBody.isBuy,
        startedAtMs: Date.now(),
        startedAt: nowIso(),
        httpStatus: Number(response?.status || 0),
        baseline,
        observedSnapshots: 0
      };
      publishEvidence('OPEN_REQUEST_OBSERVED', { requestId: pendingOpen.requestId, instrumentId: pendingOpen.instrumentId, amount: pendingOpen.amount, httpStatus: pendingOpen.httpStatus, baselineAvailable: Boolean(baseline), providerCallAdded: false });
    }
  }

  if (pnlRead) await inspectPnlResponse(response);
  return response;
};

global.__LEO_ETORO_EXECUTION_EVIDENCE_STATE__ = () => ({
  version: VERSION,
  lastPnlSnapshot,
  pendingOpen,
  lastEvidence,
  stats: { ...stats },
  safety: {
    providerCallsAdded: 0,
    requestsBlocked: 0,
    responsesMutated: 0,
    strategyModified: false,
    sizingModified: false,
    liveExecutionArmedModified: false,
    canTrade: false,
    canAuthorizeLive: false
  }
});

console.log(`[LEO_ETORO_EXECUTION_EVIDENCE] ${JSON.stringify({ component:'LEO_ETORO_EXECUTION_EVIDENCE', version:VERSION, event:'STARTED', providerCallsAdded:0, requestsBlocked:0, responsesMutated:0, liveExecutionArmedModified:false })}`);

module.exports = { VERSION, PNL_REAL_URL, OPEN_BY_AMOUNT_URL, OPEN_BY_UNITS_URL, isPnlRead, isNewOpen, parseOpenBody, snapshotFromPnl, compareEvidence };
