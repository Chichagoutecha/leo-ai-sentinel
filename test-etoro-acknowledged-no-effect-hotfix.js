'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  acknowledgedNoEffectConfig,
  preSendNoEffectConfig,
  hasMaterializedPositionId,
  shouldResolveAcknowledgedNoEffect,
  isKnownUcitsPreSendError,
  shouldResolveKnownPreSendNoEffect,
  isKnownPreSendBridgeError,
  preSendRejectionResponse,
  installPreSendRejectionWrapper,
  patchIndexSource
} = require('./etoro-acknowledged-no-effect-hotfix.js');

const SAFE_ENV = {
  ETORO_ACK_NO_EFFECT_TIMEOUT_MINUTES: '180',
  ETORO_ACK_NO_EFFECT_MIN_RECONCILIATIONS: '12',
  ETORO_PRE_SEND_NO_EFFECT_TIMEOUT_MINUTES: '1',
  ETORO_PRE_SEND_NO_EFFECT_MIN_RECONCILIATIONS: '1'
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

function preSendInput(overrides = {}) {
  return {
    httpWas2xx: false,
    responseAcknowledged: false,
    response: null,
    error: "eToro LIVE BUY SPY: Marché d'exécution fermé pour CSPX.L.",
    stateUnchanged: true,
    cashUnchanged: true,
    ageMinutes: 10114.79,
    reconciliations: 676,
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

test('pre-send no-effect config requires at least one reconciliation', () => {
  assert.deepEqual(preSendNoEffectConfig(SAFE_ENV), {
    timeoutMinutes: 1,
    minReconciliations: 1
  });
  assert.deepEqual(preSendNoEffectConfig({
    ETORO_PRE_SEND_NO_EFFECT_TIMEOUT_MINUTES: '-10',
    ETORO_PRE_SEND_NO_EFFECT_MIN_RECONCILIATIONS: '0'
  }), {
    timeoutMinutes: 0,
    minReconciliations: 1
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
  assert.equal(shouldResolveKnownPreSendNoEffect(preSendInput({ response: { positionId: 987654321 } }), SAFE_ENV), false);
});

test('portfolio or cash change prevents acknowledged no-effect resolution', () => {
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput({ stateUnchanged: false }), SAFE_ENV), false);
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput({ cashUnchanged: false }), SAFE_ENV), false);
});

test('non-2xx or unacknowledged response cannot use acknowledged path', () => {
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput({ httpWas2xx: false }), SAFE_ENV), false);
  assert.equal(shouldResolveAcknowledgedNoEffect(baseInput({ responseAcknowledged: false }), SAFE_ENV), false);
});

test('known closed-venue UCITS pre-send error is recognized', () => {
  assert.equal(isKnownUcitsPreSendError("eToro LIVE BUY SPY: Marché d'exécution fermé pour CSPX.L."), true);
  assert.equal(isKnownUcitsPreSendError('network socket hang up'), false);
});

test('stale SPY pre-send intent resolves without requiring impossible broker HTTP 2xx', () => {
  assert.equal(shouldResolveKnownPreSendNoEffect(preSendInput(), SAFE_ENV), true);
});

test('pre-send path remains conservative when broker acknowledgement or state change exists', () => {
  assert.equal(shouldResolveKnownPreSendNoEffect(preSendInput({ responseAcknowledged: true }), SAFE_ENV), false);
  assert.equal(shouldResolveKnownPreSendNoEffect(preSendInput({ stateUnchanged: false }), SAFE_ENV), false);
  assert.equal(shouldResolveKnownPreSendNoEffect(preSendInput({ cashUnchanged: false }), SAFE_ENV), false);
  assert.equal(shouldResolveKnownPreSendNoEffect(preSendInput({ reconciliations: 0 }), SAFE_ENV), false);
});

test('source patch injects acknowledged and UCITS pre-send paths with distinct audit reasons', () => {
  const fixture = `function shouldResolveIntentAsNoEffect() {\n  const resolve = httpWas2xx && !responseAcknowledged && stateUnchanged && cashUnchanged &&\n    timeoutReached && enoughReconciliations;\n  return {\n    reasons: resolve ? ["HTTP_2XX_EMPTY_BUSINESS_RESPONSE", "NO_PORTFOLIO_EFFECT", "CASH_UNCHANGED"] : []\n  };\n}`;
  const patched = patchIndexSource(fixture);
  assert.match(patched, /__LEO_ETORO_ACK_NO_EFFECT_SHOULD_RESOLVE__/);
  assert.match(patched, /__LEO_ETORO_UCITS_PRE_SEND_NO_EFFECT_SHOULD_RESOLVE__/);
  assert.match(patched, /HTTP_2XX_ACKNOWLEDGED_NO_MATERIALIZED_EFFECT/);
  assert.match(patched, /UCITS_PRE_SEND_REJECTION_NO_BROKER_ORDER/);
  assert.match(patched, /httpWas2xx && !responseAcknowledged && timeoutReached && enoughReconciliations/);
});

test('source patch fails closed if production resolver shape changes', () => {
  assert.throws(
    () => patchIndexSource('function changedResolver() {}'),
    /resolver target not found/
  );
});

function bridgeError(code, message = 'blocked before broker send') {
  const error = new Error(message);
  error.name = 'LeoEtoroUcitsBridgeError';
  error.code = code;
  error.status = 409;
  error.leoEtoroUcits = {
    analysisAsset: 'SPY',
    analysisInstrumentId: 3417,
    executionSymbol: 'CSPX.L'
  };
  return error;
}

test('known UCITS bridge pre-send error becomes local 409 and never an uncertain transport exception', async () => {
  let calls = 0;
  const installed = installPreSendRejectionWrapper({
    fetch: async () => {
      calls += 1;
      throw bridgeError('UCITS_EXECUTION_VENUE_CLOSED', "Marché d'exécution fermé pour CSPX.L.");
    }
  });
  const response = await installed.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', {
    method: 'POST',
    body: JSON.stringify({ action: 'open', transaction: 'buy', instrumentId: 3417, amount: 523.95 })
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-leo-pre-send-rejected'), 'true');
  const body = await response.json();
  assert.equal(body.leoPreSendRejected, true);
  assert.equal(body.sentToEtoro, false);
  assert.equal(body.code, 'UCITS_EXECUTION_VENUE_CLOSED');
  assert.equal(body.meta.executionSymbol, 'CSPX.L');
});

test('unknown or ambiguous execution error remains an exception', async () => {
  const installed = installPreSendRejectionWrapper({
    fetch: async () => { throw new Error('socket reset after unknown send state'); }
  });
  await assert.rejects(
    installed.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', { method: 'POST' }),
    /socket reset after unknown send state/
  );
});

test('known bridge code outside broker order POST remains an exception', async () => {
  const installed = installPreSendRejectionWrapper({
    fetch: async () => { throw bridgeError('UCITS_QUOTE_STALE'); }
  });
  await assert.rejects(
    installed.fetch('https://public-api.etoro.com/api/v1/trading/info/real/pnl', { method: 'GET' }),
    (error) => error?.code === 'UCITS_QUOTE_STALE'
  );
});

test('pre-send bridge code allowlist is explicit', () => {
  assert.equal(isKnownPreSendBridgeError(bridgeError('UCITS_EXECUTION_VENUE_CLOSED')), true);
  assert.equal(isKnownPreSendBridgeError(bridgeError('SOME_FUTURE_AMBIGUOUS_ERROR')), false);
  const response = preSendRejectionResponse(bridgeError('UCITS_SYMBOL_NOT_APPROVED'));
  assert.equal(response.status, 409);
});
