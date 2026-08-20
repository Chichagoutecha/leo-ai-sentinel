'use strict';

/**
 * LEO-AI SENTINEL v10.22.11.1 hotfix — eToro execution diagnostics preload
 *
 * Loaded before index.js with Node's -r flag. It does not change strategy,
 * allocation, sizing, LIVE_EXECUTION_ARMED, identity checks or the existing
 * ExecutionVerifier. It observes eToro execution HTTP responses for both
 * /api/v1/trading/execution/* and /api/v2/trading/execution/* and adds a local
 * circuit breaker after an ambiguous HTTP 2xx response.
 */

const crypto = require('crypto');

const DIAGNOSTIC_VERSION = 'v10.22.11.1-etoro-execution-diagnostics-v1-v2-hotfix';
const DEFAULT_BREAKER_MINUTES = 720;
const MAX_BODY_PREVIEW_CHARS = 8000;
const ETORO_API_ORIGIN = 'https://public-api.etoro.com';
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

function nowIso() {
  return new Date().toISOString();
}

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
      if (String(key).toLowerCase() === target) {
        return value == null ? null : String(value);
      }
    }
  }

  return null;
}

function executionRequestMetadata(url, method) {
  const verb = String(method || 'GET').toUpperCase();
  if (!WRITE_METHODS.has(verb)) return { match: false, version: null, environment: null };

  try {
    const parsed = new URL(String(url));
    if (parsed.origin !== ETORO_API_ORIGIN) {
      return { match: false, version: null, environment: null };
    }

    const match = parsed.pathname.match(/^\/api\/(v1|v2)\/trading\/execution(?:\/|$)/i);
    if (!match) return { match: false, version: null, environment: null };

    const environment = /\/demo(?:\/|$)/i.test(parsed.pathname) ? 'DEMO' : 'REAL_OR_UNSPECIFIED';
    return {
      match: true,
      version: match[1].toLowerCase(),
      environment,
      path: parsed.pathname
    };
  } catch {
    return { match: false, version: null, environment: null };
  }
}

function isEtoroExecutionRequest(url, method) {
  return executionRequestMetadata(url, method).match;
}

function safeRequestBody(body) {
  if (body == null) return null;
  if (typeof body !== 'string') return { type: typeof body };

  try {
    const parsed = JSON.parse(body);
    const allowed = [
      'InstrumentId', 'Amount', 'Leverage', 'IsBuy', 'UnitsToDeduct',
      'StopLossRate', 'TakeProfitRate', 'TrailingStopLoss',
      'action', 'transaction', 'instrumentId', 'orderType', 'amount',
      'orderCurrency', 'leverage', 'units', 'positionId'
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

  const explicitSecrets = [
    process.env.ETORO_API_KEY,
    process.env.ETORO_USER_KEY,
    process.env.BOT_SECRET,
    process.env.OPENAI_API_KEY,
    process.env.UPSTASH_REDIS_REST_TOKEN,
    process.env.TWELVE_DATA_API_KEY
  ].filter(Boolean);

  for (const secret of explicitSecrets) {
    text = text.split(String(secret)).join('[REDACTED_SECRET]');
  }

  return text
    .replace(/(x-api-key\s*[=:]\s*)[^\s,}"']+/gi, '$1[REDACTED]')
    .replace(/(x-user-key\s*[=:]\s*)[^\s,}"']+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*[=:]\s*)[^\s,}"']+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/gi, 'sk-[REDACTED]');
}

function safeResponseHeaders(response) {
  const allowed = [
    'content-type', 'content-length', 'date', 'server',
    'x-request-id', 'x-correlation-id', 'correlation-id',
    'traceparent', 'request-id', 'retry-after', 'location'
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
  if (rawText == null) return { parsed: false, value: null, error: null };
  const trimmed = String(rawText).trim();
  if (!trimmed) return { parsed: false, value: null, error: null };
  try {
    return { parsed: true, value: JSON.parse(trimmed), error: null };
  } catch (error) {
    return { parsed: false, value: null, error: error && error.message ? error.message : String(error) };
  }
}

function isEmptyJson(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function firstDefined(object, keys) {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key) && object[key] != null) return object[key];
  }
  return undefined;
}

function classifyExecutionResponse(response, rawText) {
  const status = Number(response.status || 0);
  const is2xx = status >= 200 && status < 300;
  const trimmed = rawText == null ? '' : String(rawText).trim();
  const parsed = parseJsonMaybe(rawText);

  if (!is2xx) {
    return {
      classification: 'HTTP_ERROR',
      ambiguous: false,
      businessAcknowledged: false,
      businessRejected: true,
      parsedJson: parsed.parsed,
      jsonParseError: parsed.error
    };
  }

  if (!trimmed) {
    return {
      classification: 'HTTP_2XX_EMPTY_BODY',
      ambiguous: true,
      businessAcknowledged: false,
      businessRejected: false,
      parsedJson: false,
      jsonParseError: null
    };
  }

  if (parsed.parsed && isEmptyJson(parsed.value)) {
    return {
      classification: 'HTTP_2XX_EMPTY_JSON',
      ambiguous: true,
      businessAcknowledged: false,
      businessRejected: false,
      parsedJson: true,
      jsonParseError: null
    };
  }

  if (parsed.parsed && parsed.value && typeof parsed.value === 'object') {
    const value = parsed.value;
    const orderId = firstDefined(value, ['orderId', 'OrderId', 'orderID', 'OrderID', 'id', 'Id']);
    const positionId = firstDefined(value, ['positionId', 'PositionId', 'positionID', 'PositionID']);
    const statusId = firstDefined(value, ['statusId', 'StatusId', 'statusID', 'StatusID', 'status', 'Status']);
    const success = firstDefined(value, ['success', 'Success', 'isSuccess', 'IsSuccess', 'isSucceeded', 'IsSucceeded']);
    const errorCode = firstDefined(value, ['errorCode', 'ErrorCode', 'code', 'Code']);
    const message = firstDefined(value, ['message', 'Message', 'errorMessage', 'ErrorMessage']);

    const ack = orderId != null || positionId != null || statusId != null || success === true;
    const rejected = success === false || errorCode != null;

    if (rejected) {
      return {
        classification: 'BUSINESS_REJECTED',
        ambiguous: false,
        businessAcknowledged: false,
        businessRejected: true,
        parsedJson: true,
        jsonParseError: null,
        businessFields: { orderId, positionId, statusId, success, errorCode, message }
      };
    }

    if (ack) {
      return {
        classification: 'BUSINESS_ACKNOWLEDGED',
        ambiguous: false,
        businessAcknowledged: true,
        businessRejected: false,
        parsedJson: true,
        jsonParseError: null,
        businessFields: { orderId, positionId, statusId, success, errorCode, message }
      };
    }
  }

  return {
    classification: 'HTTP_2XX_UNRECOGNIZED_BODY',
    ambiguous: true,
    businessAcknowledged: false,
    businessRejected: false,
    parsedJson: parsed.parsed,
    jsonParseError: parsed.error
  };
}

function publishDiagnostic(payload, level = 'log') {
  lastDiagnostic = payload;
  global.__LEO_ETORO_EXECUTION_DIAGNOSTIC__ = payload;
  const logger = console[level] || console.log;
  logger.call(console, `[LEO_ETORO_EXECUTION_DIAGNOSTIC] ${JSON.stringify(payload)}`);
}

function armBreaker(reason, diagnostic) {
  if (breakerDurationMs <= 0) return;
  breakerUntilMs = Date.now() + breakerDurationMs;
  breakerCause = {
    reason,
    armedAt: nowIso(),
    until: new Date(breakerUntilMs).toISOString(),
    requestId: diagnostic.requestId || null,
    url: diagnostic.url || null,
    httpStatus: diagnostic.httpStatus || null,
    apiVersion: diagnostic.apiVersion || null,
    environment: diagnostic.environment || null
  };
}

function makeBreakerResponse(url, method, requestId, metadata) {
  const remainingMs = Math.max(0, breakerUntilMs - Date.now());
  const payload = {
    diagnosticVersion: DIAGNOSTIC_VERSION,
    event: 'LOCAL_EXECUTION_CIRCUIT_BREAKER_BLOCK',
    at: nowIso(),
    method,
    url: normalizeUrl(url),
    requestId: requestId || null,
    apiVersion: metadata?.version || null,
    environment: metadata?.environment || null,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    breakerCause
  };
  publishDiagnostic(payload, 'warn');

  return new Response(JSON.stringify({
    errorCode: 'LOCAL_EXECUTION_CIRCUIT_BREAKER',
    message: 'Nouvel ordre eToro bloqué localement après une réponse d’exécution ambiguë. Consulte les logs LEO_ETORO_EXECUTION_DIAGNOSTIC.',
    retryAfterSeconds: Math.ceil(remainingMs / 1000)
  }), {
    status: 409,
    statusText: 'Local execution circuit breaker',
    headers: {
      'content-type': 'application/json',
      'x-leo-local-circuit-breaker': '1'
    }
  });
}

global.fetch = async function leoEtoroDiagnosticFetch(input, init = {}) {
  const url = typeof input === 'string' || input instanceof URL
    ? String(input)
    : String(input && input.url ? input.url : input);
  const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
  const requestHeaders = init.headers || (input && input.headers) || null;
  const requestId = getHeader(requestHeaders, 'x-request-id');
  const executionMetadata = executionRequestMetadata(url, method);
  const executionRequest = executionMetadata.match;

  if (executionRequest && breakerDurationMs > 0 && Date.now() < breakerUntilMs) {
    return makeBreakerResponse(url, method, requestId, executionMetadata);
  }

  const startedAtMs = Date.now();
  let response;

  try {
    response = await originalFetch(input, init);
  } catch (error) {
    if (executionRequest) {
      publishDiagnostic({
        diagnosticVersion: DIAGNOSTIC_VERSION,
        event: 'ETORO_EXECUTION_HTTP_RESPONSE',
        at: nowIso(),
        classification: 'NETWORK_ERROR',
        method,
        url: normalizeUrl(url),
        requestId: requestId || null,
        apiVersion: executionMetadata.version,
        environment: executionMetadata.environment,
        requestBody: safeRequestBody(init.body),
        durationMs: Date.now() - startedAtMs,
        errorName: error && error.name ? error.name : null,
        errorMessage: redactText(error && error.message ? error.message : String(error))
      }, 'error');
    }
    throw error;
  }

  if (!executionRequest) return response;

  let rawBody = null;
  let bodyReadError = null;
  try {
    rawBody = await response.clone().text();
  } catch (error) {
    bodyReadError = error && error.message ? error.message : String(error);
  }

  const classification = classifyExecutionResponse(response, rawBody);
  const diagnostic = {
    diagnosticVersion: DIAGNOSTIC_VERSION,
    event: 'ETORO_EXECUTION_HTTP_RESPONSE',
    at: nowIso(),
    classification: classification.classification,
    ambiguous: classification.ambiguous,
    businessAcknowledged: classification.businessAcknowledged,
    businessRejected: classification.businessRejected,
    businessFields: classification.businessFields || null,
    method,
    url: normalizeUrl(url),
    responseUrl: normalizeUrl(response.url || url),
    redirected: Boolean(response.redirected),
    requestId: requestId || null,
    apiVersion: executionMetadata.version,
    environment: executionMetadata.environment,
    requestBody: safeRequestBody(init.body),
    durationMs: Date.now() - startedAtMs,
    httpStatus: response.status,
    httpStatusText: response.statusText || null,
    httpOk: response.ok,
    responseHeaders: safeResponseHeaders(response),
    responseBodyLength: rawBody == null ? null : rawBody.length,
    responseBodySha256: rawBody == null ? null : safeHash(rawBody),
    responseBodyPreview: redactText(rawBody),
    parsedJson: classification.parsedJson,
    jsonParseError: classification.jsonParseError || null,
    bodyReadError,
    breakerArmed: false,
    breakerUntil: null
  };

  if (classification.ambiguous) {
    armBreaker(classification.classification, diagnostic);
    if (breakerDurationMs > 0) {
      diagnostic.breakerArmed = true;
      diagnostic.breakerUntil = new Date(breakerUntilMs).toISOString();
    }
  }

  publishDiagnostic(diagnostic, classification.ambiguous ? 'warn' : 'log');
  return response;
};

global.__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__ = () => ({
  diagnosticVersion: DIAGNOSTIC_VERSION,
  breakerMinutes,
  breakerActive: Date.now() < breakerUntilMs,
  breakerUntil: breakerUntilMs ? new Date(breakerUntilMs).toISOString() : null,
  breakerCause,
  lastDiagnostic,
  captures: {
    v1: true,
    v2: true,
    methods: [...WRITE_METHODS]
  }
});

console.log(JSON.stringify({
  component: 'LEO_ETORO_EXECUTION_DIAGNOSTICS',
  version: DIAGNOSTIC_VERSION,
  enabled: true,
  capturesV1: true,
  capturesV2: true,
  breakerMinutes,
  liveExecutionArmedModified: false,
  secretsLogged: false
}));

module.exports = {
  DIAGNOSTIC_VERSION,
  classifyExecutionResponse,
  executionRequestMetadata,
  isEtoroExecutionRequest,
  isEmptyJson,
  redactText,
  safeRequestBody
};
