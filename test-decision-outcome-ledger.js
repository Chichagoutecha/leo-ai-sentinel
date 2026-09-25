'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLedger, normalizeClosedHistory } = require('./decision-outcome-ledger');
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
    ['EXACT_BROKER_NET_PROFIT', 'ATTRIBUTED_EXTERNAL_FX_COST', 'ATTRIBUTED_AI_COST']);
  assert.equal(result.realizedNetTotalUsdVirtual, null);
});

test('history requires exact position and instrument and preserves broker netProfit without double charging fees', () => {
  const trade = { positionId: 100, instrumentId: 100109, orderId: 'order-1',
    closeTimestamp: '2026-09-25T12:00:00Z', netProfit: -2.5, fees: 0.75 };
  const normalized = normalizeClosedHistory([trade], [buy()]);
  assert.equal(normalized.valid, true);
  const entry = buildLedger([buy()], { valid: true, positionsById: {} }, 100, normalized.matches).entries[0];
  assert.equal(entry.state, 'BROKER_CLOSED_TRADE');
  assert.equal(entry.brokerNetProfitUsdVirtual, -2.5);
  assert.equal(entry.observedBrokerFeesUsdVirtual, 0.75);
  assert.equal(entry.realizedNetUsdVirtual, null);
  assert.deepEqual(entry.missingForNet, ['ATTRIBUTED_EXTERNAL_FX_COST', 'ATTRIBUTED_AI_COST']);
});

test('a complete result subtracts only separately attributed external FX and AI cost', () => {
  const position = buy();
  position.decisionTrace.aiDecisionCost = { scope: 'DECISION_AGENT_CALL_ONLY',
    basis: 'PROVIDER_USAGE_OR_CACHE_ONLY', totalAttributedUsd: 0.2 };
  const sell = { id: 'sell-1', side: 'SELL', targetPositionId: '100', executionInstrumentId: 100109,
    fullCloseRequested: true, confirmation: { proof: 'EXACT_TARGET_POSITION_ID_REMOVED_FROM_REAL_PNL',
      fxFeesUsdVirtual: 0.3 }, decisionTrace: { aiDecisionCost: { scope: 'DECISION_AGENT_CALL_ONLY',
        basis: 'PROVIDER_USAGE_OR_CACHE_ONLY', totalAttributedUsd: 0.1 } } };
  const closed = normalizeClosedHistory([{ positionId: 100, instrumentId: 100109, orderId: 'order-1',
    closeTimestamp: '2026-09-25T12:00:00Z', netProfit: 10, fees: 2 }], [position]);
  const ledger = buildLedger([position, sell], { valid: true, positionsById: {} }, 100, closed.matches);
  assert.equal(ledger.entries[0].realizedNetUsdVirtual, 9.4);
  assert.equal(ledger.realizedNetTotalUsdVirtual, 9.4);
  assert.equal(ledger.entries[0].observedBrokerFeesUsdVirtual, 2);
});

test('a cached decision is zero-cost, while an estimated usage fallback cannot certify net', () => {
  const previous = global.__LEO_AI_COST_OBSERVER_HOOK_READY__;
  global.__LEO_AI_COST_OBSERVER_HOOK_READY__ = true;
  try {
    const buyTrace = { ...buy(), decisionTrace: { aiDecisionCost: { scope: 'DECISION_AGENT_CALL_ONLY',
      basis: 'INCLUDES_ESTIMATE_OR_UNKNOWN', totalAttributedUsd: 0.5 } } };
    const sell = { id: 'sell-1', side: 'SELL', targetPositionId: '100', executionInstrumentId: 100109,
      fullCloseRequested: true, confirmation: { proof: 'EXACT_TARGET_POSITION_ID_REMOVED_FROM_REAL_PNL',
        fxFeesUsdVirtual: 0 }, decisionTrace: { aiDecisionCost: { scope: 'DECISION_AGENT_CALL_ONLY',
        basis: 'PROVIDER_USAGE_OR_CACHE_ONLY', totalAttributedUsd: 0 } } };
    const closed = { 100: { positionId: '100', instrumentId: 100109, netProfitUsdVirtual: 10,
      provenance: 'ETORO_REAL_TRADE_HISTORY_EXACT_POSITION_INSTRUMENT' } };
    const entry = buildLedger([buyTrace, sell], { valid: true, positionsById: {} }, 100, closed).entries[0];
    assert.equal(entry.attributedAiCostUsd, null);
    assert.equal(entry.realizedNetUsdVirtual, null);
  } finally { global.__LEO_AI_COST_OBSERVER_HOOK_READY__ = previous; }
});

test('asynchronous cost records remain isolated across concurrent decisions', async () => {
  const previous = global.__LEO_AI_COST_OBSERVER_HOOK_READY__;
  global.__LEO_AI_COST_OBSERVER_HOOK_READY__ = true;
  try {
    const one = observer.runWithAiDecisionCost(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3));
      observer.recordAiCostEvent({ event: 'CALL_COMPLETED', costBasis: 'PROVIDER_USAGE', callCostUsd: 0.2 });
      return 'one';
    });
    const two = observer.runWithAiDecisionCost(async () => {
      observer.recordAiCostEvent({ event: 'CALL_COMPLETED', costBasis: 'CONSERVATIVE_RESERVED_FALLBACK', callCostUsd: 0.7 });
      observer.recordAiCostEvent({ event: 'CACHE_HIT' });
      return 'two';
    });
    const [a, b] = await Promise.all([one, two]);
    assert.equal(a.cost.totalAttributedUsd, 0.2);
    assert.equal(a.cost.basis, 'PROVIDER_USAGE_OR_CACHE_ONLY');
    assert.equal(b.cost.totalAttributedUsd, 0.7);
    assert.equal(b.cost.cacheHits, 1);
    assert.equal(b.cost.basis, 'INCLUDES_ESTIMATE_OR_UNKNOWN');
  } finally { global.__LEO_AI_COST_OBSERVER_HOOK_READY__ = previous; }
});

test('duplicate, wrong account shape, wrong instrument and order cannot create broker profit', () => {
  const sample = { positionId: 100, instrumentId: 100109, orderId: 'order-1',
    closeTimestamp: '2026-09-25T12:00:00Z', netProfit: 10, fees: 1 };
  assert.equal(normalizeClosedHistory({ trades: [sample] }, [buy()]).valid, false);
  assert.deepEqual(normalizeClosedHistory([{ ...sample, instrumentId: 999 }], [buy()]).matches, {});
  assert.deepEqual(normalizeClosedHistory([{ ...sample, orderId: 'other' }], [buy()]).matches, {});
  const double = normalizeClosedHistory([sample, { ...sample, netProfit: 20 }], [buy()]);
  assert.deepEqual(double.matches, {});
  assert.equal(double.ambiguousPositions, 1);
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

test('history ingest persists only exact matched trades and reports possible missing pages', async () => {
  observer._test.resetState();
  observer._test.getState().observations.push(buy());
  const agent = observer.installAgent({ fetch: async () => new Response('{}', { status: 200 }) });
  const rows = Array.from({ length: 100 }, (_, i) => ({ positionId: i + 100,
    instrumentId: 100109, orderId: i === 0 ? 'order-1' : 'other',
    netProfit: 4, fees: 1, closeTimestamp: '2026-09-25T12:00:00Z' }));
  const result = await agent.ingestHistory(rows, { minDate: '2026-07-01' });
  assert.equal(result.possiblyMorePages, true);
  assert.equal(result.matchedPositions, 1);
  assert.equal((await agent.ledger()).entries[0].brokerNetProfitUsdVirtual, 4);
  assert.equal(Object.keys(observer._test.getState().closedHistoryByPosition).length, 1);
});
