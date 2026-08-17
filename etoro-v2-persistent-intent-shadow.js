'use strict';

/**
 * LEO-AI SENTINEL v10.22.10.6 — persistent-intent shadow bridge for eToro v2.
 * Pure mapping/correlation only: no provider transport and no LIVE authority.
 */
const { createHash } = require('crypto');
const {
  buildOpenBuyByAmount,
  classifyUnifiedResponse
} = require('./etoro-current-order-contract');

const VERSION = 'v10.22.10.6-v2-persistent-intent-shadow';

const EXECUTION_STATUS = Object.freeze({
  INTENT_CREATED: 'ORDER_INTENT_CREATED',
  SENT: 'ORDER_SENT',
  ACCEPTED: 'ORDER_ACCEPTED_BY_ETORO',
  CONFIRMED: 'POSITION_CONFIRMED',
  REJECTED: 'ORDER_REJECTED',
  NOT_FOUND: 'POSITION_NOT_FOUND',
  NO_EFFECT: 'ORDER_NO_EFFECT',
  UNCERTAIN: 'EXECUTION_UNCERTAIN',
  DUPLICATE_BLOCKED: 'DUPLICATE_BLOCKED'
});

const ACTIVE_EXECUTION_STATUSES = new Set([
  EXECUTION_STATUS.INTENT_CREATED,
  EXECUTION_STATUS.SENT,
  EXECUTION_STATUS.ACCEPTED,
  EXECUTION_STATUS.NOT_FOUND,
  EXECUTION_STATUS.UNCERTAIN,
  'PENDING',
  'UNKNOWN',
  'CONFIRMED_API_PENDING_PORTFOLIO'
]);

const TERMINAL_EXECUTION_STATUSES = new Set([
  EXECUTION_STATUS.CONFIRMED,
  EXECUTION_STATUS.REJECTED,
  EXECUTION_STATUS.NO_EFFECT,
  EXECUTION_STATUS.DUPLICATE_BLOCKED
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
}

function fingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function normalizeIntent(intent) {
  const source = intent && typeof intent === 'object' ? intent : {};
  return {
    id: String(source.id || '').trim(),
    type: String(source.type || 'BUY').trim().toUpperCase(),
    asset: String(source.asset || '').trim().toUpperCase(),
    mode: String(source.mode || 'LIVE').trim().toUpperCase(),
    status: String(source.status || EXECUTION_STATUS.INTENT_CREATED).trim().toUpperCase(),
    requestId: source.requestId ? String(source.requestId).trim() : null
  };
}

function isActivePersistentStatus(status) {
  return ACTIVE_EXECUTION_STATUSES.has(String(status || '').trim().toUpperCase());
}

function isTerminalPersistentStatus(status) {
  return TERMINAL_EXECUTION_STATUSES.has(String(status || '').trim().toUpperCase());
}

function assessPersistentSubmission({ intent, activeIntents = [] } = {}) {
  const current = normalizeIntent(intent);
  if (!current.id) {
    return { ok: false, status: 'INVALID_INTENT_ID', reason: 'Persistent intent id is required.' };
  }
  if (current.type !== 'BUY') {
    return { ok: false, status: 'UNSUPPORTED_INTENT_TYPE', reason: 'This shadow bridge only models BUY.' };
  }
  if (current.mode !== 'LIVE') {
    return { ok: false, status: 'NON_LIVE_INTENT', reason: 'Only a LIVE persistent intent may be correlated to the real v2 contract.' };
  }
  if (current.status !== EXECUTION_STATUS.INTENT_CREATED) {
    return {
      ok: false,
      status: isActivePersistentStatus(current.status)
        ? 'ALREADY_SENT_OR_UNRESOLVED'
        : 'TERMINAL_INTENT_CANNOT_RESUBMIT',
      reason: 'Only ORDER_INTENT_CREATED is eligible for a first provider submission.',
      retryAllowed: false
    };
  }

  const blockers = (Array.isArray(activeIntents) ? activeIntents : [])
    .map(normalizeIntent)
    .filter((candidate) =>
      candidate.id &&
      candidate.id !== current.id &&
      candidate.mode === 'LIVE' &&
      isActivePersistentStatus(candidate.status)
    );
  if (blockers.length) {
    return {
      ok: false,
      status: EXECUTION_STATUS.DUPLICATE_BLOCKED,
      reason: 'Another active LIVE intent must be reconciled before a new provider submission.',
      retryAllowed: false,
      blockers
    };
  }

  return { ok: true, status: EXECUTION_STATUS.INTENT_CREATED, reason: 'Eligible for one first submission only.', retryAllowed: false };
}

function buildPersistentV2ShadowPlan({
  intent,
  activeIntents = [],
  instrumentId,
  amount,
  requestId,
  leverage = 1,
  orderCurrency = 'usd'
} = {}) {
  const submission = assessPersistentSubmission({ intent, activeIntents });
  if (!submission.ok) {
    return {
      ok: false,
      status: submission.status,
      reason: submission.reason,
      retryAllowed: false,
      safety: shadowSafety()
    };
  }

  if (Number(leverage) !== 1) {
    return {
      ok: false,
      status: 'LEVERAGE_BLOCKED',
      reason: 'LEO v2 migration shadow requires leverage=1.',
      retryAllowed: false,
      safety: shadowSafety()
    };
  }

  const contract = buildOpenBuyByAmount({ instrumentId, amount, leverage: 1, orderCurrency });
  if (!contract.ok) {
    return {
      ok: false,
      status: contract.reason,
      reason: contract.reason,
      retryAllowed: false,
      safety: shadowSafety()
    };
  }

  const normalizedIntent = normalizeIntent(intent);
  const correlationRequestId = String(requestId || normalizedIntent.requestId || '').trim();
  if (correlationRequestId.length < 8) {
    return {
      ok: false,
      status: 'INVALID_REQUEST_ID',
      reason: 'A stable x-request-id is required before the first provider submission.',
      retryAllowed: false,
      safety: shadowSafety()
    };
  }

  const correlation = {
    intentId: normalizedIntent.id,
    requestId: correlationRequestId,
    asset: normalizedIntent.asset || null,
    instrumentId: Number(instrumentId),
    amount: Number(amount)
  };
  const request = {
    method: contract.method,
    url: contract.url,
    body: contract.body
  };
  const planFingerprint = fingerprint({ correlation, request });

  return {
    ok: true,
    status: 'V2_SHADOW_PLAN_READY',
    mode: 'SHADOW',
    correlation,
    request,
    fingerprint: planFingerprint,
    nextPersistentStatusIfActuallySent: EXECUTION_STATUS.SENT,
    retryAllowed: false,
    safety: shadowSafety()
  };
}

function normalizePortfolioEvidence(value) {
  const evidence = value && typeof value === 'object' ? value : {};
  return {
    checked: Boolean(evidence.checked),
    confirmed: Boolean(evidence.confirmed || evidence.positionConfirmed),
    orderVisible: Boolean(evidence.orderVisible),
    unchanged: Boolean(evidence.unchanged),
    verificationError: evidence.verificationError ? String(evidence.verificationError) : null,
    evidence: Array.isArray(evidence.evidence) ? evidence.evidence.map(String) : []
  };
}

function classifyV2ForPersistentIntent({ httpStatus, data, portfolioEvidence } = {}) {
  const unified = classifyUnifiedResponse(data, httpStatus);
  const portfolio = normalizePortfolioEvidence(portfolioEvidence);

  let status;
  let confirmed = false;
  if (portfolio.confirmed) {
    status = EXECUTION_STATUS.CONFIRMED;
    confirmed = true;
  } else if (unified.classification === 'HTTP_ERROR') {
    status = EXECUTION_STATUS.REJECTED;
  } else if (portfolio.orderVisible) {
    status = EXECUTION_STATUS.ACCEPTED;
  } else if (portfolio.checked && portfolio.unchanged) {
    // Mirrors verifyPortfolioAfterExecution: a completed fresh portfolio check
    // without position/order evidence overrides a mere provider acknowledgement.
    status = EXECUTION_STATUS.NOT_FOUND;
  } else if (unified.businessAcknowledged) {
    status = EXECUTION_STATUS.ACCEPTED;
  } else {
    status = EXECUTION_STATUS.UNCERTAIN;
  }

  const requiresReconciliation = [
    EXECUTION_STATUS.ACCEPTED,
    EXECUTION_STATUS.NOT_FOUND,
    EXECUTION_STATUS.UNCERTAIN
  ].includes(status);

  return {
    status,
    confirmed,
    businessAcknowledged: Boolean(unified.businessAcknowledged),
    responseClassification: unified.classification,
    responseEvidence: {
      token: unified.token ?? null,
      orderId: unified.orderId ?? null,
      positionId: unified.positionId ?? null,
      referenceId: unified.referenceId ?? null
    },
    portfolioEvidence: portfolio,
    requiresReconciliation,
    retryAllowed: false,
    canCountAsEffectiveExecution: confirmed,
    safety: shadowSafety()
  };
}

function shadowSafety() {
  return {
    shadowOnly: true,
    networkTransport: false,
    liveAuthority: false,
    productionRoutingChanged: false,
    automaticRetry: false,
    dualSubmitFallback: false,
    persistentIntentCorrelation: true,
    portfolioReconciliationCompatible: true
  };
}

function shadowReadiness() {
  return {
    version: VERSION,
    status: 'PERSISTENT_INTENT_SHADOW_READY',
    executionStatuses: EXECUTION_STATUS,
    safety: shadowSafety()
  };
}

module.exports = {
  VERSION,
  EXECUTION_STATUS,
  ACTIVE_EXECUTION_STATUSES,
  TERMINAL_EXECUTION_STATUSES,
  fingerprint,
  normalizeIntent,
  isActivePersistentStatus,
  isTerminalPersistentStatus,
  assessPersistentSubmission,
  buildPersistentV2ShadowPlan,
  classifyV2ForPersistentIntent,
  shadowReadiness
};
