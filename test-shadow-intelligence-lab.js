'use strict';

process.env.SHADOW_LAB_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const lab = require('./shadow-intelligence-lab.js');

test('Shadow Lab normalizes a valid eToro rate', () => {
  const rate = lab.normalizeRate({
    instrumentId: 123,
    bid: 99,
    ask: 101,
    timestamp: new Date().toISOString()
  });
  assert.equal(rate.instrumentId, 123);
  assert.equal(rate.mid, 100);
  assert.equal(rate.spreadPct, 2);
});

test('Shadow Lab allows eToro market-data reads', () => {
  assert.doesNotThrow(() => lab.assertReadOnlyUrl(
    'https://public-api.etoro.com/api/v1/market-data/instruments/rates?instrumentIds=123'
  ));
});

test('Shadow Lab blocks all eToro trading execution surfaces', () => {
  assert.throws(() => lab.assertReadOnlyUrl(
    'https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-amount'
  ), /SHADOW_LAB_EXECUTION_ENDPOINT_BLOCKED/);
});

test('Shadow Lab blocks non-eToro hosts', () => {
  assert.throws(() => lab.assertReadOnlyUrl(
    'https://example.com/api/v1/market-data/search'
  ), /SHADOW_LAB_ETORO_HOST_BLOCKED/);
});

test('Shadow Lab Phase 1 does not expose execution functions', () => {
  assert.equal(typeof lab.runShadowScan, 'function');
  assert.equal('executeBuy' in lab, false);
  assert.equal('executeSell' in lab, false);
  assert.equal('placeOrder' in lab, false);
});
