'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
global.fetch = async (input, init = {}) => {
  calls.push({ url: String(input), method: String(init.method || 'GET').toUpperCase() });
  return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
};

process.env.ETORO_EMPTY_2XX_BREAKER_MINUTES = '720';
const diagnostics = require('./etoro-execution-diagnostics-v10.22.10.js');

const OPEN_URL = 'https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-amount';
const CLOSE_URL = 'https://public-api.etoro.com/api/v1/trading/execution/positions/close';

test('route classifier scopes breaker to new open orders only', () => {
  assert.equal(diagnostics.isEtoroExecutionRequest(OPEN_URL, 'POST'), true);
  assert.equal(diagnostics.isEtoroNewOpenOrderRequest(OPEN_URL, 'POST'), true);
  assert.equal(diagnostics.executionIntent(OPEN_URL, 'POST'), 'OPEN_NEW_POSITION');

  assert.equal(diagnostics.isEtoroExecutionRequest(CLOSE_URL, 'POST'), true);
  assert.equal(diagnostics.isEtoroNewOpenOrderRequest(CLOSE_URL, 'POST'), false);
  assert.equal(diagnostics.executionIntent(CLOSE_URL, 'POST'), 'NON_OPEN_EXECUTION_ALLOWED');
});

test('ambiguous open arms breaker, next open is blocked locally, close still reaches eToro', async () => {
  const firstOpen = await global.fetch(OPEN_URL, {
    method: 'POST',
    headers: { 'x-request-id': 'test-open-1' },
    body: JSON.stringify({ InstrumentId: 3417, Amount: 10, Leverage: 1, IsBuy: true })
  });
  assert.equal(firstOpen.status, 200);
  assert.equal(calls.length, 1);

  const stateAfterAmbiguity = global.__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__();
  assert.equal(stateAfterAmbiguity.breakerActive, true);
  assert.equal(stateAfterAmbiguity.breakerScope, 'NEW_OPEN_ORDERS_ONLY');
  assert.equal(stateAfterAmbiguity.closeAndReduceRoutesNeverBlocked, true);

  const secondOpen = await global.fetch(OPEN_URL, {
    method: 'POST',
    headers: { 'x-request-id': 'test-open-2' },
    body: JSON.stringify({ InstrumentId: 3417, Amount: 10, Leverage: 1, IsBuy: true })
  });
  assert.equal(secondOpen.status, 409);
  assert.equal(calls.length, 1, 'second OPEN must be blocked before the provider');

  const close = await global.fetch(CLOSE_URL, {
    method: 'POST',
    headers: { 'x-request-id': 'test-close-1' },
    body: JSON.stringify({ PositionId: 123456, UnitsToDeduct: 1 })
  });
  assert.equal(close.status, 200);
  assert.equal(calls.length, 2, 'close/reduce execution must still reach the provider while breaker is active');
  assert.equal(calls[1].url, CLOSE_URL);
});

test('response classifier keeps 2xx empty responses explicitly ambiguous', () => {
  const result = diagnostics.classifyExecutionResponse({ status: 200 }, '');
  assert.equal(result.classification, 'HTTP_2XX_EMPTY_BODY');
  assert.equal(result.ambiguous, true);
  assert.equal(result.businessAcknowledged, false);
});
