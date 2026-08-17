'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let pnlPayload = { clientPortfolio: { credit: 9981.45, positions: [], ordersForOpen: [], orders: [] } };
let malformedPnl = false;
let locallyBlockNextOpen = false;
const providerCalls = [];

global.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  const method = String(init.method || input?.method || 'GET').toUpperCase();
  providerCalls.push({ url, method });
  if (url.includes('/trading/info/real/pnl')) {
    return new Response(malformedPnl ? 'not-json' : JSON.stringify(pnlPayload), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/market-open-orders/')) {
    if (locallyBlockNextOpen) {
      locallyBlockNextOpen = false;
      return new Response('{"errorCode":"LOCAL_OPEN_ORDER_CIRCUIT_BREAKER"}', { status: 409, headers: { 'content-type': 'application/json', 'x-leo-local-open-order-breaker': '1' } });
    }
    return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('', { status: 200 });
};

process.env.ETORO_EVIDENCE_NO_EFFECT_MIN_AGE_MS = '0';
process.env.ETORO_EVIDENCE_NO_EFFECT_MIN_SNAPSHOTS = '2';
const observer = require('./etoro-execution-evidence-observer.js');

const PNL = observer.PNL_REAL_URL;
const OPEN = observer.OPEN_BY_AMOUNT_URL;

test('pure snapshot comparison recognizes new position and new order evidence', () => {
  const before = observer.snapshotFromPnl({ clientPortfolio: { credit: 1000, positions: [], ordersForOpen: [] } }, 1);
  const withPosition = observer.snapshotFromPnl({ clientPortfolio: { credit: 990, positions: [{ positionId: 77, instrumentId: 3417 }], ordersForOpen: [] } }, 2);
  const withOrder = observer.snapshotFromPnl({ clientPortfolio: { credit: 990, positions: [], ordersForOpen: [{ orderId: 88, instrumentId: 3417 }] } }, 2);
  assert.equal(observer.compareEvidence({ baseline: before, instrumentId: 3417 }, withPosition).status, 'POSITION_EVIDENCE');
  assert.equal(observer.compareEvidence({ baseline: before, instrumentId: 3417 }, withOrder).status, 'ORDER_EVIDENCE');
});

test('observer correlates an existing OPEN with later P&L position evidence without adding calls', async () => {
  const beforeCalls = providerCalls.length;
  const baselineResponse = await global.fetch(PNL, { method: 'GET' });
  assert.equal(baselineResponse.status, 200);

  const openResponse = await global.fetch(OPEN, {
    method: 'POST',
    headers: { 'x-request-id': 'evidence-open-1' },
    body: JSON.stringify({ InstrumentId: 3417, Amount: 523.95, Leverage: 1, IsBuy: true })
  });
  assert.equal(openResponse.status, 200);

  pnlPayload = { clientPortfolio: { credit: 9457.5, positions: [{ positionId: 12345, instrumentId: 3417, amount: 523.95 }], ordersForOpen: [], orders: [] } };
  const afterResponse = await global.fetch(PNL, { method: 'GET' });
  assert.equal(afterResponse.status, 200);

  const state = global.__LEO_ETORO_EXECUTION_EVIDENCE_STATE__();
  assert.equal(state.lastEvidence.event, 'POSITION_EVIDENCE');
  assert.equal(state.lastEvidence.requestId, 'evidence-open-1');
  assert.equal(state.lastEvidence.confirmed, true);
  assert.equal(state.pendingOpen, null);
  assert.equal(state.stats.positionEvidence, 1);
  assert.equal(providerCalls.length - beforeCalls, 3, 'observer must not add any provider call');
  assert.equal(state.safety.providerCallsAdded, 0);
  assert.equal(state.safety.requestsBlocked, 0);
  assert.equal(state.safety.responsesMutated, 0);
});

test('locally blocked OPEN is ignored and never treated as pending execution', async () => {
  locallyBlockNextOpen = true;
  const beforeCalls = providerCalls.length;
  const response = await global.fetch(OPEN, {
    method: 'POST',
    headers: { 'x-request-id': 'evidence-local-block' },
    body: JSON.stringify({ InstrumentId: 3417, Amount: 523.95, Leverage: 1, IsBuy: true })
  });
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-leo-local-open-order-breaker'), '1');
  const state = global.__LEO_ETORO_EXECUTION_EVIDENCE_STATE__();
  assert.equal(state.pendingOpen, null);
  assert.equal(state.lastEvidence.event, 'LOCAL_BLOCK_IGNORED');
  assert.equal(state.stats.blockedOpenResponsesIgnored, 1);
  assert.equal(providerCalls.length - beforeCalls, 1);
});

test('repeated unchanged P&L snapshots produce non-definitive NO_EFFECT_OBSERVED', async () => {
  pnlPayload = { clientPortfolio: { credit: 9981.45, positions: [], ordersForOpen: [], orders: [] } };
  await global.fetch(PNL, { method: 'GET' });
  await global.fetch(OPEN, {
    method: 'POST',
    headers: { 'x-request-id': 'evidence-no-effect' },
    body: JSON.stringify({ InstrumentId: 3417, Amount: 523.95, Leverage: 1, IsBuy: true })
  });
  await global.fetch(PNL, { method: 'GET' });
  await global.fetch(PNL, { method: 'GET' });
  const state = global.__LEO_ETORO_EXECUTION_EVIDENCE_STATE__();
  assert.equal(state.lastEvidence.event, 'NO_EFFECT_OBSERVED');
  assert.equal(state.lastEvidence.definitive, false);
  assert.equal(state.lastEvidence.observedSnapshots, 2);
  assert.equal(state.pendingOpen, null);
  assert.equal(state.stats.noEffectObserved, 1);
});

test('malformed P&L stays fail-open and response body is unchanged', async () => {
  malformedPnl = true;
  const beforeCalls = providerCalls.length;
  const response = await global.fetch(PNL, { method: 'GET' });
  assert.equal(await response.text(), 'not-json');
  const state = global.__LEO_ETORO_EXECUTION_EVIDENCE_STATE__();
  assert.ok(state.stats.parseErrors >= 1);
  assert.equal(providerCalls.length - beforeCalls, 1);
  malformedPnl = false;
});

test('wrapper exposes no strategy, sizing or LIVE authority', () => {
  const state = global.__LEO_ETORO_EXECUTION_EVIDENCE_STATE__();
  assert.equal(state.safety.strategyModified, false);
  assert.equal(state.safety.sizingModified, false);
  assert.equal(state.safety.liveExecutionArmedModified, false);
  assert.equal(state.safety.canTrade, false);
  assert.equal(state.safety.canAuthorizeLive, false);
});
