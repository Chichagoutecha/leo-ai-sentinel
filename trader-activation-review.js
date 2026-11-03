'use strict';
// Offline rehearsal only. No main server, scheduler, environment credentials or broker transport.
const assert = require('node:assert/strict');
const b = require('./trader-execution-bridge');
const lab = require('./trader-shadow-experiment');
const { audit } = require('./etoro-read-access-audit');
const { emptyState } = require('./trader-observer');
const { createTraderReadClient, createTraderObserver } = require('./etoro-trader-observer');
const f = require('./activation-review-fixtures');
const { fixture, START, iso } = require('./activation-shadow-fixture');

async function rehearse() {
  const scenarios = [];
  const record = (name, details = {}, status = 'PASS_MOCK') => scenarios.push({ name, status, ...details });
  let networkCalls = 0;
  const access = await audit({ env: {}, fetchImpl: async () => { networkCalls++; throw Error('NETWORK_FORBIDDEN'); } });
  assert.equal(access.requests, 0); assert.equal(networkCalls, 0);
  assert.ok(access.checks.every(c => c.status === 'NOT_TESTED'));
  record('missing_credentials', { statusObserved: 'NOT_TESTED', authenticatedRequests: 0 });

  // All transport is injected. The hypothetical privacy change is known to the simulator,
  // not proven by a 403, and is therefore correctly reported as unavailable by the observer.
  let privateNow = false, observerReads = 0, clock = START;
  const env = { ETORO_API_KEY: 'SYNTHETIC', ETORO_USER_KEY: 'SYNTHETIC', TRADER_OBSERVER_TRADERS_JSON: '[{"realCID":7}]' };
  const client = createTraderReadClient({ env, clock: () => clock, fetchImpl: async url => {
    observerReads++;
    const path = new URL(url).pathname;
    if (path.endsWith('/portfolio/live') && privateNow) return new Response('{"sensitive":"MUST_NOT_RETAIN"}', { status: 403 });
    const data = path.endsWith('/people') ? { users: [{ realCID: 7, gcid: 8, username: 'SyntheticTrader' }] }
      : path.endsWith('/portfolio/live') ? { positions: [{ positionId: 100, instrumentId: 1, isBuy: true, leverage: 1, investmentPct: 20 }], socialTrades: [] }
      : path.endsWith('/gain') ? { monthly: [], yearly: [] } : { userName: 'SyntheticTrader', riskScore: 3, trades: 10 };
    return new Response(JSON.stringify(data));
  } });
  const observerState = emptyState();
  const observer = createTraderObserver({ env, client, clock: () => clock, getState: () => observerState, onChange: () => {}, minIntervalMs: 1000 });
  await observer.refresh(7);
  const observed = observer.view();
  assert.equal(observed.traders[0].status, 'PARTIAL');
  const readsBeforeView = observerReads; observer.view(); assert.equal(observerReads, readsBeforeView);
  record('official_read_adapter_mock', { simulatedReads: observerReads, portfolioCoverage: 'PARTIAL', transactionHistory: 'UNAVAILABLE', dashboardExtraReads: 0 });

  // Pass the actual normalized observer output through exposure/policy/paired virtual books.
  // Clock and identities are synthetic; no synthetic REAL evidence is derived from a virtual book.
  const warm = fixture(); warm.observerView = observed; warm.observerState = observerState;
  const first = lab.runCycle(warm);
  clock += 120000; await observer.refresh(7);
  const secondInput = { ...fixture(clock, 2), state: first.state, observerView: observer.view(), observerState };
  const second = lab.runCycle(secondInput), decision = second.state.records.at(-1).arms.strategy;
  assert.equal(decision.final, 'BUY'); assert.equal(decision.simulation.executionAttempted, false);
  record('observer_exposure_policy_shadow', { decision: decision.final, virtualOnly: true, executionAttempted: false, qualification: 'RELAXED_SYNTHETIC_DESIGN_ONLY' });
  const h = f.harness(); const proposal = { ...f.buy(), traderSources: decision.proposal.traderSources };
  h.queue(proposal); assert.equal((await h.controller.drain()).status, 'CONFIRMED');
  h.queue(f.buy('reinforce')); await h.controller.drain();
  h.config = { ...f.settings(), entriesEnabled: false };
  h.queue(f.sell('exit', 2)); assert.equal((await h.controller.drain()).status, 'CONFIRMED');
  assert.deepEqual(h.state.managed, {});
  record('normal_executor_adapter_mock_round_trip', { simulatedAdapterCalls: h.calls.length, sides: h.calls.map(c => c.side), durableReservations: true, entriesDisabledBeforeExit: true,
    limitation: 'Bridge evidence and normal executor are simulated separately; this is not a production activation or a full start-preload integration proof.' });

  const frozen = JSON.stringify(second.state.records);
  for (const [name, mutate] of [
    ['lost_quote', x => { delete x.quotes.AAPL; }],
    ['unknown_costs', x => { x.costs = {}; }],
    ['late_signal', x => { x.observerView.traders[0].snapshot.receivedAt = iso(x.now + 1); }],
    ['opposing_source', x => { x.observerView.traders[0].snapshot.portfolio.positions[0].isBuy = false; }]
  ]) {
    const input = { ...fixture(START + 240000, 3), state: structuredClone(second.state) }; mutate(input);
    const result = lab.runCycle(input); assert.equal(result.state.records.at(-1).arms.strategy.final, 'HOLD');
    assert.equal(JSON.stringify(second.state.records), frozen);
    record(name, { decision: 'HOLD', earlierDecisionsUnchanged: true });
  }
  privateNow = true; clock += 120000; await observer.refresh(7);
  const hidden = observer.view();
  assert.equal(hidden.traders[0].snapshot.portfolio.reason, 'FORBIDDEN_PRIVACY_UNPROVEN');
  assert.ok(!JSON.stringify(hidden).includes('MUST_NOT_RETAIN'));
  const denied = lab.runCycle({ ...fixture(clock, 4), state: second.state, observerView: hidden, observerState });
  assert.equal(denied.state.records.at(-1).arms.strategy.final, 'HOLD');
  record('trader_becomes_private_simulated_403', { decision: 'HOLD', privacyProven: false, reason: 'FORBIDDEN_PRIVACY_UNPROVEN', automaticLiquidation: false });

  for (const [name, mutate] of [
    ['price_drift', e => { e.quote.bid = 15; e.quote.ask = 15; }],
    ['stale_quote', e => { e.quote.asOf = '2020-01-01'; }],
    ['lost_identity', e => { e.tokenBindingVerified = false; }],
    ['unknown_pending', e => { e.pendingComplete = false; }]
  ]) {
    const x = f.harness({ mutate }); x.queue(f.buy());
    assert.equal((await x.controller.drain()).status, 'VETOED'); assert.equal(x.calls.length, 0);
    record(name, { decision: 'VETOED', simulatedAdapterCalls: 0 });
  }
  for (const outcome of ['REJECTED', 'NETWORK', 'ACK', 'AMBIGUOUS']) {
    const x = f.harness({ outcome }); x.queue(f.buy()); const result = await x.controller.drain();
    const expected = outcome === 'REJECTED' ? 'REJECTED' : 'NEEDS_RECONCILIATION'; assert.equal(result.status, expected);
    const restarted = f.harness({ state: b.recover(JSON.parse(JSON.stringify(x.state))) });
    await restarted.controller.drain(); assert.equal(restarted.calls.length, 0);
    record(`broker_${outcome.toLowerCase()}_restart`, { decision: expected, automaticResendsAfterRestart: 0 });
  }
  const partial = f.harness({ outcome: 'PARTIAL' }); partial.queue(f.buy());
  const partialResult = await partial.controller.drain();
  assert.equal(partialResult.status, 'NEEDS_RECONCILIATION'); assert.equal(partial.state.managed['101'].units, 0.4);
  assert.equal(partial.state.managed['101'].status, 'RECONCILIATION_REQUIRED');
  record('partial_buy_without_order_finality', { requestedUsd: 10, observedUnits: 0.4, statusObserved: partialResult.status,
    complete: false, automaticResend: false });
  const reductions = f.harness(); reductions.queue(f.buy()); await reductions.controller.drain();
  reductions.queue({ ...f.sell(), units: 0.25, quantityMode: 'UNITS' });
  assert.ok((await reductions.controller.drain()).vetoes.includes('PARTIAL_CLOSE_NOT_RELIABLY_SUPPORTED'));
  record('partial_reduction', { decision: 'VETOED', replacementFullSale: false });
  const capped = f.harness(); capped.queue(f.buy()); await capped.controller.drain();
  capped.config = { ...f.settings(), maxExitNotionalUsd: 5 }; capped.queue(f.sell());
  assert.ok((await capped.controller.drain()).vetoes.includes('FULL_EXIT_EXCEEDS_ORDER_CAP_PARTIAL_CLOSE_UNSUPPORTED'));
  record('full_exit_over_cap', { decision: 'VETOED', requiresApprovedExitPolicy: true }, 'BLOCKER_REPRODUCED');
  const stopped = f.initialized(); stopped.emergencyStop = true;
  const stop = f.harness({ state: stopped }); stop.queue(f.buy()); assert.equal((await stop.controller.drain()).status, 'VETOED'); assert.equal(stop.calls.length, 0);
  record('bridge_stop', { simulatedAdapterCalls: 0, scope: 'TRADER_BRIDGE_ONLY', stopsOtherOrderPaths: 'NOT_PROVEN' });
  return { schemaVersion: 1, kind: 'OFFLINE_SYNTHETIC_REHEARSAL', fixtureTime: iso(START), conclusion: 'BLOCKED', realNetworkCalls: networkCalls,
    realBrokerAccess: 'NOT_TESTED', realProductionShadowResults: 'UNAVAILABLE', tokenBinding: 'TOKEN_BINDING_UNVERIFIED',
    scenarios, designSimulation: { retainedDecisions: second.state.records.length, phase: 'DESIGN', durationSeconds: 120,
      virtualOnly: true, evaluationSampleSufficient: false, report: lab.report(second.state) },
    limitations: ['All identities, prices, permissions and fills are simulated.', 'No production runtime or start preloads were started.',
      'No profitability or broker access conclusion follows from these tests.', 'No global execution stop is implemented by the bridge route.'] };
}
module.exports = { rehearse };
if (require.main === module) rehearse().then(r => process.stdout.write(JSON.stringify(r, null, 2) + '\n')).catch(() => {
  process.stderr.write('OFFLINE_REHEARSAL_FAILED\n'); process.exitCode = 1;
});
