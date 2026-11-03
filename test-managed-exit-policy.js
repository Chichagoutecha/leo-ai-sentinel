'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessClose } = require('./managed-exit-policy');
const bridge = require('./trader-execution-bridge');
const f = require('./activation-review-fixtures');

test('a managed holding above the BUY cap can close within the separate SELL cap', () => {
  const p = { ...f.sell(), referencePrice: 20 };
  const e = f.evidence(p, [f.row()]);
  Object.assign(e.quote, { bid: 20, ask: 20 });
  const state = f.initialized();
  state.managed['101'] = { ...f.row(), accountRef: state.accountRef, status: 'VERIFIED_MANAGED' };
  assert.deepEqual(bridge.preflight(state, p, e, { ...f.settings(), maxOrderUsd: 10, maxExitNotionalUsd: 20 }, f.NOW), []);
  assert.ok(assessClose(p, e, { ...f.settings(), maxExitNotionalUsd: undefined }, f.NOW).reasons.includes('EXIT_CAP_REVIEW_REQUIRED'));
});

test('entry screens lower and higher prices and leaves capacity for a close', () => {
  const p = f.buy();
  const e = f.evidence(p);
  const result = assessClose(p, e, f.settings(), f.NOW);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.futureAvailabilityGuaranteed, false);
  e.closeTerms.minimumUsd = 10;
  assert.ok(assessClose(p, e, f.settings(), f.NOW).reasons.includes('FULL_CLOSE_SIZE_OUTSIDE_LIMITS'));
  e.closeTerms.minimumUsd = 1;
  e.limits.exitSlotAfterEntry = false;
  const blocked = assessClose(p, e, { ...f.settings(), maxExitNotionalUsd: 10 }, f.NOW);
  assert.ok(blocked.reasons.includes('EXIT_CAPACITY_UNAVAILABLE'));
  assert.ok(blocked.reasons.includes('FULL_EXIT_EXCEEDS_ORDER_CAP_PARTIAL_CLOSE_UNSUPPORTED'));
});

test('entry with missing CLOSE terms, mismatched product, or undersized quantity range is vetoed', () => {
  const p = f.buy();
  for (const change of [
    e => { e.closeTerms = null; },
    e => { e.closeTerms.settlementType = 'CFD'; },
    e => { e.closeTerms.projectedMaxUnits = 1; },
    e => { e.closeTerms.maximumCostUsd = 2; },
  ]) {
    const e = f.evidence(p); change(e);
    assert.ok(bridge.preflight(f.initialized(), p, e, f.settings(), f.NOW).some(reason =>
      ['FULL_CLOSE_TERMS_UNVERIFIED', 'EXIT_QUANTITY_UNVERIFIED'].includes(reason)));
  }
});

test('closed market or sharp fall below minimum escalates without another liquidation', async () => {
  for (const closed of [true, false]) {
    const state = f.initialized();
    state.managed['101'] = { ...f.row(), accountRef: state.accountRef, status: 'VERIFIED_MANAGED' };
    const p = { ...f.sell(), referencePrice: 0.5 };
    const h = f.harness({ state, positions: [f.row()], mutate(e) {
      Object.assign(e.quote, { bid: 0.5, ask: 0.5, tradable: !closed });
    } });
    h.queue(p);
    const result = await h.controller.drain();
    assert.ok(result.vetoes.includes(closed ? 'EXIT_MARKET_UNAVAILABLE' : 'FULL_CLOSE_SIZE_OUTSIDE_LIMITS'));
    assert.equal(result.escalation.action, 'OPERATOR_REVIEW');
    assert.equal(result.escalation.automaticRetry, false);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(bridge.exitEscalation(h.state.operations[p.proposalId]), result.escalation);
  }
});

test('a changed position quantity requires fresh evidence and preserves the holding', async () => {
  const state = f.initialized();
  state.managed['101'] = { ...f.row(), accountRef: state.accountRef, status: 'VERIFIED_MANAGED' };
  const h = f.harness({ state, positions: [f.row(0.4)] });
  h.queue(f.sell());
  const result = await h.controller.drain();
  assert.ok(result.vetoes.includes('EXACT_MANAGED_FULL_POSITION_SCOPE_UNVERIFIED'));
  assert.equal(result.escalation.alternativeLiquidation, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.positions[0].units, 0.4);
});
