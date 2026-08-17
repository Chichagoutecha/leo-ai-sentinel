'use strict';

const {
  buildOpenBuyByAmount,
  classifyUnifiedResponse
} = require('./etoro-current-order-contract');

const VERSION = 'v10.22.10.5-v2-buy-integration-draft';

function cleanIntentId(value) {
  const id = String(value || '').trim();
  return id.length >= 8 ? id : null;
}

function createInMemoryIntentGuard() {
  const records = new Map();
  return {
    reserve(intentId, metadata = {}) {
      if (records.has(intentId)) return { ok: false, existing: records.get(intentId) };
      const record = { intentId, state: 'RESERVED', reservedAt: new Date().toISOString(), ...metadata };
      records.set(intentId, record);
      return { ok: true, record };
    },
    mark(intentId, state, details = {}) {
      const previous = records.get(intentId) || { intentId };
      const next = { ...previous, ...details, state, updatedAt: new Date().toISOString() };
      records.set(intentId, next);
      return next;
    },
    get(intentId) { return records.get(intentId) || null; },
    snapshot() { return [...records.values()].map((item) => ({ ...item })); }
  };
}

function normalizeTransportResult(value) {
  const result = value && typeof value === 'object' ? value : {};
  const status = Number(result.status ?? result.httpStatus ?? 0);
  const data = result.data ?? result.body ?? result.payload ?? {};
  return { status, data, raw: result };
}

function reconciliationEvidence(value) {
  const r = value && typeof value === 'object' ? value : {};
  const confirmed = Boolean(r.confirmed || r.positionConfirmed || r.orderConfirmed);
  return {
    confirmed,
    positionId: r.positionId ?? null,
    orderId: r.orderId ?? null,
    referenceId: r.referenceId ?? null,
    evidence: r.evidence ?? null,
    raw: r
  };
}

async function executeBuyV2Draft({
  intentId,
  instrumentId,
  amount,
  leverage = 1,
  orderCurrency = 'usd',
  requestId = null,
  transport,
  reconcile,
  intentGuard
} = {}) {
  const normalizedIntentId = cleanIntentId(intentId);
  if (!normalizedIntentId) {
    return { ok: false, status: 'INVALID_INTENT_ID', sent: false, retryAllowed: false };
  }
  if (!intentGuard || typeof intentGuard.reserve !== 'function' || typeof intentGuard.mark !== 'function') {
    return { ok: false, status: 'INTENT_GUARD_REQUIRED', sent: false, retryAllowed: false };
  }

  const contract = buildOpenBuyByAmount({ instrumentId, amount, leverage, orderCurrency });
  if (!contract.ok) {
    return { ok: false, status: contract.reason, sent: false, retryAllowed: false };
  }

  const reservation = intentGuard.reserve(normalizedIntentId, {
    instrumentId: Number(instrumentId),
    amount: Number(amount),
    requestId: requestId || null
  });
  if (!reservation.ok) {
    return {
      ok: false,
      status: 'DUPLICATE_BLOCKED',
      sent: false,
      retryAllowed: false,
      existing: reservation.existing || intentGuard.get?.(normalizedIntentId) || null
    };
  }

  if (typeof transport !== 'function') {
    const record = intentGuard.mark(normalizedIntentId, 'DRAFT_TRANSPORT_NOT_INJECTED', { sent: false });
    return { ok: false, status: 'DRAFT_TRANSPORT_NOT_INJECTED', sent: false, retryAllowed: false, record };
  }

  let normalized;
  try {
    const raw = await transport({
      url: contract.url,
      method: contract.method,
      body: contract.body,
      requestId: requestId || null,
      intentId: normalizedIntentId
    });
    normalized = normalizeTransportResult(raw);
  } catch (error) {
    const record = intentGuard.mark(normalizedIntentId, 'TRANSPORT_EXCEPTION_UNCERTAIN', {
      sent: true,
      error: error?.message || String(error)
    });
    return {
      ok: false,
      status: 'TRANSPORT_EXCEPTION_UNCERTAIN',
      sent: true,
      retryAllowed: false,
      error: error?.message || String(error),
      record
    };
  }

  const classified = classifyUnifiedResponse(normalized.data, normalized.status);
  if (classified.classification === 'HTTP_ERROR') {
    const record = intentGuard.mark(normalizedIntentId, 'ORDER_REJECTED_HTTP', {
      sent: true,
      httpStatus: normalized.status,
      classified
    });
    return {
      ok: false,
      status: 'ORDER_REJECTED_HTTP',
      sent: true,
      retryAllowed: false,
      httpStatus: normalized.status,
      classified,
      record
    };
  }

  let reconciliation = null;
  if (typeof reconcile === 'function') {
    try {
      reconciliation = reconciliationEvidence(await reconcile({
        intentId: normalizedIntentId,
        instrumentId: Number(instrumentId),
        amount: Number(amount),
        requestId: requestId || null,
        responseEvidence: classified
      }));
    } catch (error) {
      reconciliation = {
        confirmed: false,
        positionId: null,
        orderId: null,
        referenceId: null,
        evidence: null,
        error: error?.message || String(error)
      };
    }
  }

  if (reconciliation?.confirmed) {
    const record = intentGuard.mark(normalizedIntentId, 'POSITION_CONFIRMED', {
      sent: true,
      httpStatus: normalized.status,
      classified,
      reconciliation
    });
    return {
      ok: true,
      status: 'POSITION_CONFIRMED',
      sent: true,
      retryAllowed: false,
      httpStatus: normalized.status,
      classified,
      reconciliation,
      record
    };
  }

  const status = classified.businessAcknowledged
    ? 'ORDER_ACKNOWLEDGED_RECONCILIATION_PENDING'
    : 'EXECUTION_UNCERTAIN';
  const record = intentGuard.mark(normalizedIntentId, status, {
    sent: true,
    httpStatus: normalized.status,
    classified,
    reconciliation
  });
  return {
    ok: false,
    status,
    sent: true,
    retryAllowed: false,
    httpStatus: normalized.status,
    classified,
    reconciliation,
    record
  };
}

function integrationReadiness() {
  return {
    version: VERSION,
    status: 'DRAFT_INTEGRATION_READY',
    safety: {
      defaultNetworkTransport: false,
      liveAuthority: false,
      productionRoutingChanged: false,
      automaticRetry: false,
      dualSubmitFallback: false,
      duplicateIntentGuardRequired: true,
      reconciliationSupported: true
    }
  };
}

module.exports = {
  VERSION,
  createInMemoryIntentGuard,
  executeBuyV2Draft,
  integrationReadiness
};
