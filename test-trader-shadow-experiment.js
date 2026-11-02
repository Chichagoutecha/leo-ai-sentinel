'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lab = require('./trader-shadow-experiment');
const { virtualFill } = require('./paper-shadow-execution');
const { calculateSizingHeadroom } = require('./trader-exposure-link');
const START = Date.parse('2026-11-02T12:00:00Z'), DAY = 86400000, iso = n => new Date(n).toISOString();
function fixture(now = START, n = 1) {
  const observationId = n.toString(16).padStart(64, '0');
  const snapshot = { realCID: 7, identity: { realCID: 7, gcid: 8 }, collectedAt: iso(now), receivedAt: iso(now), effectiveAt: null,
    portfolio: { status: 'PARTIAL', complete: false, positions: [{ key: 'DIRECT:100', instrumentId: 1, positionId: 100, isBuy: true, leverage: 1, investmentPct: 20 }] },
    performance: { monthly: [], historyComplete: null }, sources: { portfolio: 'https://public-api.etoro.com/test-fixture' } };
  const q = { mid: 10, ask: 10, bid: 10, date: iso(now), receivedAt: iso(now), priceStatus: 'FRESH', eligibleForTrade: true, source: 'TEST_FIXTURE' };
  return { now, cycleId: `decision-${String(n).padStart(8, '0')}`, mode: 'SHADOW', universe: [{ symbol: 'AAPL', instrumentId: 1, category: 'STOCK' }, { symbol: 'SPY', instrumentId: 2, category: 'ETF' }],
    rawDecision: { decision: 'BUY', asset: 'AAPL', amount_usd: 10 }, control: { approved: true, finalDecision: { decision: 'BUY', asset: 'AAPL', amount_usd: 10 }, code: 'APPROVED' },
    template: { cash: 1000, positions: { AAPL: { asset: 'AAPL', units: 10, costBasis: 100, currentPrice: 10, currentValue: 100, averageEntryPrice: 10, openedAt: iso(START - DAY) } }, seedCoverage: { complete: true, omittedAssets: [] } },
    quotes: { AAPL: q, SPY: { ...q } }, observerView: { traders: [{ realCID: 7, observationId, status: 'PARTIAL', snapshot }] },
    observerState: { traders: { 7: { observationId, snapshot } }, observations: [{ id: observationId, realCID: 7, collectedAt: iso(now), receivedAt: iso(now) }], events: [] },
    costs: { 1: { instrumentId: 1, side: 'BUY', asOf: iso(now), amountUsd: 10, currency: 'USD', contextBinding: 'VERIFIED_SAME_ACCOUNT', coverage: 'COMPLETE_ESTIMATE', allInCostPct: 0.2, unresolvedComponents: [] } },
    eligibility: { 1: { instrumentId: 1, side: 'BUY', asOf: iso(now), technicalEligible: true, leoPolicyAllowed: true, contextBinding: 'VERIFIED_SAME_ACCOUNT', minimumUsd: 1, maximumUsd: 100, currency: 'USD', leverage: 1, orderType: 'MARKET', settlementType: 'Underlying' } },
    pendingComplete: true, constraintsEvidence: { verified: true, virtualOnly: true, currency: 'USD', lookThroughCoverage: 'COMPLETE', asOf: iso(now) },
    advisoryOverrides: { qualifyingObservations: 1, probationDays: 0.001 }, experimentOverrides: { designDays: 1, evaluationDays: 10, minimumEvaluationDays: 3, minimumDecisions: 2, minimumFullClosures: 1 },
    assumptions: { feePct: 0.1, slippageBps: 1, benchmarkAsset: 'SPY', benchmarkCurrency: 'USD' } };
}
function warm() { return lab.runCycle(fixture()).state; }
function second() { return { ...fixture(START + 120000, 2), state: warm() }; }
test('protocol is registered before outcomes, immutable, and separates design/evaluation books', () => {
  const a = lab.runCycle(fixture()); assert.equal(a.phase, 'DESIGN');
  assert.equal(a.state.protocol.registeredAt, iso(START));
  assert.ok(a.state.protocol.criteria.includes('PAIRED_FLOW_ADJUSTED_RETURN_DIFFERENCE'));
  const f = fixture(START + DAY + 1000, 2), b = lab.runCycle({ ...f, state: a.state });
  assert.equal(b.phase, 'EVALUATION'); assert.equal(b.state.phases.EVALUATION.strategy.createdAt, iso(f.now));
  assert.equal(b.state.phases.EVALUATION.strategy.startingCash, 1000);
  const changed = lab.runCycle({ ...fixture(START + 2 * DAY, 3), state: b.state, advisoryOverrides: { ...f.advisoryOverrides, maxOrderUsd: 8 } });
  assert.equal(changed.status, 'FROZEN_PROTOCOL_MISMATCH_NEW_EXPERIMENT_REQUIRED');
  assert.equal(changed.state.records.length, 2);
});
test('both arms share real LEO ideas, market windows and common constraints; source filtering is the difference', () => {
  const a = lab.runCycle(fixture()), record = a.state.records[0];
  assert.equal(record.arms.strategy.final, 'HOLD'); assert.equal(record.arms.baseline.final, 'BUY');
  assert.equal(record.arms.baseline.simulation.price, 10.001);
  assert.deepEqual(record.arms.baseline.proposal.traderSources, []);
  const b = lab.runCycle({ ...fixture(START + 120000, 2), state: a.state });
  assert.equal(b.state.records[1].arms.strategy.final, 'BUY');
  assert.equal(b.state.records[1].observations[0].publishedAt, null);
  assert.equal(b.state.records[1].observations[0].receivedAt, iso(START + 120000));
});
test('hard LEO veto and unknown costs block both arms rather than giving the baseline looser constraints', () => {
  for (const mutate of [f => { f.control.approved = false; }, f => { f.costs = {}; }, f => { f.pendingComplete = false; }, f => { f.constraintsEvidence = null; }]) {
    const f = second(); mutate(f); const r = lab.runCycle(f).state.records.at(-1);
    assert.equal(r.arms.strategy.final, 'HOLD'); assert.equal(r.arms.baseline.final, 'HOLD');
  }
});
test('future receipts and publications cannot enter the frozen observation set', () => {
  for (const key of ['receivedAt', 'publishedAt', 'effectiveAt']) {
    const f = second(); f.observerView.traders[0].snapshot[key] = iso(f.now + 1000);
    const r = lab.runCycle(f).state.records.at(-1); assert.deepEqual(r.observations, []); assert.equal(r.arms.strategy.final, 'HOLD');
  }
});
test('late corrections affect only later decisions and never rewrite frozen records', () => {
  const a = lab.runCycle(second()), original = JSON.stringify(a.state.records);
  const f = fixture(START + 240000, 3); f.observerState.observations.push({ id: 'f'.repeat(64), realCID: 7, collectedAt: iso(START), receivedAt: iso(f.now), corrects: a.state.records[1].observations[0].observationId });
  f.observerView.traders[0].snapshot.portfolio.positions[0].isBuy = false;
  const b = lab.runCycle({ ...f, state: a.state });
  assert.equal(JSON.stringify(b.state.records.slice(0, 2)), original);
  assert.equal(b.state.records.at(-1).arms.strategy.final, 'HOLD');
  assert.equal(JSON.stringify(a.state.records), original);
});
test('same cycle/signals replayed or corrected are idempotent and backdated cycles are refused', () => {
  const f = fixture(), a = lab.runCycle(f), duplicate = lab.runCycle({ ...fixture(START + 5000, 1), state: a.state });
  assert.equal(duplicate.status, 'DUPLICATE_CYCLE_ID'); assert.equal(duplicate.state.phases.DESIGN.baseline.orders.length, 1);
  assert.equal(lab.runCycle({ ...fixture(START - 1, 3), state: a.state }).status, 'DUPLICATE_OR_NON_CHRONOLOGICAL_CYCLE');
});
test('missing, stale and future quotes prevent virtual fills in both arms and mark incomplete coverage', () => {
  for (const mutate of [f => { delete f.quotes.AAPL; }, f => { f.quotes.AAPL.date = iso(START - DAY); }, f => { f.quotes.AAPL.receivedAt = iso(f.now + 1); }]) {
    const f = second(); mutate(f); const r = lab.runCycle(f);
    assert.equal(r.state.records.at(-1).arms.baseline.final, 'HOLD');
    assert.equal(r.state.phases.DESIGN.strategy.snapshots.at(-1).valuationComplete, false);
  }
});
test('future costs or permission evidence cannot authorize a past fill', () => {
  const f = second(); f.costs[1].receivedAt = iso(f.now + 1);
  const r = lab.runCycle(f).state.records.at(-1);
  assert.ok(r.arms.strategy.vetoes.includes('EVIDENCE_RECEIVED_AFTER_DECISION')); assert.equal(r.arms.baseline.final, 'HOLD');
});
test('reductions and full exits are measured, with proportional cost basis and no synthetic broker lots', () => {
  const f = second(); f.rawDecision.decision = 'SELL'; f.control.finalDecision.decision = 'SELL';
  Object.assign(f.costs[1], { side: 'SELL', amountUsd: 25 }); f.eligibility[1].side = 'SELL';
  const r = lab.runCycle(f); assert.equal(r.state.records.at(-1).arms.strategy.final, 'SELL');
  assert.equal(r.state.phases.DESIGN.strategy.positions.AAPL.units, 7.5);
  assert.equal(r.state.phases.DESIGN.strategy.positions.AAPL.costBasis, 75);
  assert.equal(r.state.phases.DESIGN.reductions.strategy, 1); assert.equal(r.state.phases.DESIGN.fullClosures.strategy, 0);
  const full = second(); full.rawDecision.decision = 'SELL'; full.control.finalDecision.decision = 'SELL'; full.exitExplicit = true;
  Object.assign(full.costs[1], { side: 'SELL', amountUsd: 100 }); full.eligibility[1].side = 'SELL';
  const exit = lab.runCycle(full); assert.equal(exit.state.phases.DESIGN.fullClosures.strategy, 1);
  assert.equal(exit.state.phases.DESIGN.strategy.positions.AAPL, undefined);
});
test('paired deposits/withdrawals are idempotent, preserve decisions and use the shared flow-aware scorecard', () => {
  const a = lab.runCycle(fixture()), record = JSON.stringify(a.state.records);
  const at = START + 300000, f = fixture(at, 2), flow = { id: 'deposit-0001', type: 'DEPOSIT', amount: 100, currency: 'USD' };
  const b = lab.applyFlow({ state: a.state, now: at, mode: 'SHADOW', flow, quotes: f.quotes });
  assert.equal(b.status, 'PAIRED_FLOW_RECORDED'); assert.equal(JSON.stringify(b.state.records), record);
  assert.equal(b.state.phases.DESIGN.strategy.cash, 1100);
  assert.equal(lab.applyFlow({ state: b.state, now: at, mode: 'SHADOW', flow, quotes: f.quotes }).status, 'DUPLICATE_FLOW');
  assert.throws(() => lab.applyFlow({ state: b.state, now: at, mode: 'SHADOW', flow: { ...flow, amount: 50 }, quotes: f.quotes }));
  assert.throws(() => lab.applyFlow({ state: b.state, now: at, mode: 'SHADOW', flow: { ...flow, id: 'withdraw-0001', type: 'WITHDRAWAL', amount: 5000 }, quotes: f.quotes }));
  const c = lab.runCycle({ ...fixture(START + 600000, 3), state: b.state });
  const report = lab.report(c.state).phases.DESIGN;
  assert.equal(report.strategy.activity.cashFlows.deposits, 100);
  assert.equal(report.strategy.return.flowAdjusted.status, 'APPROXIMATE');
  assert.ok(Math.abs(report.strategy.return.flowAdjusted.returnPct) < 1);
  assert.equal(report.strategy.costs.observedBrokerFees, null);
  assert.ok(report.strategy.costs.unknown.includes('FX_COSTS'));
});
test('cash flow with missing marks blocks flow-adjusted results; late flows cannot be backfilled', () => {
  const a = lab.runCycle(fixture()), flow = { id: 'deposit-0001', type: 'DEPOSIT', amount: 100, currency: 'USD' };
  const b = lab.applyFlow({ state: a.state, mode: 'SHADOW', now: START + 10000, flow, quotes: {} });
  assert.equal(lab.report(b.state).phases.DESIGN.strategy.return.flowAdjusted.status, 'UNAVAILABLE');
  assert.throws(() => lab.applyFlow({ state: b.state, mode: 'SHADOW', now: START, flow, quotes: {} }));
});
test('reports expose sample limits, costs, windows and refuse reliable performance comparison on design data', () => {
  const r = lab.report(lab.runCycle(second()).state);
  assert.equal(r.virtualOnly, true); assert.equal(r.additionalCalls.ai, 0); assert.equal(r.additionalInfrastructureCostUsd, null);
  assert.ok(r.phases.DESIGN.comparison.reasons.includes('DESIGN_PERIOD_NOT_OUT_OF_SAMPLE'));
  assert.equal(r.phases.DESIGN.comparison.flowAdjustedDifferencePct, null);
  assert.equal(r.phases.DESIGN.strategy.return.benchmark.returnType, 'PRICE_RETURN_ONLY');
});
test('a predeclared evaluation window can yield only a descriptive paired difference after sample and coverage criteria', () => {
  let state = lab.runCycle(second()).state;
  const sell = fixture(START + DAY, 3); sell.rawDecision.decision = 'SELL'; sell.control.finalDecision.decision = 'SELL'; sell.exitExplicit = true;
  Object.assign(sell.costs[1], { side: 'SELL', amountUsd: 100 }); sell.eligibility[1].side = 'SELL';
  state = lab.runCycle({ ...sell, state }).state;
  const hold = fixture(START + 2 * DAY, 4); hold.rawDecision.decision = 'HOLD'; hold.control.finalDecision.decision = 'HOLD';
  state = lab.runCycle({ ...hold, state }).state;
  const buy = fixture(START + 3 * DAY, 5); buy.observerView.traders[0].snapshot.portfolio.positions[0].isBuy = false;
  state = lab.runCycle({ ...buy, state }).state;
  const last = fixture(START + 4 * DAY, 6); last.rawDecision.decision = 'HOLD'; last.control.finalDecision.decision = 'HOLD';
  state = lab.runCycle({ ...last, state }).state;
  const r = lab.report(state).phases.EVALUATION;
  assert.equal(r.durationDays, 3); assert.equal(r.fullClosures.strategy, 1); assert.equal(r.fullClosures.baseline, 1);
  assert.equal(r.comparison.status, 'DESCRIPTIVE_CONDITIONAL_COMPARISON'); assert.equal(r.comparison.significance, 'NOT_ESTIMATED');
  assert.equal(typeof r.comparison.flowAdjustedDifferencePct, 'number');
});
test('benchmark currency mismatch and a closed evaluation window remain explicit', () => {
  const f = fixture(); f.assumptions.benchmarkCurrency = 'EUR';
  const a = lab.runCycle(f), score = lab.report(a.state).phases.DESIGN.strategy;
  assert.equal(score.return.benchmark.returnPct, null);
  assert.equal(lab.runCycle({ ...f, now: START + 12 * DAY, cycleId: 'after-window', state: a.state }).status, 'EVALUATION_WINDOW_CLOSED');
});
test('same retained source with a new LEO decision is contextual evidence, not a newly inferred trader transaction', () => {
  const f = second(), a = lab.runCycle(f), g = fixture(f.now + 1000, 3);
  g.observerView = f.observerView; g.observerState = f.observerState;
  const b = lab.runCycle({ ...g, state: a.state });
  assert.equal(b.state.records.at(-1).observations[0].observationId, a.state.records.at(-1).observations[0].observationId);
  assert.equal(b.state.records.at(-1).observations[0].proof, 'PARTIAL_PUBLIC_POSITION_PRESENCE_NOT_TRANSACTION');
});
test('observable upstream read responses are counted once, with unknown costs and future responses excluded', () => {
  const f = fixture();
  const reads = Object.fromEntries(['identity', 'portfolio', 'performance', 'tradeStats', 'identityConfirmation'].map(k => [k, { collectedAt: iso(START), httpStatus: 200 }]));
  f.observerView.traders[0].snapshot.reads = reads;
  f.observerView.traders[0].lastAttempt = { reads: Object.values(reads) };
  const a = lab.runCycle(f);
  assert.equal(a.state.records[0].newlyObservedUpstreamReadResponses, 5);
  const g = fixture(START + 120000, 2); g.observerView.traders[0].snapshot.reads = reads;
  const b = lab.runCycle({ ...g, state: a.state });
  assert.equal(b.state.records.at(-1).newlyObservedUpstreamReadResponses, 0);
  assert.equal(lab.report(b.state).upstreamObserverCallsAndCost.knownReadResponses, 5);
  assert.equal(lab.report(b.state).upstreamObserverCallsAndCost.costUsd, null);
  const future = fixture(); future.observerView.traders[0].snapshot.reads = { identity: { collectedAt: iso(START + 1), httpStatus: 200 } };
  assert.equal(lab.runCycle(future).state.observedUpstreamResponses, 0);
});
test('bounded retention and persistence budgets are explicit and never silently reset the experiment', () => {
  const f = fixture(); f.experimentOverrides.maxRecords = 1;
  const a = lab.runCycle(f), b = lab.runCycle({ ...fixture(START + 120000, 2), experimentOverrides: f.experimentOverrides, state: a.state });
  assert.equal(b.state.historyTruncated, true); assert.equal(b.state.records.length, 1);
  const tiny = lab.compact(b.state, 200);
  assert.ok(tiny.disabledReason); assert.equal(lab.runCycle({ ...fixture(START + 240000, 3), state: tiny }).status, 'ARCHIVE_REQUIRED');
});
test('only whitelisted evidence fields are retained; secret-like extra fields never enter decision records', () => {
  const f = fixture(); f.costs[1].apiKey = 'SECRET_NOT_RETAINED'; f.eligibility[1].token = 'SECRET_NOT_RETAINED';
  f.realExposure = { coverage: 'INCOMPLETE', headers: { authorization: 'SECRET_NOT_RETAINED' } };
  assert.ok(!JSON.stringify(lab.runCycle(f).state.records).includes('SECRET_NOT_RETAINED'));
});
test('deterministic shared executor handles reinforcement/reduction, fees and rejects invalid units without mutation', () => {
  const f = fixture(), before = structuredClone(f.template), opts = { now: START, orderId: 'order1', feePct: 1, slippageBps: 0, tradable: true, allowReinforcement: true };
  const a = virtualFill(f.template, { asset: 'AAPL', side: 'BUY', amount: 10 }, f.quotes.AAPL, opts);
  assert.equal(a.paper.positions.AAPL.units, 11); assert.equal(a.paper.cash, 989.9); assert.deepEqual(f.template, before);
  const b = virtualFill(a.paper, { asset: 'AAPL', side: 'SELL', units: 2 }, f.quotes.AAPL, opts);
  assert.equal(b.paper.positions.AAPL.units, 9); assert.equal(b.result.proceeds, 19.8);
  assert.equal(virtualFill(a.paper, { asset: 'AAPL', side: 'SELL', units: 999 }, f.quotes.AAPL, opts).result.ok, false);
  assert.equal(virtualFill(a.paper, { asset: 'AAPL', side: 'BUY', amount: null }, f.quotes.AAPL, opts).result.ok, false);
});
test('non-SHADOW runs and experiment evaluation never call any network or broker path', () => {
  const original = global.fetch; let calls = 0; global.fetch = () => { calls++; throw Error('EXECUTION_FORBIDDEN'); };
  try {
    assert.equal(lab.runCycle({ ...fixture(), mode: 'LIVE' }).status, 'SHADOW_REQUIRED');
    assert.equal(lab.runCycle(second()).status, 'RECORDED_VIRTUAL_PAIR'); assert.equal(calls, 0);
  } finally { global.fetch = original; }
});
test('virtual ledger evidence cannot qualify a real account exposure view or grant execution authority', () => {
  const view = { owned: { coverage: 'COMPLETE', unreconstructedRisk: [], knownValuesByInstrument: {} }, pending: { status: 'COMPLETE_KNOWN_BUY_UPPER_BOUND', knownBuyUpperBoundByInstrument: {} } };
  const evidence = { verified: true, virtualOnly: true, currency: 'USD', lookThroughCoverage: 'COMPLETE', sourceType: 'VIRTUAL_SHADOW_LEDGER', sourceUrl: 'local:shadow-ledger', asOf: iso(START), equityUsd: 1000, availableCashUsd: 500 };
  const caps = { maxOrderUsd: 10, maxInstrumentWeightPct: 15, minimumCashReserveUsd: 200 };
  assert.equal(calculateSizingHeadroom(view, 1, evidence, caps, START).status, 'UNAVAILABLE');
  view.owned.scope = 'VIRTUAL_EXPERIMENT_ONLY';
  assert.equal(calculateSizingHeadroom(view, 1, evidence, caps, START).headroomUsd, 10);
});
test('actual scan hook and SHADOW final dispatcher share virtual accounting and cannot issue BUY/SELL HTTP calls', async () => {
  const keys = ['TRADING_MODE', 'PAPER_SEED_FROM_REAL', 'BOT_SECRET']; const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const original = global.fetch, timer = global.setTimeout;
  try {
    Object.assign(process.env, { TRADING_MODE: 'SHADOW', PAPER_SEED_FROM_REAL: 'false', BOT_SECRET: 'SHADOW_TEST' });
    const app = require('./index'); let calls = 0;
    global.fetch = () => { calls++; throw Error('EXECUTION_FORBIDDEN'); }; global.setTimeout = () => 0;
    const now = Date.now(), q = { ...fixture(now).quotes.AAPL, ageMinutes: 0 }, marketSummary = { ratesByAsset: { SPY: q }, provider: 'TEST_FIXTURE' };
    app.ensurePaperPortfolio({ availableCash: 1000, aggregatedPositions: [] }, marketSummary);
    const md = { normalized: marketSummary }, control = { approved: true, finalDecision: { decision: 'BUY', asset: 'SPY', amount_usd: 10 } };
    const hook = app.recordTraderShadowScan({ realPortfolio: { ok: true, accountEnvironment: 'REAL', fetchedAt: iso(now), data: { clientPortfolio: { positions: [], mirrors: [], orders: [], ordersForOpen: [] } } }, marketSummary },
      { decision: 'BUY', asset: 'SPY', amount_usd: 10 }, control, null, 'actual-scan-0001', now);
    assert.equal(hook.status, 'RECORDED_VIRTUAL_PAIR');
    const buy = await app.executeControlledDecision(control, md); assert.equal(buy.simulated, true);
    const sell = await app.executeControlledDecision({ approved: true, finalDecision: { decision: 'SELL', asset: 'SPY' } }, md); assert.equal(sell.simulated, true);
    assert.equal(calls, 0); assert.equal(app.runtimeState.traderShadowExperiment.records.length, 1);
    const savedState = app.buildPersistentState({ compact: false }); assert.equal(savedState.traderShadowExperiment.version, 1);
    assert.equal(app.app._router.stack.some(r => r.route?.path === '/trader-shadow-status'), true);
  } finally { global.fetch = original; global.setTimeout = timer; for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
