'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const providerCalls = [];
global.fetch = async (input, init = {}) => {
  providerCalls.push({
    url: String(input?.url || input),
    method: String(init.method || input?.method || 'GET').toUpperCase()
  });
  return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
};

process.env.ETORO_EMPTY_2XX_BREAKER_MINUTES = '720';
const diagnostics = require('./etoro-execution-diagnostics-v10.22.10.js');

const OPEN_BY_AMOUNT_URL = 'https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-amount';
const OPEN_BY_UNITS_URL = 'https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-units';
const CLOSE_URL = 'https://public-api.etoro.com/api/v1/trading/execution/market-close-orders/positions/12345678';
const READ_URL = 'https://public-api.etoro.com/api/v1/trading/info/real/pnl';

test('route classifier matches official eToro open/close families', () => {
  for (const url of [OPEN_BY_AMOUNT_URL, OPEN_BY_UNITS_URL]) {
    assert.equal(diagnostics.isEtoroExecutionRequest(url, 'POST'), true);
    assert.equal(diagnostics.isEtoroNewOpenOrderRequest(url, 'POST'), true);
    assert.equal(diagnostics.executionIntent(url, 'POST'), 'OPEN_NEW_POSITION');
  }

  assert.equal(diagnostics.isEtoroExecutionRequest(CLOSE_URL, 'POST'), true);
  assert.equal(diagnostics.isEtoroNewOpenOrderRequest(CLOSE_URL, 'POST'), false);
  assert.equal(diagnostics.executionIntent(CLOSE_URL, 'POST'), 'NON_OPEN_EXECUTION_ALLOWED');

  assert.equal(diagnostics.isEtoroExecutionRequest(READ_URL, 'GET'), false);
  assert.equal(diagnostics.isEtoroNewOpenOrderRequest(READ_URL, 'GET'), false);
  assert.equal(diagnostics.executionIntent(READ_URL, 'GET'), 'NON_EXECUTION');
});

test('close ambiguity never arms breaker; open ambiguity does; close still reaches provider', async () => {
  const firstClose = await global.fetch(CLOSE_URL, {
    method: 'POST',
    headers: { 'x-request-id': 'test-close-before-breaker' },
    body: JSON.stringify({ UnitsToDeduct: null })
  });
  assert.equal(firstClose.status, 200);
  assert.equal(providerCalls.length, 1);

  const stateAfterCloseAmbiguity = global.__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__();
  assert.equal(stateAfterCloseAmbiguity.breakerActive, false, 'ambiguous CLOSE must never arm the open-order breaker');
  assert.equal(stateAfterCloseAmbiguity.closeAndReduceRoutesNeverBlocked, true);

  const firstOpen = await global.fetch(OPEN_BY_AMOUNT_URL, {
    method: 'POST',
    headers: { 'x-request-id': 'test-open-1' },
    body: JSON.stringify({ InstrumentId: 3417, Amount: 10, Leverage: 1, IsBuy: true })
  });
  assert.equal(firstOpen.status, 200);
  assert.equal(providerCalls.length, 2);

  const stateAfterOpenAmbiguity = global.__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__();
  assert.equal(stateAfterOpenAmbiguity.breakerActive, true);
  assert.equal(stateAfterOpenAmbiguity.breakerScope, 'NEW_OPEN_ORDERS_ONLY');
  assert.equal(stateAfterOpenAmbiguity.closeAndReduceRoutesNeverBlocked, true);
  assert.equal(stateAfterOpenAmbiguity.breakerCause.scope, 'NEW_OPEN_ORDERS_ONLY');

  const secondOpen = await global.fetch(OPEN_BY_UNITS_URL, {
    method: 'POST',
    headers: { 'x-request-id': 'test-open-2' },
    body: JSON.stringify({ InstrumentId: 3417, Amount: 1, Leverage: 1, IsBuy: true })
  });
  assert.equal(secondOpen.status, 409);
  assert.equal(secondOpen.headers.get('x-leo-local-open-order-breaker'), '1');
  assert.equal(providerCalls.length, 2, 'second OPEN must be blocked before provider');

  const closeWhileBreakerActive = await global.fetch(CLOSE_URL, {
    method: 'POST',
    headers: { 'x-request-id': 'test-close-while-breaker' },
    body: JSON.stringify({ UnitsToDeduct: 1 })
  });
  assert.equal(closeWhileBreakerActive.status, 200);
  assert.equal(providerCalls.length, 3, 'CLOSE/reduce must still reach provider while breaker is active');
  assert.equal(providerCalls[2].url, CLOSE_URL);
});

test('response classifier distinguishes ambiguity, acknowledgement and rejection', () => {
  const empty = diagnostics.classifyExecutionResponse({ status: 200 }, '');
  assert.equal(empty.classification, 'HTTP_2XX_EMPTY_BODY');
  assert.equal(empty.ambiguous, true);
  assert.equal(empty.businessAcknowledged, false);

  const emptyJson = diagnostics.classifyExecutionResponse({ status: 200 }, '{}');
  assert.equal(emptyJson.classification, 'HTTP_2XX_EMPTY_JSON');
  assert.equal(emptyJson.ambiguous, true);

  const acknowledged = diagnostics.classifyExecutionResponse({ status: 200 }, JSON.stringify({ orderId: 42 }));
  assert.equal(acknowledged.classification, 'BUSINESS_ACKNOWLEDGED');
  assert.equal(acknowledged.businessAcknowledged, true);
  assert.equal(acknowledged.ambiguous, false);

  const rejected = diagnostics.classifyExecutionResponse({ status: 400 }, JSON.stringify({ message: 'bad request' }));
  assert.equal(rejected.classification, 'HTTP_ERROR');
  assert.equal(rejected.businessRejected, true);
  assert.equal(rejected.ambiguous, false);

  const unknown2xx = diagnostics.classifyExecutionResponse({ status: 200 }, 'accepted-but-unstructured');
  assert.equal(unknown2xx.classification, 'HTTP_2XX_UNRECOGNIZED_BODY');
  assert.equal(unknown2xx.ambiguous, true);
});

test('secret redaction never emits known credentials', () => {
  process.env.ETORO_API_KEY = 'test-secret-api-key-123456';
  process.env.ETORO_USER_KEY = 'test-secret-user-key-123456';
  const redacted = diagnostics.redactText(`x-api-key=${process.env.ETORO_API_KEY} x-user-key=${process.env.ETORO_USER_KEY}`);
  assert.equal(redacted.includes(process.env.ETORO_API_KEY), false);
  assert.equal(redacted.includes(process.env.ETORO_USER_KEY), false);
  assert.match(redacted, /REDACTED/);
});
