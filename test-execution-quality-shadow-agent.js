'use strict';

process.env.EXECUTION_QUALITY_AUTO_INSTALL = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./execution-quality-shadow-agent.js');

function pnl({ credit = 9000, positions = [] } = {}) {
  return {
    clientPortfolio: {
      credit,
      positions,
      ordersForOpen: [],
      ordersForClose: []
    }
  };
}

test('governance is strictly shadow-only and cannot alter LIVE sizing or orders', () => {
  assert.equal(mod.VERSION, 'v10.22.22.0-execution-quality-readiness');
  assert.equal(mod.GOVERNANCE.analysisOnly, true);
  assert.equal(mod.GOVERNANCE.shadowOnly, true);
  assert.equal(mod.GOVERNANCE.canPlaceOrder, false);
  assert.equal(mod.GOVERNANCE.canBlockOrder, false);
  assert.equal(mod.GOVERNANCE.canModifyOrder, false);
  assert.equal(mod.GOVERNANCE.canModifySizing, false);
  assert.equal(mod.GOVERNANCE.canChangeMinimumOrder, false);
  assert.equal(mod.GOVERNANCE.canRetryOrder, false);
  assert.equal(mod.GOVERNANCE.providerCallsAdded, 0);
  assert.equal(mod.GOVERNANCE.brokerReadCallsAdded, 0);
  assert.equal(mod.GOVERNANCE.orderCallsAdded, 0);
  assert.equal(mod.GOVERNANCE.copyCalibrationAutoApply, false);
});

test('BUY quality is confirmed from REAL PnL and keeps copier amount explicitly estimated', () => {
  mod._test.resetState();

  mod._test.ingestRates({
    rates: [{
      instrumentId: 100109,
      bid: 71990,
      ask: 72010,
      lastExecution: 72000
    }]
  }, async () => {});

  mod._test.ingestPnl(pnl({ credit: 9476.05, positions: [] }), async () => {});

  const observation = mod._test.makeBuyObservation({
    action: 'open',
    transaction: 'buy',
    instrumentId: 100109,
    amount: 523.95,
    orderType: 'mkt',
    leverage: 1
  });
  mod._test.getState().observations.push(observation);

  const response = new Response(JSON.stringify({
    orderId: 1563341618,
    positionId: 3551537645,
    success: true
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  mod._test.attachOrderResponse(
    observation,
    response,
    { orderId: 1563341618, positionId: 3551537645, success: true },
    async () => {}
  );

  mod._test.ingestPnl(pnl({
    credit: 8952.16,
    positions: [{
      positionId: 3551537645,
      instrumentId: 100109,
      amount: 523.89,
      units: 0.007269,
      openRate: 72020,
      currentRate: 72020,
      profit: 0
    }]
  }), async () => {});

  assert.equal(observation.status, 'PORTFOLIO_CONFIRMED');
  assert.equal(observation.confirmation.proof, 'BROKER_POSITION_ID_VISIBLE_IN_REAL_PNL');
  assert.equal(observation.confirmation.positionId, '3551537645');
  assert.equal(observation.confirmation.virtualInvestedAmountUsd, 523.89);
  assert.ok(observation.executionQuality.virtualFillRatio > 0.99);
  assert.ok(Number.isFinite(observation.executionQuality.slippageBps));
  assert.equal(observation.copyEstimate.directCopierObservationAvailable, false);
  assert.equal(observation.copyEstimate.copiedAmountSource, 'ESTIMATED_NOT_DIRECTLY_OBSERVED');
  assert.equal(observation.copyEstimate.eligibleForAutomaticSizingChange, false);
});

test('SELL confirmation requires disappearance of the exact target position in observed REAL PnL', () => {
  mod._test.resetState();

  mod._test.ingestRates({
    rates: [{ instrumentId: 100109, bid: 72990, ask: 73010, lastExecution: 73000 }]
  }, async () => {});

  mod._test.ingestPnl(pnl({
    credit: 7880.53,
    positions: [{
      positionId: 3551537645,
      instrumentId: 100109,
      amount: 523.89,
      units: 0.007269,
      openRate: 72020,
      currentRate: 73000,
      profit: 7.12
    }]
  }), async () => {});

  const observation = mod._test.makeSellObservation(
    new URL('https://public-api.etoro.com/api/v1/trading/execution/market-close-orders/positions/3551537645'),
    { UnitsToDeduct: null }
  );
  mod._test.getState().observations.push(observation);

  const response = new Response(JSON.stringify({
    positionId: 3551537645,
    closeRate: 72980,
    success: true
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  mod._test.attachOrderResponse(
    observation,
    response,
    { positionId: 3551537645, closeRate: 72980, success: true },
    async () => {}
  );

  mod._test.ingestPnl(pnl({ credit: 8410.11, positions: [] }), async () => {});

  assert.equal(observation.status, 'PORTFOLIO_CONFIRMED');
  assert.equal(observation.confirmation.proof, 'EXACT_TARGET_POSITION_ID_REMOVED_FROM_REAL_PNL');
  assert.equal(observation.confirmation.positionId, '3551537645');
  assert.equal(observation.executionQuality.cashDeltaIsExecutionPriceProof, false);
  assert.equal(observation.copyEstimate.directCopierObservationAvailable, false);
});

test('UCITS execution instrument learned from exact symbol search is mapped back to the analysis asset', () => {
  mod._test.resetState();
  const fakeFetch = async () => {};

  mod._test.learnSearchAlias(
    new URL('https://public-api.etoro.com/api/v1/market-data/search?internalSymbolFull=CSPX.L'),
    {
      items: [
        { internalSymbolFull: 'CSPX.L', instrumentId: 987654 },
        { internalSymbolFull: 'NOT-CSPX.L', instrumentId: 123 }
      ]
    },
    fakeFetch
  );

  const snapshot = mod.extractPnlSnapshot(pnl({
    credit: 9000,
    positions: [{
      positionId: 111,
      instrumentId: 987654,
      amount: 500,
      units: 1,
      openRate: 500,
      currentRate: 501,
      profit: 1
    }]
  }));

  assert.equal(snapshot.positions.length, 1);
  assert.equal(snapshot.positions[0].asset, 'SPY');
  assert.equal(snapshot.positions[0].executionSymbol, 'CSPX.L');
  assert.equal(snapshot.positions[0].analysisInstrumentId, 3417);
});

test('copy calibration waits for several observed agent fills and never auto-applies its estimate', () => {
  mod._test.resetState();
  const state = mod._test.getState();
  state.lastPnlSnapshot = {
    agentPortfolioValueUsd: 10000,
    credit: 8000,
    positions: [],
    positionsById: {}
  };

  for (let index = 0; index < 5; index += 1) {
    state.observations.push({
      side: 'BUY',
      status: 'PORTFOLIO_CONFIRMED',
      executionQuality: { virtualFillRatio: 0.9998 + index * 0.00001 },
      copyEstimate: { replicationRatioEstimate: 0.02 + index * 0.000001 }
    });
  }

  const calibration = mod.calibrationSummary();

  assert.equal(calibration.status, 'READY_FOR_HUMAN_REVIEW_ESTIMATE_ONLY');
  assert.equal(calibration.observationsUsed, 5);
  assert.equal(calibration.directCopierObservationAvailable, false);
  assert.ok(calibration.estimatedCalibratedMinimumVirtualOrderUsd > 0);
  assert.equal(calibration.automaticApplication, false);
  assert.equal(calibration.eligibleForAutomaticSizingChange, false);
  assert.equal(calibration.reviewRequired, true);
  assert.equal(calibration.recommendationSource, 'ESTIMATED_NOT_DIRECTLY_OBSERVED_ON_COPIER_ACCOUNT');
});

test('readiness distinguishes absent PnL, idle operation, and broker acceptance without execution proof', () => {
  mod._test.resetState();
  assert.equal(mod.observationReadiness().status, 'NO_REAL_PNL_OBSERVED');
  mod._test.ingestPnl(pnl(), async () => {});
  assert.equal(mod.observationReadiness().status, 'WAITING_FOR_ORDER');

  const row = mod._test.makeBuyObservation({ instrumentId: 100109, amount: 523.95 });
  row.requestObservedAt = new Date(Date.now() - 181 * 60 * 1000).toISOString();
  row.status = 'BROKER_HTTP_OK';
  row.brokerResponse = { httpOk: true, httpStatus: 200, positionId: '123' };
  mod._test.getState().observations.push(row);
  const readiness = mod.observationReadiness();
  assert.equal(readiness.status, 'REVIEW_REQUIRED');
  assert.equal(readiness.counts.brokerAcceptedAwaitingPortfolio, 1);
  assert.equal(readiness.counts.awaitingPortfolioOverReviewAge, 1);
  assert.equal(readiness.counts.confirmedPositions, 0);
  assert.equal(readiness.counts.brokerHttpRejected, 0);
  assert.equal(mod.qualitySummary().observationReadiness.counts.observedOrders, 1);
});

test('readiness reports missing measurements after exact confirmation without inventing slippage', () => {
  mod._test.resetState();
  mod._test.ingestPnl(pnl(), async () => {});
  mod._test.getState().observations.push({
    side: 'BUY',
    status: 'PORTFOLIO_CONFIRMED',
    requestObservedAt: new Date().toISOString(),
    confirmation: { proof: 'BROKER_POSITION_ID_VISIBLE_IN_REAL_PNL' },
    executionQuality: { slippageBps: null, virtualFillRatio: null }
  });
  const readiness = mod.observationReadiness();
  assert.equal(readiness.status, 'OBSERVING');
  assert.equal(readiness.counts.confirmedPositions, 1);
  assert.equal(readiness.counts.confirmedWithoutComparableSlippage, 1);
  assert.equal(readiness.counts.confirmedBuysWithoutFillRatio, 1);
});

test('fetch wrapper forwards the exact BUY request once and adds no broker/provider call', async () => {
  mod._test.resetState();

  const calls = [];
  const fakeFetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({
      orderId: 999,
      positionId: 888,
      success: true
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const agent = mod.installAgent({ fetch: fakeFetch });
  const input = 'https://public-api.etoro.com/api/v2/trading/execution/orders';
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': 'unit-test' },
    body: JSON.stringify({
      action: 'open',
      transaction: 'buy',
      instrumentId: 100109,
      orderType: 'mkt',
      amount: 523.95,
      orderCurrency: 'usd',
      leverage: 1
    })
  };

  const response = await agent.fetch(input, init);
  await mod._test.drainPendingTasks();

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, input);
  assert.equal(calls[0].init, init);
  assert.equal(calls[0].init.body, init.body);
  assert.equal(JSON.parse(calls[0].init.body).amount, 523.95);
  assert.equal(mod.GOVERNANCE.orderCallsAdded, 0);
  assert.equal(mod.GOVERNANCE.providerCallsAdded, 0);
});
