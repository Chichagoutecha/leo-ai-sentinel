'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ETORO_UCITS_EXECUTION_MODE = 'off';
const bridge = require('./etoro-ucits-execution-bridge.js');

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function headers() {
  return {
    'x-api-key': 'public-test-key',
    'x-user-key': 'user-test-key',
    'x-request-id': '00000000-0000-4000-8000-000000000000',
    'content-type': 'application/json'
  };
}

function instrumentSearch(symbol, id) {
  return { items: [{ internalSymbolFull: symbol, instrumentId: id }] };
}

function rate(id, date = '2026-08-20T14:00:00.000Z') {
  return { rates: [{ instrumentId: id, bid: 100, ask: 100.1, date }] };
}

test('exactInstrumentMatch rejects partial/ambiguous search results', () => {
  assert.equal(bridge.exactInstrumentMatch({ items: [{ internalSymbolFull: 'CSPX', instrumentId: 1 }] }, 'CSPX.L'), null);
  assert.equal(bridge.exactInstrumentMatch({ items: [
    { internalSymbolFull: 'CSPX.L', instrumentId: 10 },
    { internalSymbolFull: 'CSPX.L', instrumentId: 11 }
  ] }, 'CSPX.L'), null);
  assert.equal(bridge.exactInstrumentMatch(instrumentSearch('CSPX.L', 99), 'cspx.l').instrumentId, 99);
});

test('guard mode blocks mapped US ETF BUY without sending order', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return jsonResponse({ ok: true }); };
  const installed = bridge.installBridge({ fetch: fakeFetch, mode: 'guard' });
  await assert.rejects(
    installed.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', {
      method: 'POST', headers: headers(), body: JSON.stringify({ action: 'open', transaction: 'buy', instrumentId: 3417, amount: 523.95, orderType: 'mkt', orderCurrency: 'usd', leverage: 1 })
    }),
    (error) => error?.code === 'UCITS_EXECUTION_GUARD_ACTIVE'
  );
  assert.equal(calls.length, 0);
});

test('live mode rewrites only instrumentId after exact resolution and fresh quote', async () => {
  const calls = [];
  const executionId = 990001;
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), init });
    if (u.pathname === '/api/v1/market-data/search') return jsonResponse(instrumentSearch('CSPX.L', executionId));
    if (u.pathname === '/api/v1/market-data/instruments/rates') return jsonResponse(rate(executionId));
    if (u.pathname === '/api/v2/trading/execution/orders') return jsonResponse({ orderId: 123 });
    throw new Error(`unexpected ${u}`);
  };
  const installed = bridge.installBridge({
    fetch: fakeFetch,
    mode: 'live',
    approvedSymbols: 'CSPX.L',
    now: () => new Date('2026-08-20T14:05:00.000Z')
  });
  const original = { action: 'open', transaction: 'buy', instrumentId: 3417, amount: 523.95, orderType: 'mkt', orderCurrency: 'usd', leverage: 1 };
  const response = await installed.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', {
    method: 'POST', headers: headers(), body: JSON.stringify(original)
  });
  assert.equal(response.status, 200);
  const orderCall = calls.find((call) => new URL(call.url).pathname === '/api/v2/trading/execution/orders');
  assert.ok(orderCall);
  const rewritten = JSON.parse(orderCall.init.body);
  assert.equal(rewritten.instrumentId, executionId);
  assert.equal(rewritten.amount, original.amount);
  assert.equal(rewritten.leverage, 1);
  assert.equal(rewritten.orderType, 'mkt');
  assert.equal(rewritten.orderCurrency, 'usd');
  assert.equal(rewritten.action, 'open');
  assert.equal(rewritten.transaction, 'buy');
});

test('live mode fails closed when symbol is not explicitly approved', async () => {
  let called = false;
  const fakeFetch = async () => { called = true; return jsonResponse({}); };
  const installed = bridge.installBridge({
    fetch: fakeFetch,
    mode: 'live',
    approvedSymbols: '',
    now: () => new Date('2026-08-20T14:05:00.000Z')
  });
  await assert.rejects(
    installed.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', {
      method: 'POST', headers: headers(), body: JSON.stringify({ action: 'open', transaction: 'buy', instrumentId: 3418, amount: 523.95 })
    }),
    (error) => error?.code === 'UCITS_SYMBOL_NOT_APPROVED'
  );
  assert.equal(called, false);
});

test('live mode fails closed on partial search match before order is sent', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push(u.pathname);
    if (u.pathname === '/api/v1/market-data/search') return jsonResponse(instrumentSearch('CSPX', 44));
    return jsonResponse({ orderId: 123 });
  };
  const installed = bridge.installBridge({
    fetch: fakeFetch,
    mode: 'live',
    approvedSymbols: 'CSPX.L',
    now: () => new Date('2026-08-20T14:05:00.000Z')
  });
  await assert.rejects(
    installed.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', {
      method: 'POST', headers: headers(), body: JSON.stringify({ action: 'open', transaction: 'buy', instrumentId: 3417, amount: 523.95 })
    }),
    (error) => error?.code === 'UCITS_SYMBOL_EXACT_MATCH_REQUIRED'
  );
  assert.deepEqual(calls, ['/api/v1/market-data/search']);
});

test('non-mapped BUY is passed through unchanged', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return jsonResponse({ orderId: 1 }); };
  const installed = bridge.installBridge({ fetch: fakeFetch, mode: 'guard' });
  await installed.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', {
    method: 'POST', headers: headers(), body: JSON.stringify({ action: 'open', transaction: 'buy', instrumentId: 100109, amount: 523.95 })
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).instrumentId, 100109);
});

test('REAL PnL aliases resolved UCITS execution ID back to analysis ID without duplicating position', async () => {
  const executionId = 990001;
  const fakeFetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/api/v1/trading/info/real/pnl') {
      return jsonResponse({ data: { clientPortfolio: { positions: [{ instrumentId: executionId, positionId: 777, amount: 500 }], ordersForOpen: [], ordersForClose: [] } } });
    }
    if (u.pathname === '/api/v1/market-data/search') {
      const symbol = u.searchParams.get('internalSymbolFull');
      if (symbol === 'CSPX.L') return jsonResponse(instrumentSearch(symbol, executionId));
      return jsonResponse({ items: [] });
    }
    throw new Error(`unexpected ${u}`);
  };
  const installed = bridge.installBridge({ fetch: fakeFetch, mode: 'guard' });
  const response = await installed.fetch('https://public-api.etoro.com/api/v1/trading/info/real/pnl', { method: 'GET', headers: headers() });
  const data = await response.json();
  const positions = data.data.clientPortfolio.positions;
  assert.equal(positions.length, 1);
  assert.equal(positions[0].instrumentId, 3417);
  assert.equal(positions[0].leoExecutionInstrumentId, executionId);
  assert.equal(positions[0].leoExecutionSymbol, 'CSPX.L');
  assert.equal(positions[0].positionId, 777);
});

test('venue guard recognizes LSE/Xetra overlap and closed hours', () => {
  assert.equal(bridge.isVenueOpen('CSPX.L', new Date('2026-08-20T14:05:00.000Z')), true);
  assert.equal(bridge.isVenueOpen('ZPDH.DE', new Date('2026-08-20T14:05:00.000Z')), true);
  assert.equal(bridge.isVenueOpen('CSPX.L', new Date('2026-08-20T17:00:00.000Z')), false);
  assert.equal(bridge.isVenueOpen('ZPDH.DE', new Date('2026-08-20T17:00:00.000Z')), false);
});
