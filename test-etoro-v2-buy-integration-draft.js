'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createInMemoryIntentGuard,
  executeBuyV2Draft,
  integrationReadiness
} = require('./etoro-v2-buy-integration-draft');

test('confirmed v2 BUY uses exactly one injected transport call and reconciliation', async () => {
  const guard = createInMemoryIntentGuard();
  let transportCalls = 0;
  let reconcileCalls = 0;
  const result = await executeBuyV2Draft({
    intentId: 'intent-gld-001',
    instrumentId: 3417,
    amount: 523.95,
    requestId: 'request-001',
    intentGuard: guard,
    transport: async (request) => {
      transportCalls += 1;
      assert.equal(request.url, 'https://public-api.etoro.com/api/v2/trading/execution/orders');
      assert.deepEqual(request.body, {
        action: 'open', transaction: 'buy', instrumentId: 3417,
        orderType: 'mkt', amount: 523.95, orderCurrency: 'usd', leverage: 1
      });
      return { status: 200, data: { token: 'tok-1', orderId: 99, referenceId: 'ref-1' } };
    },
    reconcile: async ({ responseEvidence }) => {
      reconcileCalls += 1;
      assert.equal(responseEvidence.businessAcknowledged, true);
      return { confirmed: true, positionId: 777, orderId: 99, evidence: 'portfolio-position' };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'POSITION_CONFIRMED');
  assert.equal(transportCalls, 1);
  assert.equal(reconcileCalls, 1);
});

test('same intent can never submit twice', async () => {
  const guard = createInMemoryIntentGuard();
  let transportCalls = 0;
  const args = {
    intentId: 'intent-spy-001', instrumentId: 1001, amount: 25, intentGuard: guard,
    transport: async () => { transportCalls += 1; return { status: 200, data: {} }; },
    reconcile: async () => ({ confirmed: false })
  };
  const first = await executeBuyV2Draft(args);
  const second = await executeBuyV2Draft(args);
  assert.equal(first.status, 'EXECUTION_UNCERTAIN');
  assert.equal(second.status, 'DUPLICATE_BLOCKED');
  assert.equal(transportCalls, 1);
});

test('HTTP 2xx without business evidence remains uncertain and is not retried', async () => {
  const guard = createInMemoryIntentGuard();
  let transportCalls = 0;
  const result = await executeBuyV2Draft({
    intentId: 'intent-gld-002', instrumentId: 3417, amount: 50, intentGuard: guard,
    transport: async () => { transportCalls += 1; return { status: 200, data: { message: 'ok' } }; },
    reconcile: async () => ({ confirmed: false })
  });
  assert.equal(result.status, 'EXECUTION_UNCERTAIN');
  assert.equal(result.retryAllowed, false);
  assert.equal(result.classified.ambiguous, true);
  assert.equal(transportCalls, 1);
});

test('transport exception is treated as uncertain and never auto-retried', async () => {
  const guard = createInMemoryIntentGuard();
  let transportCalls = 0;
  const result = await executeBuyV2Draft({
    intentId: 'intent-btc-001', instrumentId: 100000, amount: 10, intentGuard: guard,
    transport: async () => { transportCalls += 1; throw new Error('socket reset after send'); }
  });
  assert.equal(result.status, 'TRANSPORT_EXCEPTION_UNCERTAIN');
  assert.equal(result.sent, true);
  assert.equal(result.retryAllowed, false);
  assert.equal(transportCalls, 1);
});

test('missing transport fails closed before any network authority exists', async () => {
  const guard = createInMemoryIntentGuard();
  const result = await executeBuyV2Draft({
    intentId: 'intent-nvda-001', instrumentId: 15574, amount: 25, intentGuard: guard
  });
  assert.equal(result.status, 'DRAFT_TRANSPORT_NOT_INJECTED');
  assert.equal(result.sent, false);
  assert.equal(result.retryAllowed, false);
});

test('invalid contract input fails before reservation or transport', async () => {
  const guard = createInMemoryIntentGuard();
  let calls = 0;
  const result = await executeBuyV2Draft({
    intentId: 'intent-invalid-001', instrumentId: 15574, amount: 0, intentGuard: guard,
    transport: async () => { calls += 1; return { status: 200, data: {} }; }
  });
  assert.equal(result.status, 'INVALID_AMOUNT');
  assert.equal(result.sent, false);
  assert.equal(calls, 0);
  assert.equal(guard.snapshot().length, 0);
});

test('draft readiness forbids production routing, retries and dual submit', () => {
  const ready = integrationReadiness();
  assert.equal(ready.status, 'DRAFT_INTEGRATION_READY');
  assert.equal(ready.safety.defaultNetworkTransport, false);
  assert.equal(ready.safety.liveAuthority, false);
  assert.equal(ready.safety.productionRoutingChanged, false);
  assert.equal(ready.safety.automaticRetry, false);
  assert.equal(ready.safety.dualSubmitFallback, false);
  assert.equal(ready.safety.duplicateIntentGuardRequired, true);
});
