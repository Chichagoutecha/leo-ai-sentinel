'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executionRequestMetadata,
  isEtoroExecutionRequest,
  safeRequestBody,
  classifyExecutionResponse
} = require('./etoro-execution-diagnostics');

test('captures eToro v1 real execution writes', () => {
  assert.equal(
    isEtoroExecutionRequest('https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-amount', 'POST'),
    true
  );
});

test('captures eToro v1 demo execution writes', () => {
  const metadata = executionRequestMetadata(
    'https://public-api.etoro.com/api/v1/trading/execution/demo/market-open-orders/by-amount',
    'POST'
  );
  assert.equal(metadata.match, true);
  assert.equal(metadata.version, 'v1');
  assert.equal(metadata.environment, 'DEMO');
});

test('captures eToro v2 unified execution writes', () => {
  const metadata = executionRequestMetadata(
    'https://public-api.etoro.com/api/v2/trading/execution/orders',
    'POST'
  );
  assert.equal(metadata.match, true);
  assert.equal(metadata.version, 'v2');
});

test('does not capture GET or unrelated hosts', () => {
  assert.equal(isEtoroExecutionRequest('https://public-api.etoro.com/api/v2/trading/execution/orders', 'GET'), false);
  assert.equal(isEtoroExecutionRequest('https://example.com/api/v2/trading/execution/orders', 'POST'), false);
});

test('safeRequestBody keeps v1 and v2 order fields', () => {
  assert.deepEqual(
    safeRequestBody(JSON.stringify({ InstrumentId: 1, Amount: 10, Leverage: 1, IsBuy: true, secret: 'x' })),
    { InstrumentId: 1, Amount: 10, Leverage: 1, IsBuy: true }
  );
  assert.deepEqual(
    safeRequestBody(JSON.stringify({ action: 'open', transaction: 'buy', instrumentId: 1, orderType: 'mkt', amount: 10, orderCurrency: 'usd', leverage: 1 })),
    { action: 'open', transaction: 'buy', instrumentId: 1, orderType: 'mkt', amount: 10, orderCurrency: 'usd', leverage: 1 }
  );
});

test('classifies acknowledged and ambiguous 2xx responses', () => {
  const okResponse = { status: 200 };
  const ack = classifyExecutionResponse(okResponse, JSON.stringify({ orderId: 123 }));
  assert.equal(ack.businessAcknowledged, true);
  assert.equal(ack.ambiguous, false);

  const empty = classifyExecutionResponse(okResponse, '');
  assert.equal(empty.businessAcknowledged, false);
  assert.equal(empty.ambiguous, true);
});
