'use strict';
// Read-only, deterministic normalization. No order, cancellation or automatic resend capability.
const { randomUUID } = require('node:crypto');
const ROOT = 'https://public-api.etoro.com';
const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const id = v => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 || typeof v === 'string' && /^[1-9][0-9]{0,25}$/.test(v)) ? String(v) : null;
const near = (a, b) => a !== null && b !== null && Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-7);
const sum = rows => rows.every(v => v !== null) ? rows.reduce((a, b) => a + b, 0) : null;
const CLOSE = { 1: 'PENDING', 2: 'PENDING', 3: 'FILLED', 4: 'REJECTED', 5: 'PARTIALLY_FILLED', 6: 'PENDING', 7: 'CANCELED', 8: 'EXPIRED', 9: 'PARTIALLY_FILLED_TERMINAL', 10: 'PARTIALLY_FILLED_TERMINAL', 11: 'PENDING' };
const TERMINAL = new Set([3, 4, 7, 8, 9, 10]);
function unknown(reason = 'LOOKUP_NOT_AVAILABLE') { return { version: 1, state: 'UNKNOWN', terminal: null, complete: false, verifiedForIntent: false, reason,
  requestedAmount: null, requestedUnits: null, executedUnits: null, executedAmount: null, observedFees: null,
  remainingUnits: null, remainingRequestedAmount: null, observedFrozenAmount: null, executions: [], binding: 'UNVERIFIED',
  commitment: { status: 'UNKNOWN', additionalCashDeductionUsd: 0, basis: 'NO_CASH_MUTATION; RESERVATION_OVERLAP_NOT_ASSUMED' } }; }
function contextFromPortfolio(response) {
  const root = response?.data || {}, c = root.clientPortfolio || {}, result = {};
  for (const key of ['accountId', 'portfolioId', 'gcid', 'CID']) {
    const candidates = [c[key], root[key]].map(id).filter(Boolean);
    if (new Set(candidates).size > 1) return {}; // Contradictory account metadata cannot be cherry-picked.
    if (candidates.length && new Set(candidates).size === 1) result[key] = candidates[0];
  }
  return result;
}
function normalizeLookup(data, expected, now = Date.now()) {
  const out = unknown(); out.checkedAt = new Date(now).toISOString();
  const fail = reason => ({ ...out, state: 'UNKNOWN', terminal: null, complete: false, verifiedForIntent: false, reason,
    reviewRequired: /MISMATCH|CONTRADICT|EXCEEDS|AMBIGUOUS/.test(reason) });
  if (!data || typeof data !== 'object' || Array.isArray(data) || !['BUY', 'SELL'].includes(expected?.side) || expected.environment !== 'REAL') return fail('CONTEXT_OR_SCHEMA_UNAVAILABLE');
  const buy = expected.side === 'BUY', orderId = id(buy ? data.orderId : data.orderID), requestedOrder = id(expected.orderId);
  if (!orderId || requestedOrder && requestedOrder !== orderId || !requestedOrder && expected.referenceLookupVerified !== true) return fail('ORDER_BINDING_MISMATCH');
  if (id(buy ? data.asset?.instrumentId : data.instrumentID) !== id(expected.instrumentId)) return fail('INSTRUMENT_BINDING_MISMATCH');
  const account = expected.account || {}, fields = buy ? ['accountId', 'portfolioId', 'gcid'] : ['CID'];
  const available = fields.filter(k => id(account[k]));
  if (!available.length || available.some(k => id(data[k]) !== id(account[k]))) return fail('ACCOUNT_BINDING_UNVERIFIED_OR_MISMATCH');
  if (buy && (data.action !== 'open' || data.transaction !== 'buy' || data.asset?.side !== 'long' || data.asset?.leverage !== 1 || !['underlying', 'Underlying'].includes(data.asset?.settlementType) || String(data.orderCurrency).toUpperCase() !== 'USD' || String(data.asset?.currency).toUpperCase() !== 'USD')) return fail('PRODUCT_OR_CURRENCY_MISMATCH');
  out.binding = 'MATCH'; out.accountContext = Object.fromEntries(available.map(k => [k, id(account[k])])); out.orderId = orderId; out.instrumentId = expected.instrumentId;
  out.effectiveAt = buy && Number.isFinite(Date.parse(data.lastUpdate)) ? data.lastUpdate : null;
  out.requestedAmount = num(expected.requestedAmount); out.requestedUnits = num(expected.requestedUnits);
  if (buy && (out.requestedAmount !== null && !near(num(data.requestedAmount), out.requestedAmount) || out.requestedUnits !== null && !near(num(data.requestedUnits), out.requestedUnits))) return fail('REQUESTED_SIZE_MISMATCH');
  const statusId = buy ? data.status?.id : data.statusID;
  // Only the Filled id/name pair is documented in the current v2 lookup example.
  // Do not apply the legacy CLOSE numeric enum to OPEN orders.
  let state = buy ? (statusId === 3 && data.status?.name === 'Filled' ? 'FILLED' : 'UNKNOWN') : CLOSE[statusId];
  if (!state) return fail('UNDOCUMENTED_STATUS');
  if (buy && statusId === 3 && data.status?.name !== 'Filled') return fail('CONTRADICTORY_STATUS');
  const raw = buy ? data.positionExecutions : data.positions;
  if (!Array.isArray(raw) || raw.length > 100) return fail('EXECUTIONS_MISSING_OR_OVERFLOW');
  const seen = new Set();
  for (const row of raw) {
    const pid = id(buy ? row?.positionId : row?.positionID), execution = buy ? row?.openingData : row;
    if (!pid || seen.has(pid) || !execution || buy && id(execution.orderId) !== orderId) return fail('EXECUTION_IDENTITY_AMBIGUOUS');
    seen.add(pid);
    if (!buy && pid !== id(expected.positionId)) return fail('UNEXPECTED_CLOSE_TARGET');
    const units = num(execution.units), price = num(buy ? execution.avgPrice : execution.rate);
    const time = buy ? execution.executionTime : execution.occurred;
    if (units === null || units <= 0 || !Number.isFinite(Date.parse(time)) || Date.parse(time) > now) return fail('EXECUTION_UNITS_OR_DATE_UNAVAILABLE');
    out.executions.push({ positionId: pid, units, price, executedAt: time, fees: buy ? num(execution.fees) : null,
      reportedAmount: buy ? null : num(execution.amount), reportedAmountCurrency: buy ? 'USD' : 'UNKNOWN' });
  }
  out.executedUnits = sum(out.executions.map(r => r.units));
  // Executed principal is derived from documented per-order USD fills; costs remain separate.
  out.executedAmount = buy ? sum(out.executions.map(r => r.price === null ? null : r.units * r.price)) : null;
  out.executedAmountBasis = buy ? 'DERIVED_FROM_ORDER_LINKED_USD_FILLS' : 'UNAVAILABLE_CLOSE_CURRENCY_NOT_PROVEN';
  out.observedFees = buy && out.executions.length ? sum(out.executions.map(r => r.fees)) : null;
  out.observedTotalCosts = buy ? num(data.totalCosts) : null; // Not added to fees a second time.
  out.reportedProceeds = buy ? null : num(data.proceeds); out.reportedProceedsCurrency = 'UNKNOWN';
  out.observedFrozenAmount = buy ? num(data.frozenAmount) : null;
  const terminal = buy ? (state === 'FILLED' ? true : null) : TERMINAL.has(statusId);
  if (out.requestedUnits !== null && out.executedUnits > out.requestedUnits + 1e-8 || buy && out.requestedAmount !== null && out.executedAmount !== null && out.executedAmount > out.requestedAmount + Math.max(0.01, out.requestedAmount * 1e-7)) return fail('EXECUTED_EXCEEDS_REQUESTED');
  if (state === 'REJECTED' && out.executedUnits > 0 || ['CANCELED', 'EXPIRED'].includes(state) && out.executedUnits > 0 || state === 'PARTIALLY_FILLED_TERMINAL' && !(out.executedUnits > 0)) return fail('STATUS_EXECUTIONS_CONTRADICTORY');
  const matches = buy ? (out.requestedAmount !== null ? near(out.executedAmount, out.requestedAmount) : near(out.executedUnits, out.requestedUnits)) : near(out.executedUnits, out.requestedUnits);
  if (state === 'FILLED' && (!matches || out.executedUnits <= 0)) return fail('FILLED_QUANTITY_NOT_PROVEN');
  if (!terminal && out.executedUnits > 0) state = 'PARTIALLY_FILLED';
  out.state = state; out.terminal = terminal; out.complete = state === 'FILLED'; out.verifiedForIntent = true; out.reason = null;
  out.remainingUnits = out.requestedUnits === null ? null : Math.max(0, out.requestedUnits - out.executedUnits);
  out.remainingRequestedAmount = buy && out.requestedAmount !== null && out.executedAmount !== null ? Math.max(0, out.requestedAmount - out.executedAmount) : null;
  out.commitment = { ...out.commitment, status: terminal ? 'RELEASED_ORDER_TERMINAL' : 'PENDING_OR_UNKNOWN',
    unexecutedRequestedAmountUsd: out.remainingRequestedAmount, observedFrozenAmountUsd: out.observedFrozenAmount,
    remainingExecutionPossible: !terminal };
  return out;
}
function monotonic(previous, next) {
  if (previous?.reviewRequired) return previous;
  previous = previous?.verifiedForIntent ? previous : previous?.lastVerified;
  if (!next.verifiedForIntent) return previous ? { ...next, lastVerified: previous } : next;
  if (!previous?.verifiedForIntent) return next;
  if (previous.orderId !== next.orderId || next.executedUnits < previous.executedUnits - 1e-8 || near(previous.executedUnits, next.executedUnits) && previous.executedAmount !== null && next.executedAmount !== null && !near(previous.executedAmount, next.executedAmount) || previous.terminal && (!next.terminal || previous.state !== next.state || !near(previous.executedUnits, next.executedUnits))) return { ...unknown('CORRECTED_OR_REGRESSING_ORDER_REQUIRES_REVIEW'), lastVerified: previous, reviewRequired: true };
  return next;
}
function positionProof({ side, beforeSnapshot, afterSnapshot, progress, expectedPositionId }) {
  const no = reason => ({ matched: false, reason });
  if (progress?.verifiedForIntent !== true || progress.binding !== 'MATCH') return no('ORDER_FINALITY_UNVERIFIED');
  if (beforeSnapshot?.instrumentId !== afterSnapshot?.instrumentId || progress.instrumentId !== afterSnapshot?.instrumentId) return no('SNAPSHOT_INSTRUMENT_MISMATCH');
  const before = beforeSnapshot?.positionDetails, after = afterSnapshot?.positionDetails;
  if (!Array.isArray(before) || !Array.isArray(after)) return no('SNAPSHOT_DETAILS_MISSING');
  for (const rows of [before, after]) if (rows.some(r => !id(r.positionId) || num(r.units) === null || r.units <= 0) || new Set(rows.map(r => id(r.positionId))).size !== rows.length) return no('SNAPSHOT_IDENTITY_AMBIGUOUS');
  const b = new Map(before.map(r => [id(r.positionId), r.units])), a = new Map(after.map(r => [id(r.positionId), r.units]));
  const fills = new Map(progress.executions.map(r => [r.positionId, r.units]));
  if (side === 'BUY') {
    if (!fills.size || [...fills].some(([pid, units]) => !near((a.get(pid) ?? 0) - (b.get(pid) ?? 0), units)) || [...new Set([...b.keys(), ...a.keys()])].some(pid => !fills.has(pid) && !near(b.get(pid) ?? 0, a.get(pid) ?? 0))) return no('OPEN_FILL_PORTFOLIO_MISMATCH');
  } else {
    const target = id(expectedPositionId), requested = num(progress.requestedUnits);
    if (!target || !near(b.get(target) ?? null, requested) || !near((b.get(target) ?? 0) - (a.get(target) ?? 0), progress.executedUnits) || [...fills].some(([pid]) => pid !== target) || [...new Set([...b.keys(), ...a.keys()])].some(pid => pid !== target && !near(b.get(pid) ?? 0, a.get(pid) ?? 0))) return no('CLOSE_FILL_PORTFOLIO_MISMATCH');
  }
  return { matched: true, remainingPositionUnits: side === 'SELL' ? a.get(id(expectedPositionId)) ?? 0 : null };
}
function createReadClient({ headers, fetchImpl = global.fetch, clock = Date.now, timeoutMs = 5000 } = {}) {
  const calls = [], last = new Map(); let denied = false, nextAllowedAt = 0;
  async function read(expected) {
    const now = clock(), key = expected?.intentId;
    if (expected?.environment !== 'REAL') return unknown('REAL_LOOKUP_ONLY');
    if (expected.method !== undefined && expected.method !== 'GET' || expected.endpoint !== undefined || expected.url !== undefined) return unknown('READ_NOT_ALLOWED');
    if (!['BUY', 'SELL'].includes(expected.side)) return unknown('READ_NOT_ALLOWED');
    if (!(expected.side === 'BUY' ? ['accountId', 'portfolioId', 'gcid'] : ['CID']).some(k => id(expected.account?.[k]))) return unknown('ACCOUNT_BINDING_REQUIRED_BEFORE_LOOKUP');
    if (denied) return unknown('AUTHORIZATION_REVIEW_REQUIRED');
    if (!key || last.has(key) && now - last.get(key) < 10000 || now < nextAllowedAt) return unknown('LOOKUP_COOLDOWN');
    while (calls.length && now - calls[0] >= 60000) calls.shift();
    for (const [k, at] of last) if (now - at >= 60000) last.delete(k);
    if (calls.length >= 6) return unknown('LOCAL_SHARED_QUOTA_RESERVE');
    const orderId = id(expected.orderId), referenceId = expected.referenceId;
    if (!orderId && (expected.side !== 'BUY' || typeof referenceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(referenceId))) return unknown('ORDER_REFERENCE_UNAVAILABLE');
    const path = expected.side === 'BUY' ? '/api/v2/trading/info/orders:lookup?' + (orderId ? 'orderId=' + orderId : 'referenceId=' + encodeURIComponent(referenceId)) : '/api/v1/trading/info/real/close-orders/' + orderId;
    const auth = headers?.();
    if (!auth?.['x-api-key'] || !auth?.['x-user-key']) return unknown('CREDENTIALS_ABSENT');
    calls.push(now); last.set(key, now);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(10000, Math.max(1, timeoutMs)));
    try {
      const response = await fetchImpl(ROOT + path, { method: 'GET', redirect: 'error', headers: { ...auth, 'x-request-id': randomUUID() }, signal: controller.signal });
      if (response.status === 401 || response.status === 403) denied = true;
      if (response.status === 429) nextAllowedAt = now + 60000;
      if (!response.ok) return { ...unknown('LOOKUP_HTTP_' + response.status), httpStatus: response.status,
        reviewRequired: response.status === 401 || response.status === 403 };
      const body = await response.json();
      return { ...normalizeLookup(body, { ...expected, referenceLookupVerified: !orderId }, now), source: ROOT + path.split('?')[0], httpStatus: response.status };
    } catch { return unknown('LOOKUP_NETWORK_OR_SCHEMA_ERROR'); }
    finally { clearTimeout(timer); }
  }
  return { read };
}
module.exports = { unknown, contextFromPortfolio, normalizeLookup, monotonic, positionProof, createReadClient };
