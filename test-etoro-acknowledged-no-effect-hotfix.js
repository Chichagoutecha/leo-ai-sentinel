'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  acknowledgedNoEffectConfig,
  hasMaterializedPositionId,
  shouldResolveAcknowledgedNoEffect,
  patchIndexSource
} = require('./etoro-acknowledged-no-effect-hotfix.js');

const SAFE_ENV = {
  ETORO_ACK_NO_EFFECT_TIMEOUT_MINUTES: '180',
  ETORO_ACK_NO_EFFECT_MIN_RECONCILIATIONS: '12'
};

function baseInput(overrides = {}) {
  return {
    httpWas2xx: true,
    responseAcknowledged: true,
    response: {
      orderId: 1563338207,
      positionId: null,
      token: 'redacted-test-token',
      referenceId: 'redacted-test-reference'
    },
    stateUnchanged: true,
    cashUnchanged: true,
    ageMinutes: 1204.66,
    reconciliations: 85,
    ...overrides
  };
}

test('acknowledged no-effect config is bounded and conservative', () => {
  assert.deepEqual(acknowledgedNoEffectConfig(SAFE_ENV), {
    timeoutMinutes: 180,
    minReconciliations: 12
  });
  assert.deepEqual(acknowledgedNoEffectConfig({
    ETORO_ACK_NO_EFFECT_TIMEOUT_MINUTES: '1',
    ETORO_ACK_NO_EFFECT_MIN_RECONCILIATIONS: '1'
  }), {
    timeoutMinutes: 60,
    minReconciliations: 6
  });
});

test('long-lived acknowledged order with no materialized effect can resolve', () => {
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput(), SAFE_ENV), true);
});

test('acknowledged order is not resolved before long safety timeout', () => {
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput({ ageMinutes: 179.99 }), SAFE_ENV), false);
});

test('acknowledged order is not resolved before enough reconciliations', () => {
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput({ reconciliations: 11 }), SAFE_ENV), false);
});

test('materialized positionId is never auto-expired by hotfix', () => {
  const input = baseInput({
    response: {
      orderId: 1563338207,
      positionId: 987654321,
      token: 'redacted-test-token'
    }
  });
  assert.equal(hasMaterializedPositionId(input.response), true);
  assert.equal(shouldResolveAcknowledgedNoEffect(input, SAFE_ENV), false);
});

test('portfolio or cash change prevents acknowledged no-effect resolution', () => {
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput({ stateUnchanged: false }), SAFE_ENV), false);
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput({ cashUnchanged: false }), SAFE_ENV), false);
});

test('non-2xx or unacknowledged response cannot use acknowledged path', () => {
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput({ httpWas2xx: false }), SAFE_ENV), false);
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput({ responseAcknowledged: false }), SAFE_ENV), false);
});

test('source patch injects conservative acknowledged path and distinct audit reason', () => {
  const fixture = `function shouldResolveIntentAsNoEffect() {\n  const resolve = httpWas2xx && !responseAcknowledged && stateUnchanged && cashUnchanged &&\n    timeoutReached && enoughReconciliations;\n  return {\n    reasons: resolve ? ["HTTP_2XX_EMPTY_BUSINESS_RESPONSE", "NO_PORTFOLIO_EFFECT", "CASH_UNCHANGED"] : []\n  };\n}`;
  const patched = patchIndexSource(fixture);
  assert.match(patched, /__LEO_ETORO_ACK_NO_EFFECT_SHOULD_RESOLVE__/);
  assert.match(patched, /HTTP_2XX_ACKNOWLEDGED_NO_MATERIALIZED_EFFECT/);
  assert.match(patched, /!responseAcknowledged && timeoutReached && enoughReconciliations/);
});

test('source patch fails closed if production resolver shape changes', () => {
  assert.throws(
    () => patchIndexSource('function changedResolver() {}'),
    /resolver target not found/
  );
});
