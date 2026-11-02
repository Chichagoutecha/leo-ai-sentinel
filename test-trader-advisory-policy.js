'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('./trader-advisory-policy');
const { buildTraderExposureView } = require('./trader-exposure-link');
const START = Date.parse('2026-11-02T12:00:00Z'), DAY = 86400000;
const iso = n => new Date(n).toISOString();
function fixture(now = START, seq = 1) {
  const observationId = seq.toString(16).padStart(64, '0');
  const position = { key: 'DIRECT:100', instrumentId: 1, positionId: 100, isBuy: true, leverage: 1, investmentPct: 20 };
  const trader = { realCID: 7, status: 'PARTIAL', observationId, snapshot: { realCID: 7, identity: { realCID: 7, gcid: 8 },
    collectedAt: iso(now), portfolio: { status: 'PARTIAL', positions: [position], complete: false },
    performance: { monthly: [], historyComplete: null }, sources: { portfolio: 'https://public-api.etoro.com/public-test-fixture' } } };
  const observerView = { traders: [trader], events: [] };
  const observerState = { traders: { 7: { observationId, snapshot: trader.snapshot } }, events: [], observations: [{ id: observationId, realCID: 7, collectedAt: iso(now) }] };
  const portfolioResponse = { ok: true, accountEnvironment: 'REAL', fetchedAt: iso(now), data: { clientPortfolio: {
    positions: [{ positionId: 10, instrumentId: 1, amount: 100, unrealizedPnL: { pnL: 0 }, isBuy: true, leverage: 1, units: 10, settlementType: 'Underlying' }],
    mirrors: [], orders: [], ordersForOpen: [] } } };
  const exposure = buildTraderExposureView({ portfolioResponse, observerView, universe: [{ instrumentId: 1, symbol: 'AAPL', category: 'STOCK' }], now });
  return { now, observerView, observerState, exposure, ideas: [{ instrumentId: 1, side: 'BUY', amountUsd: 10, asOf: iso(now), ownAnalysisApproved: true, referencePrice: 10 }],
    quotes: { 1: { instrumentId: 1, mid: 10, asOf: iso(now), currency: 'USD' } },
    costs: { 1: { instrumentId: 1, side: 'BUY', asOf: iso(now), amountUsd: 10, currency: 'USD', contextBinding: 'VERIFIED_SAME_ACCOUNT', coverage: 'COMPLETE_ESTIMATE', allInCostPct: 0.2, unresolvedComponents: [] } },
    eligibility: { 1: { instrumentId: 1, side: 'BUY', asOf: iso(now), technicalEligible: true, leoPolicyAllowed: true, contextBinding: 'VERIFIED_SAME_ACCOUNT', currency: 'USD', leverage: 1, orderType: 'MARKET', settlementType: 'Underlying', minimumUsd: 1, maximumUsd: 100 } },
    sizingEvidence: { verified: true, currency: 'USD', lookThroughCoverage: 'COMPLETE', sourceType: 'OFFICIAL_ETORO_API', sourceUrl: 'https://public-api.etoro.com/test-fixture', asOf: iso(now), equityUsd: 1000, availableCashUsd: 500, maxInstrumentWeightPct: 20, minimumCashReserveUsd: 100 } };
}
function selected() {
  let state = policy.initialState();
  for (const [days, seq] of [[0, 1], [4, 2], [8, 3]]) state = policy.evaluate({ ...fixture(START + days * DAY, seq), state }).state;
  return { ...fixture(START + 8 * DAY, 3), state };
}
test('missing quality data never produce a good score or a best-trader ranking', () => {
  const r = policy.evaluate(fixture()).report;
  assert.equal(r.ranking.status, 'UNAVAILABLE');
  assert.equal(r.assessments[0].ranking.score, null);
  assert.equal(r.assessments[0].metrics.volatility.value, null);
  assert.equal(r.assessments[0].confidence.completeCriteria, 0);
  assert.equal(r.hypotheses.filter(h => h.status === 'UNAVAILABLE').length, 2);
});
test('copier count and recent gain do not select or rank traders', () => {
  const a = fixture(), b = fixture(); b.observerView.traders[0].snapshot.tradeStats = { metrics: { copiers: 1000000, gain: 10000 } };
  assert.deepEqual(policy.evaluate(a), policy.evaluate(b));
});
test('selection requires distinct observations and minimum duration; repeated evaluations cannot promote', () => {
  let a = fixture(), state = policy.evaluate(a).state;
  state = policy.evaluate({ ...a, now: START + 1000, state }).state;
  assert.equal(state.roster[7].qualifyingIds.length, 1);
  assert.equal(state.roster[7].state, 'PROBATION');
  assert.equal(selected().state.roster[7].state, 'SELECTED_CONTEXT_ONLY');
});
test('history depth reports gaps and partial completeness rather than computed returns', () => {
  const f = fixture(); f.observerView.traders[0].snapshot.performance.monthly = [{ timestamp: '2025-01-01T00:00:00Z', gain: 1 }, { timestamp: '2025-03-01T00:00:00Z', gain: 2 }];
  const a = policy.evaluate(f).report.assessments[0];
  assert.equal(a.metrics.history.contiguous, false); assert.equal(a.metrics.comparableReturn.value, null);
});
test('current LEO idea plus retained source gives an advisory review, never execution authority', () => {
  const r = policy.evaluate(selected()).report.proposals[0];
  assert.equal(r.status, 'ADVISORY_REVIEW_ONLY'); assert.equal(r.executionAllowed, false);
  assert.equal(r.preview.marginal.afterAssumingAllKnownPendingBuysFillUsd, 110);
  assert.equal(r.confidence, 'LOW_CONTEXT_ONLY'); assert.equal(r.traderSources.length, 1);
});
test('without own LEO idea there is no trade proposal; source positions never compel BUY', () => {
  assert.equal(policy.evaluate({ ...selected(), ideas: [] }).report.proposals.length, 0);
});
test('own risk veto always wins even if traders hold the same asset', () => {
  const f = selected(); f.ideas[0].hardVeto = true;
  assert.ok(policy.evaluate(f).report.proposals[0].vetoes.includes('LEO_ANALYSIS_OR_RISK_VETO'));
});
test('opposing or leveraged source positions block reinforcement instead of voting by headcount', () => {
  for (const row of [{ isBuy: false, leverage: 1 }, { isBuy: true, leverage: 3 }, { isBuy: null, leverage: 1 }]) {
    const f = selected(); Object.assign(f.observerView.traders[0].snapshot.portfolio.positions[0], row);
    assert.equal(policy.evaluate(f).report.proposals[0].status, 'VETOED_ADVISORY');
  }
});
test('reduction targets only the exact direct broker position and does not liquidate the asset', () => {
  const f = selected(); Object.assign(f.ideas[0], { side: 'SELL', positionId: '10' });
  Object.assign(f.costs[1], { side: 'SELL', amountUsd: 25 }); f.eligibility[1].side = 'SELL';
  const p = policy.evaluate(f).report.proposals[0];
  assert.equal(p.draft.quantityMode, 'UNITS'); assert.equal(p.draft.units, 2.5);
  assert.equal(p.preview.marginal.proposedDeltaUsd, -25); assert.equal(p.status, 'ADVISORY_REVIEW_ONLY');
  assert.equal(p.draft.positionId, '10');
});
test('full exit requires an explicit own LEO exit of one exact position', () => {
  const f = selected(); Object.assign(f.ideas[0], { side: 'SELL', positionId: '10', exitExplicit: true });
  Object.assign(f.costs[1], { side: 'SELL', amountUsd: 100 }); f.eligibility[1].side = 'SELL';
  assert.equal(policy.evaluate(f).report.proposals[0].draft.quantityMode, 'FULL_POSITION');
  f.ideas[0].positionId = 'unknown'; assert.equal(policy.evaluate(f).report.proposals[0].draft, null);
});
test('loss of visibility suspends, exits after delay, preserves tombstone and never proposes SELL', () => {
  const f = selected(); f.observerView.traders = []; f.ideas = [];
  const a = policy.evaluate(f); assert.equal(a.state.roster[7].state, 'SUSPENDED');
  const b = policy.evaluate({ ...f, state: a.state, now: f.now + 31 * DAY });
  assert.equal(b.state.roster[7].state, 'EXITED'); assert.equal(b.state.roster[7].everSelected, true);
  assert.deepEqual(b.report.proposals, []);
  const c = policy.evaluate({ ...fixture(b.report.generatedAt ? Date.parse(b.report.generatedAt) + DAY : 0, 4), state: b.state });
  assert.equal(c.state.roster[7].state, 'EXITED');
});
test('resuming visibility restarts probation; username rename does not create a new identity', () => {
  const f = selected(); f.observerView.traders[0].status = 'STALE'; const a = policy.evaluate(f);
  const g = fixture(f.now + DAY, 4); g.observerView.traders[0].snapshot.identity.username = 'new-name';
  const b = policy.evaluate({ ...g, state: a.state }); assert.equal(b.state.roster[7].state, 'PROBATION'); assert.equal(Object.keys(b.state.roster).length, 1);
});
test('duplicate and conflicting stable identities cannot become selected sources', () => {
  const f = selected(); f.observerView.traders.push(structuredClone(f.observerView.traders[0]));
  assert.equal(policy.evaluate(f).state.roster[7].state, 'SUSPENDED');
  const g = selected(); g.observerView.traders[0].snapshot.identity.gcid = 99;
  assert.equal(policy.evaluate(g).state.roster[7].state, 'SUSPENDED');
});
test('unknown, high, stale, foreign-currency or wrong-size costs block proposals', () => {
  for (const change of [{ allInCostPct: null }, { allInCostPct: 4 }, { asOf: iso(START) }, { currency: 'EUR' }, { amountUsd: 9 }, { unresolvedComponents: ['spread'] }]) {
    const f = selected(); Object.assign(f.costs[1], change); assert.equal(policy.evaluate(f).report.proposals[0].status, 'VETOED_ADVISORY');
  }
});
test('late LEO signals, missing reference price, stale quotes and excessive drift are vetoed', () => {
  for (const mutate of [f => { f.ideas[0].asOf = iso(START); }, f => { f.ideas[0].referencePrice = null; }, f => { f.quotes[1].asOf = iso(START); }, f => { f.quotes[1].mid = 12; }]) {
    const f = selected(); mutate(f); assert.equal(policy.evaluate(f).report.proposals[0].status, 'VETOED_ADVISORY');
  }
});
test('incomplete exposure, insufficient cash and unknown eligibility prevent advisory readiness', () => {
  for (const mutate of [f => { f.exposure.owned.coverage = 'INCOMPLETE'; }, f => { f.exposure.pending.status = 'INCOMPLETE'; }, f => { f.sizingEvidence.availableCashUsd = 100; }, f => { f.eligibility = {}; }]) {
    const f = selected(); mutate(f); assert.equal(policy.evaluate(f).report.proposals[0].status, 'VETOED_ADVISORY');
  }
});
test('corrections superseding an observation invalidate source provenance', () => {
  const f = selected(); f.observerState.observations.push({ corrects: f.observerView.traders[0].observationId });
  assert.ok(policy.evaluate(f).report.proposals[0].vetoes.some(v => v.includes('SOURCE')));
});
test('policy changes restart qualification and retain policy snapshots; invalid config is refused', () => {
  const f = selected(); const r = policy.evaluate({ ...f, overrides: { qualifyingObservations: 4 } });
  assert.equal(r.state.roster[7].state, 'PROBATION'); assert.equal(r.state.history.at(-1).policy.qualifyingObservations, 4);
  assert.throws(() => policy.config({ maxOrderUsd: -1 })); assert.throws(() => policy.config({ arbitrary: 1 }));
});
test('evaluation is deterministic, does not mutate inputs, rejects time reversal and bounds retained history', () => {
  const f = selected(), before = structuredClone(f); assert.deepEqual(policy.evaluate(f), policy.evaluate(f)); assert.deepEqual(f, before);
  assert.throws(() => policy.evaluate({ ...f, now: START }));
  const a = policy.evaluate({ ...f, overrides: { maxHistory: 1 } }); assert.equal(a.state.history.length, 1); assert.equal(a.state.historyTruncated, true);
  const compact = policy.compactState(a.state, 100); assert.ok(compact.disabledReason); assert.throws(() => policy.evaluate({ ...f, state: compact }));
});
test('module evaluation cannot reach network even with a valid proposal', () => {
  const original = global.fetch; global.fetch = () => { throw Error('NETWORK_FORBIDDEN'); };
  try { assert.equal(policy.evaluate(selected()).report.brokerCalls, 0); } finally { global.fetch = original; }
});
test('authenticated routes remain cache-only, reject injected evidence and persist only through the existing scheduler', async () => {
  const names = ['BOT_SECRET', 'TRADING_MODE', 'TRADER_ADVISORY_POLICY_JSON'];
  const saved = Object.fromEntries(names.map(k => [k, process.env[k]]));
  const originalFetch = global.fetch, originalTimer = global.setTimeout;
  try {
    Object.assign(process.env, { BOT_SECRET: 'ADVISORY_TEST_AUTH', TRADING_MODE: 'SHADOW', TRADER_ADVISORY_POLICY_JSON: '{}' });
    let calls = 0, scheduled = 0;
    global.fetch = () => { calls++; throw Error('NETWORK_FORBIDDEN'); };
    const { app, runtimeState, buildPersistentState } = require('./index');
    global.setTimeout = () => { scheduled++; return 0; };
    async function invoke(path, method, auth, body) {
      const route = app._router.stack.find(r => r.route?.path === path && r.route.methods[method]).route;
      let status = 200, output, allowed = false;
      const req = { query: {}, headers: auth ? { 'x-bot-secret': 'ADVISORY_TEST_AUTH' } : {}, body };
      const res = { status(v) { status = v; return this; }, json(v) { output = v; }, setHeader() {} };
      route.stack[0].handle(req, res, () => { allowed = true; });
      if (allowed) await route.stack[1].handle(req, res);
      return { status, output };
    }
    assert.equal((await invoke('/trader-advisory-evaluate', 'post', false, {})).status, 401);
    assert.equal((await invoke('/trader-advisory-evaluate', 'post', true, { costs: 'injected' })).status, 400);
    const a = await invoke('/trader-advisory-evaluate', 'post', true, {});
    assert.equal(a.status, 200); assert.equal(a.output.executionAllowed, false); assert.deepEqual(a.output.proposals, []);
    assert.equal(runtimeState.traderAdvisoryState.history.length, 1);
    assert.equal(buildPersistentState({ compact: false }).traderAdvisoryState.version, 1);
    const b = await invoke('/trader-advisory-status', 'get', true);
    assert.equal(b.output.report.evaluationId, a.output.evaluationId); assert.equal(calls, 0); assert.equal(scheduled, 1);
    process.env.TRADER_ADVISORY_POLICY_JSON = '{invalid';
    assert.equal((await invoke('/trader-advisory-evaluate', 'post', true, {})).status, 400);
  } finally {
    global.fetch = originalFetch; global.setTimeout = originalTimer;
    for (const k of names) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});
