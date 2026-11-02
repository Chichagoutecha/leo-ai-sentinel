'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateModifiedDietz, buildPaperShadowScorecard } = require('./paper-shadow-accounting');

const t0 = '2026-01-01T00:00:00.000Z';
const tm = '2026-01-02T00:00:00.000Z';
const t1 = '2026-01-03T00:00:00.000Z';

test('Modified Dietz adjusts a cash deposit using its time in the measurement window', () => {
  const result = calculateModifiedDietz({
    historyComplete: true,
    snapshots: [
      { time: t0, equity: 100, valuationComplete: true },
      { time: t1, equity: 210, valuationComplete: true }
    ],
    cashFlows: [{ time: tm, type: 'DEPOSIT', signedAmount: 100, valuationComplete: true }]
  });
  assert.equal(result.status, 'APPROXIMATE');
  assert.equal(result.method, 'MODIFIED_DIETZ');
  assert.equal(result.returnPct, 6.666667);
  assert.equal(result.netExternalFlows, 100);
});

test('Modified Dietz treats a withdrawal as a negative external cash flow', () => {
  const result = calculateModifiedDietz({
    historyComplete: true,
    snapshots: [
      { time: t0, equity: 100, valuationComplete: true },
      { time: t1, equity: 55, valuationComplete: true }
    ],
    cashFlows: [{ time: tm, type: 'WITHDRAWAL', signedAmount: -50, valuationComplete: true }]
  });
  assert.equal(result.status, 'APPROXIMATE');
  assert.equal(result.returnPct, 6.666667);
});

test('flow-adjusted return is unavailable for incomplete history, stale valuations, or unknown flows', () => {
  const snapshots = [
    { time: t0, equity: 100, valuationComplete: true },
    { time: t1, equity: 110, valuationComplete: true }
  ];
  assert.equal(calculateModifiedDietz({ snapshots, historyComplete: false }).reason, 'CASH_FLOW_HISTORY_INCOMPLETE');
  assert.equal(calculateModifiedDietz({ historyComplete: true, snapshots: [snapshots[0], { ...snapshots[1], valuationComplete: false }] }).reason, 'ENDPOINT_VALUATION_INCOMPLETE');
  assert.equal(calculateModifiedDietz({ historyComplete: true, snapshots, cashFlows: [{ time: tm, signedAmount: 10, valuationComplete: false }] }).reason, 'CASH_FLOW_VALUATION_INCOMPLETE');
});

test('scorecard identifies unknown cost components and benchmark currency mismatch', () => {
  const scorecard = buildPaperShadowScorecard({
    createdAt: t0, currency: 'USD', cashFlowHistoryComplete: true,
    performanceBaseline: { time: t0, equity: 100, valuationComplete: true },
    snapshots: [{ time: t0, equity: 100, valuationComplete: true }, { time: t1, equity: 101, valuationComplete: true, priceCoverage: { missingAssets: [], staleAssets: [] } }],
    cashFlows: [], orders: [], decisions: [], feesPaid: 0, slippageCost: 0,
    benchmark: { asset: 'EUNL.DE', startPrice: 100, currentPrice: 105, currency: 'EUR', startTime: t0, startPriceStatus: 'FRESH', priceStatus: 'FRESH' },
    assumptions: { feePct: 0, slippageBpsPerSide: 10 }, seedCoverage: { complete: true, omittedAssets: [] }
  }, { totalReturnPct: 1, maxDrawdownPct: 0, annualizedVolatilityPct: 0 });
  assert.equal(scorecard.virtualOnly, true);
  assert.equal(scorecard.return.benchmark.returnPct, null);
  assert.equal(scorecard.return.benchmark.status, 'UNAVAILABLE_STALE_OR_CURRENCY_MISMATCH');
  assert.equal(scorecard.costs.measuredBrokerCosts, null);
  assert.equal(scorecard.costs.observedBrokerFees, null);
  assert.ok(scorecard.costs.unknown.includes('FX_COSTS'));
  assert.equal(scorecard.costs.simulated.basis, 'CONFIGURED_SIMULATION_ASSUMPTIONS');
});

test('same-currency benchmark return is available only with matching fresh window', () => {
  const scorecard = buildPaperShadowScorecard({
    currency: 'USD', cashFlowHistoryComplete: true,
    performanceBaseline: { time: t0, equity: 100, valuationComplete: true },
    snapshots: [
      { time: t0, equity: 100, valuationComplete: true },
      { time: t1, equity: 103, valuationComplete: true, priceCoverage: { missingAssets: [], staleAssets: [] } }
    ],
    cashFlows: [{ time: tm, type: 'DEPOSIT', amount: 10, signedAmount: 10, valuationComplete: true }],
    orders: [], decisions: [], feesPaid: 0.25, slippageCost: 0.5,
    benchmark: { asset: 'SPY', startPrice: 100, currentPrice: 105, currency: 'USD', startTime: t0, startPriceStatus: 'FRESH', priceStatus: 'FRESH' },
    assumptions: { feePct: 0, slippageBpsPerSide: 10 }, seedCoverage: { complete: true, omittedAssets: [] }
  });
  assert.equal(scorecard.return.benchmark.returnPct, 5);
  assert.equal(scorecard.activity.cashFlows.deposits, 10);
  assert.equal(scorecard.activity.cashFlows.withdrawals, 0);
  assert.equal(scorecard.costs.estimatedCosts.fees, 0.25);
  assert.equal(scorecard.dataCoverage.status, 'INCOMPLETE');
});

test('incomplete and stale price coverage is surfaced instead of hidden', () => {
  const scorecard = buildPaperShadowScorecard({
    createdAt: t0, currency: 'USD', cashFlowHistoryComplete: true,
    performanceBaseline: { time: t0, equity: 100, valuationComplete: true },
    snapshots: [
      { time: t0, equity: 100, valuationComplete: true },
      { time: t1, equity: 102, valuationComplete: false, priceCoverage: { missingAssets: ['NVDA'], staleAssets: ['BTC'] } }
    ], cashFlows: [], orders: [], decisions: [], feesPaid: 0, slippageCost: 0,
    benchmark: { asset: 'SPY', startPrice: 100, currentPrice: 102, currency: 'USD', priceStatus: 'FRESH' },
    assumptions: {}, seedCoverage: { complete: false, omittedAssets: ['ETH'] }
  }, { totalReturnPct: 2 });
  assert.equal(scorecard.status, 'INCOMPLETE_COVERAGE');
  assert.equal(scorecard.return.flowAdjusted.status, 'UNAVAILABLE');
  assert.deepEqual(scorecard.dataCoverage.missingPriceAssets, ['ETH', 'NVDA']);
  assert.deepEqual(scorecard.dataCoverage.stalePriceAssets, ['BTC']);
});
