'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { rehearse } = require('./trader-activation-review');
test('offline review is deterministic, contains actual reproduced blockers and cannot certify activation', async () => {
  const fetchBefore = global.fetch;
  try {
    global.fetch = () => { throw Error('OUTGOING_NETWORK_FORBIDDEN'); };
    const first = await rehearse(), second = await rehearse();
    assert.deepEqual(first, second); assert.equal(first.realNetworkCalls, 0); assert.equal(first.conclusion, 'BLOCKED');
    assert.equal(first.realBrokerAccess, 'NOT_TESTED'); assert.equal(first.realProductionShadowResults, 'UNAVAILABLE');
    assert.deepEqual(first.scenarios.filter(x => x.status === 'BLOCKER_REPRODUCED').map(x => x.name), ['full_exit_over_cap']);
    assert.ok(!JSON.stringify(first).includes('MUST_NOT_RETAIN')); assert.ok(!JSON.stringify(first).includes('SYNTHETIC"'));
    assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(fs.readFileSync(require.resolve('./trader-activation-rehearsal.json'), 'utf8')));
  } finally { global.fetch = fetchBefore; }
});
test('actual normal BUY verifier and bridge refuse full confirmation from position appearance alone', async () => {
  const vm = require('node:vm');
  const b = require('./trader-execution-bridge');
  const f = require('./activation-review-fixtures');
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const start = source.indexOf('function evaluateExecutionEvidence('), end = source.indexOf('async function verifyPortfolioAfterExecution(');
  assert.ok(start > 0 && end > start);
  const sandbox = { orderFinality: require('./etoro-order-finality'), EXECUTION_STATUS: { UNCERTAIN: 'EXECUTION_UNCERTAIN', CONFIRMED: 'POSITION_CONFIRMED' }, setDifference: (a, c) => a.filter(x => !c.includes(x)) };
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end), sandbox);
  const before = { instrumentId: 1, positionLineCount: 0, positionIds: [], openOrderIds: [], openOrderCount: 0, positionDetails: [] };
  const after = { ...before, positionLineCount: 1, positionIds: ['101'], positionDetails: [{ positionId: '101', units: 0.4 }] };
  const normalResult = sandbox.evaluateExecutionEvidence({ side: 'BUY', beforeSnapshot: before, afterSnapshot: after });
  assert.equal(normalResult.confirmed, false); // Position existence is not whole-order finality.
  const h = f.harness({ outcome: 'ACK' }); h.queue(f.buy()); await h.controller.drain();
  const reconciled = b.reconcile(h.state, 'proposal-1', { confirmed: normalResult.confirmed, intentId: 'intent-proposal-1',
    data: { positionId: '101' }, verification: { beforeSnapshot: before, afterSnapshot: after } }, f.NOW);
  assert.equal(reconciled.operations['proposal-1'].status, 'NEEDS_RECONCILIATION');
  assert.equal(reconciled.managed['101'], undefined);
});
