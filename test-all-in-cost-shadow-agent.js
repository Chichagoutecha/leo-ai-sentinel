'use strict';

process.env.COST_SHADOW_AUTO_INSTALL = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const shadow = require('./all-in-cost-shadow-agent.js');

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

test('governance is strictly shadow-only', () => {
  assert.equal(shadow.GOVERNANCE.analysisOnly, true);
  assert.equal(shadow.GOVERNANCE.canPlaceOrder, false);
  assert.equal(shadow.GOVERNANCE.canBlockOrder, false);
  assert.equal(shadow.GOVERNANCE.canModifyOrder, false);
  assert.equal(shadow.GOVERNANCE.canModifyDecision, false);
  assert.equal(shadow.GOVERNANCE.canModifySizing, false);
  assert.equal(shadow.GOVERNANCE.originatesOrders, false);
});

test('exact instrument matching requires one exact symbol and unique id', () => {
  assert.equal(shadow.exactInstrumentMatch({ items: [
    { internalSymbolFull: 'CSPX.L', instrumentId: 111 },
    { internalSymbolFull: 'CSPX', instrumentId: 222 }
  ] }, 'CSPX.L'), 111);
  assert.equal(shadow.exactInstrumentMatch({ items: [
    { internalSymbolFull: 'CSPX.L', instrumentId: 111 },
    { internalSymbolFull: 'CSPX.L', instrumentId: 222 }
  ] }, 'CSPX.L'), null);
});

test('known UCITS cost estimate includes spread, slippage and holding cost', () => {
  const descriptor = shadow.assetDescriptor(15634);
  const result = shadow.buildCostEstimate({
    descriptor,
    executionRate: { bid: 99.9, ask: 100.1, mid: 100 },
    empiricalGrossEdgePct: null
  });
  assert.equal(result.shadowVerdict, 'SHADOW_UNCALIBRATED');
  assert.equal(result.unresolvedComponents.length, 0);
  assert.ok(result.allInCostPct > 0.2);
  assert.ok(result.holdingCostPct > 0);
});

test('unknown crypto broker fee stays explicit rather than assumed away', () => {
  const descriptor = shadow.assetDescriptor(100109);
  const result = shadow.buildCostEstimate({
    descriptor,
    executionRate: { bid: 99900, ask: 100100, mid: 100000 },
    empiricalGrossEdgePct: 2
  });
  assert.equal(result.allInCostPct, null);
  assert.ok(result.unresolvedComponents.includes('BROKER_TRANSACTION_FEE'));
  assert.equal(result.shadowVerdict, 'SHADOW_UNCALIBRATED');
});

test('calibrated edge can produce allow or too-expensive shadow verdict without enforcement', () => {
  const descriptor = shadow.assetDescriptor(15634);
  const allow = shadow.buildCostEstimate({ descriptor, executionRate: { bid: 99.95, ask: 100.05, mid: 100 }, empiricalGrossEdgePct: 1.5 });
  const reject = shadow.buildCostEstimate({ descriptor, executionRate: { bid: 99.5, ask: 100.5, mid: 100 }, empiricalGrossEdgePct: 0.4 });
  assert.equal(allow.shadowVerdict, 'SHADOW_ALLOW');
  assert.equal(reject.shadowVerdict, 'SHADOW_TOO_EXPENSIVE');
  assert.equal(shadow.GOVERNANCE.canBlockOrder, false);
});

test('wrapped BUY forwards the original request body byte-for-byte', async () => {
  shadow._test.resetState();
  const calls = [];
  const mockFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: String(init.method || 'GET').toUpperCase(), body: init.body ?? null });
    if (url.includes('/api/v1/market-data/search')) return jsonResponse({ items: [{ internalSymbolFull: 'CSPX.L', instrumentId: 555 }] });
    if (url.includes('/api/v1/market-data/instruments/rates')) return jsonResponse({ rates: [
      { instrumentId: 3417, bid: 599, ask: 601 },
      { instrumentId: 555, bid: 499, ask: 501 }
    ] });
    if (url === 'https://public-api.etoro.com/api/v2/trading/execution/orders') return jsonResponse({ orderId: 7 });
    throw new Error(`unexpected ${url}`);
  };
  const agent = shadow.installAgent({ fetch: mockFetch, installRoutes: false });
  const originalBody = JSON.stringify({ action: 'open', transaction: 'buy', instrumentId: 3417, orderType: 'mkt', amount: 523.95, orderCurrency: 'usd', leverage: 1 });
  const response = await agent.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', {
    method: 'POST', headers: { 'x-api-key': 'not-a-real-secret', 'x-user-key': 'not-a-real-secret' }, body: originalBody
  });
  assert.equal(response.ok, true);
  await shadow._test.drainPendingTasks();
  const orderCall = calls.find((call) => call.url === 'https://public-api.etoro.com/api/v2/trading/execution/orders');
  assert.equal(orderCall.body, originalBody);
  assert.equal(shadow._test.getState().observations.length, 1);
  assert.equal(shadow._test.getState().observations[0].asset, 'SPY');
});

test('shadow observation failure cannot block the existing order path', async () => {
  shadow._test.resetState();
  let orderCalls = 0;
  const mockFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v1/market-data/search')) throw new Error('shadow read failed');
    if (url === 'https://public-api.etoro.com/api/v2/trading/execution/orders') { orderCalls += 1; return jsonResponse({ orderId: 8 }); }
    return jsonResponse({});
  };
  const agent = shadow.installAgent({ fetch: mockFetch, installRoutes: false });
  const response = await agent.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', {
    method: 'POST', body: JSON.stringify({ action: 'open', transaction: 'buy', instrumentId: 3417, amount: 100, leverage: 1 })
  });
  assert.equal(response.ok, true);
  await shadow._test.drainPendingTasks();
  assert.equal(orderCalls, 1);
});

test('shadow reads do not delay the original order request', async () => {
  shadow._test.resetState();
  let releaseSearch;
  const searchGate = new Promise((resolve) => { releaseSearch = resolve; });
  let orderReached = false;
  const mockFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v1/market-data/search')) { await searchGate; return jsonResponse({ items: [{ internalSymbolFull: 'CSPX.L', instrumentId: 555 }] }); }
    if (url.includes('/api/v1/market-data/instruments/rates')) return jsonResponse({ rates: [{ instrumentId: 3417, bid: 599, ask: 601 }, { instrumentId: 555, bid: 499, ask: 501 }] });
    if (url === 'https://public-api.etoro.com/api/v2/trading/execution/orders') { orderReached = true; return jsonResponse({ orderId: 9 }); }
    return jsonResponse({});
  };
  const agent = shadow.installAgent({ fetch: mockFetch, installRoutes: false });
  const response = await agent.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', {
    method: 'POST', body: JSON.stringify({ action: 'open', transaction: 'buy', instrumentId: 3417, amount: 100, leverage: 1 })
  });
  assert.equal(response.ok, true);
  assert.equal(orderReached, true);
  releaseSearch();
  await shadow._test.drainPendingTasks();
});

test('mark-outs are recorded from later analysis-market rates', () => {
  const now = new Date('2026-08-23T12:00:00Z');
  shadow._test.setState({
    observations: [{
      id: 'x', asset: 'GLD', analysisInstrumentId: 15634,
      observedAt: '2026-08-22T11:00:00Z', analysisMidAtDecision: 100,
      costEstimate: { allInCostPct: 0.2, knownCostFloorPct: 0.2 }, markouts: {}
    }]
  });
  shadow.updateMarkoutsFromRates({ rates: [{ instrumentId: 15634, bid: 101.9, ask: 102.1 }] }, async () => jsonResponse({}), now);
  const markouts = shadow._test.getState().observations[0].markouts;
  assert.ok(markouts.h1);
  assert.ok(markouts.h6);
  assert.ok(markouts.h24);
  assert.equal(markouts.h72, undefined);
  assert.equal(markouts.h24.grossReturnPct, 2);
});
