'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TRADING_MODE = 'SHADOW';
process.env.PAPER_PERFORMANCE_MODE = 'advisory';
process.env.PAPER_SEED_FROM_REAL = 'false';
delete process.env.LIVE_EXECUTION_ARMED;
delete process.env.LIVE_BUY_CONFIRMATION;

const app = require('./index');

test('SHADOW uses the virtual executor and never calls the broker fetch path', async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error('Unexpected broker/provider call'); };
  try {
    const fresh = {
      mid: 100, bid: 99.99, ask: 100.01, ageMinutes: 0,
      priceStatus: 'FRESH', eligibleForTrade: true, source: 'TEST_FIXTURE',
      date: new Date().toISOString()
    };
    const marketData = { normalized: { ratesByAsset: { SPY: fresh, BTC: fresh }, provider: 'TEST_FIXTURE' } };
    app.ensurePaperPortfolio({ availableCash: 100, aggregatedPositions: [] }, marketData.normalized);
    const callsBefore = fetchCalls;
    const result = await app.executeBuy('SPY', 10, marketData);
    assert.equal(result.simulated, true);
    assert.equal(result.mode, 'PAPER');
    assert.equal(fetchCalls, callsBefore);

    const staleSellMarket = { normalized: { ratesByAsset: { SPY: { ...fresh, priceStatus: 'STALE', eligibleForTrade: false, ageMinutes: 120 } } } };
    const staleSell = app.executePaperSell('SPY', staleSellMarket);
    assert.equal(staleSell.skipped, true);
    assert.equal(staleSell.executionAttempted, false);
    assert.equal(fetchCalls, callsBefore);

    const staleMarket = { normalized: { ratesByAsset: { BTC: { ...fresh, priceStatus: 'STALE', eligibleForTrade: false, ageMinutes: 120 } } } };
    const staleResult = app.executePaperBuy('BTC', 10, staleMarket);
    assert.equal(staleResult.skipped, true);
    assert.equal(staleResult.executionAttempted, false);
    assert.equal(fetchCalls, callsBefore);
  } finally {
    global.fetch = originalFetch;
  }
});

test('manual virtual cash flows are idempotent and stay inside the paper ledger', () => {
  const first = app.recordPaperCashFlow({ type: 'DEPOSIT', amount: 25, idempotencyKey: 'test-flow-0001' });
  assert.equal(first.ok, true);
  assert.equal(first.executionAttempted, false);
  const duplicate = app.recordPaperCashFlow({ type: 'DEPOSIT', amount: 25, idempotencyKey: 'test-flow-0001' });
  assert.equal(duplicate.duplicate, true);
  const rejected = app.recordPaperCashFlow({ type: 'WITHDRAWAL', amount: 100000, idempotencyKey: 'test-flow-0002' });
  assert.equal(rejected.status, 'INSUFFICIENT_PAPER_CASH');
  const scorecard = app.calculatePaperPerformance().shadowScorecard;
  assert.equal(scorecard.virtualOnly, true);
  assert.notEqual(scorecard.return.flowAdjusted.returnPct, null);
});

test('shadow decision ledger retains veto reasons without an execution attempt', () => {
  const row = app.recordPaperDecision({
    proposedDecision: { decision: 'BUY', asset: 'FAKE123', amount_usd: 10, confidence: 80, risk_check: 'passed', reason: 'Unlisted candidate' },
    control: { approved: false, reason: 'Fresh price required', finalDecision: { decision: 'HOLD', asset: 'NONE', amount_usd: 0, confidence: 0, risk_check: 'failed', reason: 'Fresh price required' } },
    execution: { skipped: true, executionAttempted: false, reason: 'No execution' }
  });
  assert.equal(row.status, 'VETOED');
  assert.equal(row.proposed.asset, 'FAKE123');
  assert.equal(row.proposed.decision, 'BUY');
  assert.equal(row.vetoReason, 'Fresh price required');
  assert.equal(row.execution, null);
});
