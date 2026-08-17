'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXECUTION_STATUS,
  assessPersistentSubmission,
  buildPersistentV2ShadowPlan,
  classifyV2ForPersistentIntent,
  isActivePersistentStatus,
  isTerminalPersistentStatus,
  shadowReadiness
} = require('./etoro-v2-persistent-intent-shadow');

function createdIntent(overrides = {}) {
  return {
    id: 'intent-spy-0001',
    type: 'BUY',
    asset: 'SPY',
    mode: 'LIVE',
    status: EXECUTION_STATUS.INTENT_CREATED,
    ...overrides
  };
}

test('persistent BUY intent maps to the exact current v2 unified request without network authority', () => {
  const plan = buildPersistentV2ShadowPlan({
    intent: createdIntent(),
    instrumentId: 3417,
    amount: 25,
    requestId: 'request-spy-0001'
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'SHADOW');
  assert.equal(plan.request.method, 'POST');
  assert.equal(plan.request.url, 'https://public-api.etoro.com/api/v2/trading/execution/orders');
  assert.deepEqual(plan.request.body, {
    action: 'open',
    transaction: 'buy',
    instrumentId: 3417,
    orderType: 'mkt',
    amount: 25,
    orderCurrency: 'usd',
    leverage: 1
  });
  assert.equal(plan.correlation.intentId, 'intent-spy-0001');
  assert.equal(plan.correlation.requestId, 'request-spy-0001');
  assert.equal(plan.nextPersistentStatusIfActuallySent, EXECUTION_STATUS.SENT);
  assert.equal(plan.safety.networkTransport, false);
  assert.equal(plan.safety.liveAuthority, false);
});

test('same persistent intent and request produce stable fingerprint while changed correlation does not', () => {
  const first = buildPersistentV2ShadowPlan({
    intent: createdIntent(), instrumentId: 3417, amount: 25, requestId: 'request-spy-0001'
  });
  const same = buildPersistentV2ShadowPlan({
    intent: createdIntent(), instrumentId: 3417, amount: 25, requestId: 'request-spy-0001'
  });
  const changed = buildPersistentV2ShadowPlan({
    intent: createdIntent({ id: 'intent-spy-0002' }), instrumentId: 3417, amount: 25, requestId: 'request-spy-0002'
  });
  assert.equal(first.fingerprint, same.fingerprint);
  assert.notEqual(first.fingerprint, changed.fingerprint);
});

test('an already sent or unresolved intent can never be submitted again', () => {
  for (const status of [
    EXECUTION_STATUS.SENT,
    EXECUTION_STATUS.ACCEPTED,
    EXECUTION_STATUS.NOT_FOUND,
    EXECUTION_STATUS.UNCERTAIN
  ]) {
    const result = assessPersistentSubmission({ intent: createdIntent({ status }) });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'ALREADY_SENT_OR_UNRESOLVED');
    assert.equal(result.retryAllowed, false);
  }
});

test('another active LIVE intent blocks a fresh provider submission', () => {
  const result = assessPersistentSubmission({
    intent: createdIntent(),
    activeIntents: [createdIntent({ id: 'intent-btc-active', asset: 'BTC', status: EXECUTION_STATUS.UNCERTAIN })]
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, EXECUTION_STATUS.DUPLICATE_BLOCKED);
  assert.equal(result.retryAllowed, false);
  assert.equal(result.blockers.length, 1);
});

test('leverage above one is rejected before any v2 plan can be considered ready', () => {
  const plan = buildPersistentV2ShadowPlan({
    intent: createdIntent(), instrumentId: 3417, amount: 25, requestId: 'request-spy-0001', leverage: 2
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.status, 'LEVERAGE_BLOCKED');
  assert.equal(plan.retryAllowed, false);
});

test('business identifiers acknowledge the order but do not confirm a position', () => {
  const result = classifyV2ForPersistentIntent({
    httpStatus: 200,
    data: { token: 'tok-1', orderId: 991, referenceId: 'ref-991' },
    portfolioEvidence: { checked: false }
  });
  assert.equal(result.status, EXECUTION_STATUS.ACCEPTED);
  assert.equal(result.businessAcknowledged, true);
  assert.equal(result.confirmed, false);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.canCountAsEffectiveExecution, false);
  assert.equal(result.retryAllowed, false);
});

test('HTTP 2xx without unified evidence plus verified unchanged portfolio remains not found', () => {
  const result = classifyV2ForPersistentIntent({
    httpStatus: 200,
    data: { message: 'ok' },
    portfolioEvidence: { checked: true, unchanged: true, evidence: ['NO_POSITION_OR_ORDER_PROOF'] }
  });
  assert.equal(result.status, EXECUTION_STATUS.NOT_FOUND);
  assert.equal(result.businessAcknowledged, false);
  assert.equal(result.confirmed, false);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.retryAllowed, false);
});

test('ambiguous response with unavailable portfolio verification becomes uncertain, never retried', () => {
  const result = classifyV2ForPersistentIntent({
    httpStatus: 200,
    data: {},
    portfolioEvidence: { checked: false, verificationError: 'portfolio unavailable' }
  });
  assert.equal(result.status, EXECUTION_STATUS.UNCERTAIN);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.retryAllowed, false);
});

test('independent portfolio position evidence is the only path that marks execution confirmed', () => {
  const result = classifyV2ForPersistentIntent({
    httpStatus: 200,
    data: { token: 'tok-2', orderId: 992 },
    portfolioEvidence: { checked: true, confirmed: true, evidence: ['NEW_POSITION_VISIBLE', 'POSITION_ID_777'] }
  });
  assert.equal(result.status, EXECUTION_STATUS.CONFIRMED);
  assert.equal(result.confirmed, true);
  assert.equal(result.requiresReconciliation, false);
  assert.equal(result.canCountAsEffectiveExecution, true);
  assert.equal(result.retryAllowed, false);
});

test('HTTP rejection maps to ORDER_REJECTED and remains non-retryable automatically', () => {
  const result = classifyV2ForPersistentIntent({
    httpStatus: 400,
    data: { errorCode: 'INVALID_ORDER' },
    portfolioEvidence: { checked: false }
  });
  assert.equal(result.status, EXECUTION_STATUS.REJECTED);
  assert.equal(result.confirmed, false);
  assert.equal(result.requiresReconciliation, false);
  assert.equal(result.retryAllowed, false);
});

test('status compatibility and readiness mirror the production persistent state machine safely', () => {
  assert.equal(isActivePersistentStatus(EXECUTION_STATUS.INTENT_CREATED), true);
  assert.equal(isActivePersistentStatus(EXECUTION_STATUS.UNCERTAIN), true);
  assert.equal(isActivePersistentStatus('CONFIRMED_API_PENDING_PORTFOLIO'), true);
  assert.equal(isTerminalPersistentStatus(EXECUTION_STATUS.CONFIRMED), true);
  assert.equal(isTerminalPersistentStatus(EXECUTION_STATUS.NO_EFFECT), true);
  const readiness = shadowReadiness();
  assert.equal(readiness.status, 'PERSISTENT_INTENT_SHADOW_READY');
  assert.equal(readiness.safety.shadowOnly, true);
  assert.equal(readiness.safety.networkTransport, false);
  assert.equal(readiness.safety.liveAuthority, false);
  assert.equal(readiness.safety.productionRoutingChanged, false);
  assert.equal(readiness.safety.automaticRetry, false);
  assert.equal(readiness.safety.dualSubmitFallback, false);
});
