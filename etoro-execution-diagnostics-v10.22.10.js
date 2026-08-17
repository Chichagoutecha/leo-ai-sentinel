'use strict';

/**
 * LEO-AI SENTINEL v10.22.10 — eToro execution diagnostics + safe breaker scope
 *
 * Safety invariant:
 * - every eToro execution write is observed and diagnosed;
 * - an ambiguous HTTP 2xx may arm the local breaker ONLY for NEW OPEN orders;
 * - the breaker NEVER intercepts close/reduce/SELL execution routes.
 *
 * This module does not alter strategy, sizing, allocation, identity validation,
 * LIVE_EXECUTION_ARMED or the existing ExecutionVerifier.
 */

const crypto = require('crypto');

const DIAGNOSTIC_VERSION = 'v10.22.10-safe-open-order-breaker';
const ETORO_EXECUTION_PREFIX = 'https://public-api.etoro.com/api/v1/trading/execution/';
const DEFAULT_BREAKER_MINUTES = 720;
const MAX_BODY_PREVIEW_CHARS = 8000;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const originalFetch = global.fetch;
if (typeof originalFetch !== 'function') {
  throw new Error('LEO diagnostics require Node.js >= 18 with global fetch.');
}

const configuredBreakerMinutes = Number(process.env.ETORO_EMPTY_2XX_BREAKER_MINUTES || DEFAULT_BREAKER_MINUTES);
const breakerMinutes = Number.isFinite(configuredBreakerMinutes) && configuredBreakerMinutes >= 0
  ? configuredBreakerMinutes
  : DEFAULT_BREAKER_MINUTES;
const breakerDurationMs = breakerMinutes * 60 * 1000;

let breakerUntilMs = 0;
let breakerCause = null;
let lastDiagnostic = null;

function nowIso() { return new Date().toISOString(); }
function safeHash(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}
function normalizeUrl(input) {
  try {
    const parsed = new URL(String(input));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(input || '').split('?')[0];
  }
}
function requestMethod(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}
function requestUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return String(input?.url || input || '');
}
function isEtoroExecutionRequest(url, method) {
  return String(url || '').startsWith(ETORO_EXECUTION_PREFIX) && WRITE_METHODS.has(String(method || 'GET').toUpperCase());
}

/**
 * ONLY these routes can be breaker-blocked. This intentionally matches the
 * eToro market-open-order family and excludes every other execution route.
 */
function isEtoroNewOpenOrderRequest(url, method) {
  if (!isEtoroExecutionRequest(url, method)) return false;
  const normalized = normalizeUrl(url).toLowerCase();
  return normalized.includes('/trading/execution/market-open-orders/');
}

function executionIntent(url, method) {
  if (!isEtoroExecutionRequest(url, method)) return 'NON_EXECUTION';
  return isEtoroNewOpenOrderRequest(url, method) ? 'OPEN_NEW_POSITION' : 'NON_OPEN_EXECUTION_ALLOWED';
}

function getHeader(headersLike, name) {
  if (!headersLike) return null;
  const target = String(name).toLowerCase();
  try {
    if (typeof headersLike.get === 'function') {
      const value = headersLike.get(name);
      return value == null ? null : String(value);
    }
  } catch {}
  if (Array.isArray(headersLike)) {
    const pair = headersLike.find(([key]) => String(key).toLowerCase() === target);
    return pair ? String(pair[1]) : null;
  }
  if (typeof headersLike === 'object') {
    for (const [key, value] of Object.entries(headersLike)) {
      if (String(key).toLowerCase() === target) return value == null ? null : String(value);
    }
  }
  return null;
}

function safeRequestBody(body) {
  if (body == null) return null;
  if (typeof body !== 'string') return { type: typeof body };
  try {
    const parsed = JSON.parse(body);
    const allowed = [
      'InstrumentId', 'Amount', 'Leverage', 'IsBuy', 'UnitsToDeduct',
      'PositionId', 'OrderId', 'StopLossRate', 'TakeProfitRate', 'TrailingStopLoss'
    ];
    const output = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) output[key] = parsed[key];
    }
    return output;
  } catch {
    return { nonJsonBodyLength: body.length, sha256: safeHash(body) };
  }
}

function redactText(value) {
  if (value == null) return null;
  let text = String(value).slice(0, MAX_BODY_PREVIEW_CHARS);
  const secrets = [
    process.env.ETORO_API_KEY,
    process.env.ETORO_USER_KEY,
    process.env.BOT_SECRET,
    process.env.OPENAI_API_KEY,
    process.env.UPSTASH_REDIS_REST_TOKEN,
    process.env.TWELVE_DATA_API_KEY
  ].filter(Boolean);
  for (const secret of secrets) text = text.split(String(secret)).join('[REDACTED_SECRET]');
  return text
    .replace(/(x-api-key\s*[=:]\s*)[^\s,}"']+/gi, '$1[REDACTED]')
    .replace(/(x-user-key\s*[=:]\s*)[^\s,}"']+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*[=:]\s*)[^\s,}"']+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/gi, 'sk-[REDACTED]');
}

function safeResponseHeaders(response) {
  const allowed = [
    'content-type', 'content-length', 'date', 'server', 'x-request-id',
    'x-correlation-id', 'correlation-id', 'traceparent', 'request-id',
    'retry-after', 'location'
  ];
  const output = {};
  for (const name of allowed) {
    try {
      const value = response.headers.get(name);
      if (value != null) output[name] = value;
    } catch {}
  }
  return output;
}

function parseJsonMaybe(rawText) {
  const trimmed = rawText == null ? '' : String(rawText).trim();
  if (!trimmed) return { parsed: false, value: null, error: null };
  try { return { parsed: true, value: JSON.parse(trimmed), error: null }; }
  catch (error) { return { parsed: false, value: null, error: String(error?.message || error) }; }
}
function isEmptyJson(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' ? Object.keys(value).length === 0 : false;
}
function firstDefined(object, keys) {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key) && object[key] != null) return object[key];
  }
  return undefined;
}

function classifyExecutionResponse(response, rawText) {
  const status = Number(response?.status || 0);
  const is2xx = status >= 200 && status < 300;
  const trimmed = rawText == null ? '' : String(rawText).trim();
  const parsed = parseJsonMaybe(rawText);

  if (!is2xx) return {
    classification: 'HTTP_ERROR', ambiguous: false, businessAcknowledged: false,
    businessRejected: true, parsedJson: parsed.parsed, jsonParseError: parsed.error
  };
  if (!trimmed) return {
    classification: 'HTTP_2XX_EMPTY_BODY', ambiguous: true, businessAcknowledged: false,
    businessRejected: false, parsedJson: false, jsonParseError: null
  };
  if (parsed.parsed && isEmptyJson(parsed.value)) return {
    classification: 'HTTP_2XX_EMPTY_JSON', ambiguous: true, businessAcknowledged: false,
    businessRejected: false, parsedJson: true, jsonParseError: null
  };

  if (parsed.parsed && parsed.value && typeof parsed.value === 'object') {
    const value = parsed.value;
    const orderId = firstDefined(value, ['orderId', 'OrderId', 'orderID', 'OrderID']);
    const positionId = firstDefined(value, ['positionId', 'PositionId', 'positionID', 'PositionID']);
    const statusId = firstDefined(value, ['statusId', 'StatusId', 'statusID', 'StatusID']);
    const success = firstDefined(value, ['success', 'Success', 'isSuccess', 'IsSuccess']);
    const errorCode = firstDefined(value, ['errorCode', 'ErrorCode', 'code', 'Code']);
    const message = firstDefined(value, ['message', 'Message', 'errorMessage', 'ErrorMessage']);
    const fields = { orderId, positionId, statusId, success, errorCode, message };
    if (success === false || errorCode != null) return {
      classification: 'BUSINESS_REJECTED', ambiguous: false, businessAcknowledged: false,
      businessRejected: true, parsedJson: true, jsonParseError: null, businessFields: fields
    };
    if (orderId != null || positionId != null || statusId != null || success === true) return {
      classification: 'BUSINESS_ACKNOWLEDGED', ambiguous: false, businessAcknowledged: true,
      businessRejected: false, parsedJson: true, jsonParseError: null, businessFields: fields
    };
  }

  return {
    classification: 'HTTP_2XX_UNRECOGNIZED_BODY', ambiguous: true,
    businessAcknowledged: false, businessRejected: false,
    parsedJson: parsed.parsed, jsonParseError: parsed.error
  };
}

function publishDiagnostic(payload, level = 'log') {
  lastDiagnostic = payload;
  global.__LEO_ETORO_EXECUTION_DIAGNOSTIC__ = payload;
  (console[level] || console.log)(`[LEO_ETORO_EXECUTION_DIAGNOSTIC] ${JSON.stringify(payload)}`);
}

function armOpenOrderBreaker(reason, diagnostic) {
  if (breakerDurationMs <= 0) return false;
  breakerUntilMs = Date.now() + breakerDurationMs;
  breakerCause = {
    scope: 'NEW_OPEN_ORDERS_ONLY', reason, armedAt: nowIso(),
    until: new Date(breakerUntilMs).toISOString(), requestId: diagnostic.requestId || null,
    url: diagnostic.url || null, httpStatus: diagnostic.httpStatus || null
  };
  return true;
}

function makeBreakerResponse(url, method, requestId) {
  const remainingMs = Math.max(0, breakerUntilMs - Date.now());
  publishDiagnostic({
    diagnosticVersion: DIAGNOSTIC_VERSION,
    event: 'LOCAL_OPEN_ORDER_CIRCUIT_BREAKER_BLOCK',
    at: nowIso(), method, url: normalizeUrl(url), executionIntent: 'OPEN_NEW_POSITION',
    requestId: requestId || null, remainingSeconds: Math.ceil(remainingMs / 1000), breakerCause
  }, 'warn');
  return new Response(JSON.stringify({
    errorCode: 'LOCAL_OPEN_ORDER_CIRCUIT_BREAKER',
    message: 'Nouvelle ouverture LIVE bloquée localement après une réponse eToro ambiguë. Les routes de fermeture/réduction restent autorisées.',
    retryAfterSeconds: Math.ceil(remainingMs / 1000)
  }), {
    status: 409,
    statusText: 'Local open-order circuit breaker',
    headers: { 'content-type': 'application/json', 'x-leo-local-open-order-breaker': '1' }
  });
}

global.fetch = async function leoEtoroDiagnosticFetch(input, init = {}) {
  const url = requestUrl(input);
  const method = requestMethod(input, init);
  const requestHeaders = init.headers || input?.headers || null;
  const requestId = getHeader(requestHeaders, 'x-request-id');
  const executionRequest = isEtoroExecutionRequest(url, method);
  const openOrderRequest = isEtoroNewOpenOrderRequest(url, method);
  const intent = executionIntent(url, method);

  // Critical invariant: breaker checks apply ONLY to new market-open-order routes.
  if (openOrderRequest && breakerDurationMs > 0 && Date.now() < breakerUntilMs) {
    return makeBreakerResponse(url, method, requestId);
  }

  const startedAtMs = Date.now();
  let response;
  try {
    response = await originalFetch(input, init);
  } catch (error) {
    if (executionRequest) publishDiagnostic({
      diagnosticVersion: DIAGNOSTIC_VERSION, event: 'ETORO_EXECUTION_HTTP_RESPONSE', at: nowIso(),
      classification: 'NETWORK_ERROR', method, url: normalizeUrl(url), executionIntent: intent,
      breakerEligible: openOrderRequest, requestId: requestId || null,
      requestBody: safeRequestBody(init.body), durationMs: Date.now() - startedAtMs,
      errorName: error?.name || null, errorMessage: redactText(error?.message || String(error))
    }, 'error');
    throw error;
  }

  if (!executionRequest) return response;

  let rawBody = null;
  let bodyReadError = null;
  try { rawBody = await response.clone().text(); }
  catch (error) { bodyReadError = String(error?.message || error); }

  const classification = classifyExecutionResponse(response, rawBody);
  const diagnostic = {
    diagnosticVersion: DIAGNOSTIC_VERSION,
    event: 'ETORO_EXECUTION_HTTP_RESPONSE', at: nowIso(),
    classification: classification.classification, ambiguous: classification.ambiguous,
    businessAcknowledged: classification.businessAcknowledged,
    businessRejected: classification.businessRejected,
    businessFields: classification.businessFields || null,
    method, url: normalizeUrl(url), responseUrl: normalizeUrl(response.url || url),
    executionIntent: intent, breakerEligible: openOrderRequest,
    closeAndReduceRoutesNeverBlocked: true,
    redirected: Boolean(response.redirected), requestId: requestId || null,
    requestBody: safeRequestBody(init.body), durationMs: Date.now() - startedAtMs,
    httpStatus: response.status, httpStatusText: response.statusText || null, httpOk: response.ok,
    responseHeaders: safeResponseHeaders(response),
    responseBodyLength: rawBody == null ? null : rawBody.length,
    responseBodySha256: rawBody == null ? null : safeHash(rawBody),
    responseBodyPreview: redactText(rawBody), parsedJson: classification.parsedJson,
    jsonParseError: classification.jsonParseError || null, bodyReadError,
    breakerArmed: false, breakerUntil: null
  };

  // Ambiguous non-open executions are still diagnosed, but NEVER arm the open-order breaker.
  if (classification.ambiguous && openOrderRequest) {
    diagnostic.breakerArmed = armOpenOrderBreaker(classification.classification, diagnostic);
    diagnostic.breakerUntil = diagnostic.breakerArmed ? new Date(breakerUntilMs).toISOString() : null;
  }

  publishDiagnostic(diagnostic, classification.ambiguous ? 'warn' : 'log');
  return response;
};

global.__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__ = () => ({
  diagnosticVersion: DIAGNOSTIC_VERSION,
  breakerScope: 'NEW_OPEN_ORDERS_ONLY',
  closeAndReduceRoutesNeverBlocked: true,
  breakerMinutes,
  breakerActive: Date.now() < breakerUntilMs,
  breakerUntil: breakerUntilMs ? new Date(breakerUntilMs).toISOString() : null,
  breakerCause,
  lastDiagnostic
});

console.log(JSON.stringify({
  component: 'LEO_ETORO_EXECUTION_DIAGNOSTICS', version: DIAGNOSTIC_VERSION, enabled: true,
  breakerMinutes, breakerScope: 'NEW_OPEN_ORDERS_ONLY', closeAndReduceRoutesNeverBlocked: true,
  liveExecutionArmedModified: false, secretsLogged: false
}));

module.exports = {
  DIAGNOSTIC_VERSION,
  classifyExecutionResponse,
  isEmptyJson,
  redactText,
  safeRequestBody,
  isEtoroExecutionRequest,
  isEtoroNewOpenOrderRequest,
  executionIntent
};
