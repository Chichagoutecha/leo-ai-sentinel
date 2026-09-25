'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLedger } = require('./decision-outcome-ledger');
process.env.EXECUTION_QUALITY_AUTO_INSTALL = 'false';
const observer = require('./execution-quality-shadow-agent');

function buy() {
  return {
    id: 'buy-1', side: 'BUY', asset: 'BTC', executionInstrumentId: 100109,
    brokerResponse: { orderId: 'order-1' }, decisionTrace: { id: 'scan-1', asset: 'BTC', action: 'BUY' },
    confirmation: { proof: 'BROKER_POSITION_ID_VISIBLE_IN_REAL_PNL', positionId: '100',
      confirmedAt: '2026-09-25T10:00:00Z', virtualInvestedAmountUsd: 10 },
    executionQuality: { slippageBps: 2 }
  };
}

test('open broker PnL remains unrealized; unknown fees never become zero', () => {
  const ledger = buildLedger([buy()], { valid: true, observedAt: 'now',
    positionsById: { 100: { positionId: '100', instrumentId: 100109, profitUsdVirtual: 3 } } });
  assert.equal(ledger.entries[0].state, 'OPEN_OBSERVED');
  assert.equal(ledger.entries[0].unrealizedBrokerProfitUsdVirtual, 3);
  assert.equal(ledger.entries[0].realizedNetUsdVirtual, null);
  assert.equal(ledger.realizedNetTotalUsdVirtual, null);
});

test('paired exact full close still has no invented realized profit or total', () => {
  const sell = { id: 'sell-1', side: 'SELL', targetPositionId: '100', executionInstrumentId: 100109,
    fullCloseRequested: true, brokerResponse: { orderId: 'order-2' },
    confirmation: { proof: 'EXACT_TARGET_POSITION_ID_REMOVED_FROM_REAL_PNL', confirmedAt: 'later',
      cashDeltaUsdVirtual: 11 } };
  const result = buildLedger([buy(), sell], { valid: true, positionsById: {} });
  assert.equal(result.counts.pairedCloses, 1);
  assert.equal(result.entries[0].realizedGrossUsdVirtual, null);
  assert.equal(result.entries[0].realizedNetUsdVirtual, null);
  assert.deepEqual(result.entries[0].missingForNet,
    ['EXACT_REALIZED_PNL', 'BROKER_FEES', 'FX_FEES', 'ATTRIBUTED_AI_COST']);
  assert.equal(result.realizedNetTotalUsdVirtual, null);
});

test('mismatched instrument, partial close, and unpaired legacy SELL cannot be joined', () => {
  const unrelated = { id: 'sell-other', side: 'SELL', targetPositionId: '100',
    executionInstrumentId: 999, fullCloseRequested: true,
    confirmation: { proof: 'EXACT_TARGET_POSITION_ID_REMOVED_FROM_REAL_PNL' } };
  const result = buildLedger([buy(), unrelated], { valid: true, positionsById: {} });
  assert.equal(result.entries[0].state, 'OUTCOME_UNKNOWN');
  assert.equal(result.counts.unpairedConfirmedSells, 1);
});

test('decision trace attaches only to the matching asynchronous order context', async () => {
  observer._test.resetState();
  const agent = observer.installAgent({ fetch: async () => new Response('{}', { status: 200 }) });
  await agent.runWithDecision({ action: 'BUY', asset: 'BTC', confidence: 0.82, source: 'SCAN' }, async () => {
    await Promise.resolve();
    const matching = observer._test.makeBuyObservation({ instrumentId: 100109, amount: 10 });
    const other = observer._test.makeBuyObservation({ instrumentId: 8760, amount: 10 });
    assert.equal(matching.decisionTrace.asset, 'BTC');
    assert.equal(other.decisionTrace, null);
  });
  assert.equal(observer._test.makeBuyObservation({ instrumentId: 100109, amount: 10 }).decisionTrace, null);
});
