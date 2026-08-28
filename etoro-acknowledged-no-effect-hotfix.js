'use strict';

/**
 * LEO eToro acknowledged/pre-send no-effect intent hotfix.
 *
 * Why this preload exists:
 * - eToro can acknowledge an execution request with an orderId/token/referenceId.
 * - An acknowledgement proves receipt, not that a position materialized.
 * - The legacy no-effect resolver only expired HTTP 2xx responses that had NO
 *   business acknowledgement, so an acknowledged order with no portfolio effect
 *   could remain POSITION_NOT_FOUND forever.
 * - A deterministic UCITS bridge rejection can happen BEFORE the broker order
 *   endpoint is called (closed venue, stale quote, missing approval, etc.). Such
 *   an intent must not remain EXECUTION_UNCERTAIN forever waiting for an eToro
 *   acknowledgement that can never exist.
 *
 * Safety contract:
 * - This preload NEVER sends an order.
 * - It only patches the local reconciliation predicate in index.js at load time.
 * - Acknowledged intents use a much longer timeout and more reconciliations.
 * - Known UCITS pre-send failures resolve only when there is no broker
 *   acknowledgement, no materialized positionId, and portfolio/cash are unchanged.
 * - A non-null positionId is never auto-expired by this hotfix.
 * - Any portfolio-state change or cash change prevents auto-expiry.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const VERSION = 'v10.22.14.0-etoro-no-effect-hotfix';
const DEFAULT_ACK_TIMEOUT_MINUTES = 180;
const DEFAULT_ACK_MIN_RECONCILIATIONS = 12;
const DEFAULT_PRE_SEND_TIMEOUT_MINUTES = 1;
const DEFAULT_PRE_SEND_MIN_RECONCILIATIONS = 1;
const REAL_ORDER_URL = 'https://public-api.etoro.com/api/v2/trading/execution/orders';

const PRE_SEND_CODES = new Set([
  'UCITS_EXECUTION_GUARD_ACTIVE',
  'UCITS_SYMBOL_NOT_APPROVED',
  'UCITS_EXECUTION_VENUE_CLOSED',
  'UCITS_SYMBOL_SEARCH_HTTP_ERROR',
  'UCITS_SYMBOL_EXACT_MATCH_REQUIRED',
  'UCITS_QUOTE_HTTP_ERROR',
  'UCITS_QUOTE_NOT_FOUND',
  'UCITS_QUOTE_TIMESTAMP_REQUIRED',
  'UCITS_QUOTE_STALE',
  'UCITS_SPREAD_TOO_WIDE'
]);

const UCITS_EXECUTION_SYMBOLS = Object.freeze([
  'CSPX.L', 'CNDX.L', 'IGLN.L', 'IBTA.L', 'DTLA.L',
  'ZPDH.DE', 'XDWS.DE', 'ZPDE.DE'
]);

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function acknowledgedNoEffectConfig(env = process.env) {
  return {
    timeoutMinutes: boundedNumber(
      env.ETORO_ACK_NO_EFFECT_TIMEOUT_MINUTES,
      DEFAULT_ACK_TIMEOUT_MINUTES,
      60,
      1440
    ),
    minReconciliations: Math.round(boundedNumber(
      env.ETORO_ACK_NO_EFFECT_MIN_RECONCILIATIONS,
      DEFAULT_ACK_MIN_RECONCILIATIONS,
      6,
      100
    ))
  };
}

function preSendNoEffectConfig(env = process.env) {
  return {
    timeoutMinutes: boundedNumber(
      env.ETORO_PRE_SEND_NO_EFFECT_TIMEOUT_MINUTES,
      DEFAULT_PRE_SEND_TIMEOUT_MINUTES,
      0,
      60
    ),
    minReconciliations: Math.round(boundedNumber(
      env.ETORO_PRE_SEND_NO_EFFECT_MIN_RECONCILIATIONS,
      DEFAULT_PRE_SEND_MIN_RECONCILIATIONS,
      1,
      10
    ))
  };
}

function hasMaterializedPositionId(response = null) {
  if (!response || typeof response !== 'object') return false;
  const value = response.positionId;
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function shouldResolveAcknowledgedNoEffect(input = {}, env = process.env) {
  const config = acknowledgedNoEffectConfig(env);
  const ageMinutes = Number(input.ageMinutes);
  const reconciliations = Number(input.reconciliations);

  return Boolean(
    input.httpWas2xx === true &&
    input.responseAcknowledged === true &&
    !hasMaterializedPositionId(input.response) &&
    input.stateUnchanged === true &&
    input.cashUnchanged === true &&
    Number.isFinite(ageMinutes) &&
    ageMinutes >= config.timeoutMinutes &&
    Number.isFinite(reconciliations) &&
    reconciliations >= config.minReconciliations
  );
}

function safeUrl(input) {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input && typeof input.url === 'string') return new URL(input.url);
  } catch {}
  return null;
}

function requestMethod(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function isKnownPreSendBridgeError(error) {
  return Boolean(
    error &&
    error.name === 'LeoEtoroUcitsBridgeError' &&
    PRE_SEND_CODES.has(String(error.code || ''))
  );
}

function safeBridgeMeta(error) {
  const meta = error?.leoEtoroUcits && typeof error.leoEtoroUcits === 'object'
    ? error.leoEtoroUcits
    : {};
  return {
    analysisAsset: meta.analysisAsset || null,
    analysisInstrumentId: Number.isFinite(Number(meta.analysisInstrumentId)) ? Number(meta.analysisInstrumentId) : null,
    executionSymbol: meta.executionSymbol || null,
    executionInstrumentId: Number.isFinite(Number(meta.executionInstrumentId)) ? Number(meta.executionInstrumentId) : null,
    mode: meta.mode || null,
    at: meta.at || null,
    httpStatus: Number.isFinite(Number(meta.httpStatus)) ? Number(meta.httpStatus) : null,
    ageMinutes: Number.isFinite(Number(meta.ageMinutes)) ? Number(meta.ageMinutes) : null,
    maxAgeMinutes: Number.isFinite(Number(meta.maxAgeMinutes)) ? Number(meta.maxAgeMinutes) : null,
    spreadPct: Number.isFinite(Number(meta.spreadPct)) ? Number(meta.spreadPct) : null,
    maxSpreadPct: Number.isFinite(Number(meta.maxSpreadPct)) ? Number(meta.maxSpreadPct) : null
  };
}

function preSendRejectionResponse(error) {
  return new Response(JSON.stringify({
    source: 'LEO_ETORO_UCITS_BRIDGE',
    hotfixVersion: VERSION,
    leoPreSendRejected: true,
    sentToEtoro: false,
    code: String(error?.code || 'UCITS_PRE_SEND_REJECTED'),
    message: String(error?.message || 'UCITS pre-send rejection'),
    meta: safeBridgeMeta(error)
  }), {
    status: 409,
    statusText: 'LEO UCITS pre-send rejection',
    headers: {
      'content-type': 'application/json',
      'x-leo-pre-send-rejected': 'true'
    }
  });
}

function installPreSendRejectionWrapper(options = {}) {
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') {
    return { installed: false, reason: 'FETCH_UNAVAILABLE', version: VERSION };
  }

  async function wrappedFetch(input, init = {}) {
    const url = safeUrl(input);
    const isRealOrderPost = Boolean(
      url &&
      url.toString().split('?')[0] === REAL_ORDER_URL &&
      requestMethod(input, init) === 'POST'
    );

    try {
      return await fetchImpl(input, init);
    } catch (error) {
      if (!isRealOrderPost || !isKnownPreSendBridgeError(error)) throw error;
      const meta = safeBridgeMeta(error);
      console.warn(`[LEO_ETORO_PRE_SEND] ${JSON.stringify({
        component: 'LEO_ETORO_ACKNOWLEDGED_NO_EFFECT_HOTFIX',
        version: VERSION,
        event: 'PRE_SEND_REJECTED_NOT_SENT_TO_ETORO',
        at: new Date().toISOString(),
        code: error.code,
        analysisAsset: meta.analysisAsset,
        executionSymbol: meta.executionSymbol,
        sentToEtoro: false,
        intentShouldRemainActive: false
      })}`);
      return preSendRejectionResponse(error);
    }
  }

  if (!options.fetch) global.fetch = wrappedFetch;
  return {
    installed: true,
    version: VERSION,
    convertsKnownUcitsPreSendErrorsToLocalRejection: true,
    unknownErrorsRethrown: true,
    sendsOrders: false,
    retriesOrders: false,
    modifiesOrderPayload: false,
    fetch: wrappedFetch
  };
}

function isKnownUcitsPreSendError(errorValue) {
  const text = String(errorValue || '').trim();
  if (!text) return false;
  const symbolPattern = UCITS_EXECUTION_SYMBOLS
    .map((symbol) => symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const patterns = [
    new RegExp(`Marché d'exécution fermé pour (?:${symbolPattern})\\.?`, 'i'),
    /bridge UCITS en mode guard/i,
    /bloqué: .* non approuvé/i,
    /Aucun instrumentId eToro exact et unique pour/i,
    /Recherche eToro impossible pour/i,
    /Prix eToro indisponible pour/i,
    /Aucun prix eToro exploitable pour/i,
    /Horodatage de prix manquant pour/i,
    /Prix eToro trop ancien pour/i,
    /Spread eToro trop large pour/i
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function shouldResolveKnownPreSendNoEffect(input = {}, env = process.env) {
  const config = preSendNoEffectConfig(env);
  const ageMinutes = Number(input.ageMinutes);
  const reconciliations = Number(input.reconciliations);

  return Boolean(
    isKnownUcitsPreSendError(input.error) &&
    input.responseAcknowledged !== true &&
    !hasMaterializedPositionId(input.response) &&
    input.stateUnchanged === true &&
    input.cashUnchanged === true &&
    Number.isFinite(ageMinutes) &&
    ageMinutes >= config.timeoutMinutes &&
    Number.isFinite(reconciliations) &&
    reconciliations >= config.minReconciliations
  );
}

const RESOLVE_TARGET = `  const resolve = httpWas2xx && !responseAcknowledged && stateUnchanged && cashUnchanged &&\n    timeoutReached && enoughReconciliations;`;

const RESOLVE_REPLACEMENT = `  const acknowledgedNoEffect = global.__LEO_ETORO_ACK_NO_EFFECT_SHOULD_RESOLVE__({\n    responseAcknowledged,\n    response: intent.response,\n    httpWas2xx,\n    stateUnchanged,\n    cashUnchanged,\n    ageMinutes,\n    reconciliations\n  });\n  const knownPreSendNoEffect = global.__LEO_ETORO_UCITS_PRE_SEND_NO_EFFECT_SHOULD_RESOLVE__({\n    error: intent.error,\n    responseAcknowledged,\n    response: intent.response,\n    stateUnchanged,\n    cashUnchanged,\n    ageMinutes,\n    reconciliations\n  });\n  const resolve = stateUnchanged && cashUnchanged && (\n    (httpWas2xx && !responseAcknowledged && timeoutReached && enoughReconciliations) ||\n    acknowledgedNoEffect ||\n    knownPreSendNoEffect\n  );`;

const REASONS_TARGET = `    reasons: resolve ? ["HTTP_2XX_EMPTY_BUSINESS_RESPONSE", "NO_PORTFOLIO_EFFECT", "CASH_UNCHANGED"] : []`;

const REASONS_REPLACEMENT = `    reasons: resolve ? [\n      knownPreSendNoEffect\n        ? "UCITS_PRE_SEND_REJECTION_NO_BROKER_ORDER"\n        : (acknowledgedNoEffect\n          ? "HTTP_2XX_ACKNOWLEDGED_NO_MATERIALIZED_EFFECT"\n          : "HTTP_2XX_EMPTY_BUSINESS_RESPONSE"),\n      "NO_PORTFOLIO_EFFECT",\n      "CASH_UNCHANGED"\n    ] : []`;

function patchIndexSource(source) {
  if (typeof source !== 'string') {
    throw new TypeError('LEO eToro no-effect hotfix requires index.js source text.');
  }
  if (!source.includes(RESOLVE_TARGET)) {
    throw new Error('LEO eToro no-effect hotfix refused to start: resolver target not found.');
  }
  if (!source.includes(REASONS_TARGET)) {
    throw new Error('LEO eToro no-effect hotfix refused to start: reasons target not found.');
  }

  return source
    .replace(RESOLVE_TARGET, RESOLVE_REPLACEMENT)
    .replace(REASONS_TARGET, REASONS_REPLACEMENT);
}

global.__LEO_ETORO_ACK_NO_EFFECT_SHOULD_RESOLVE__ = shouldResolveAcknowledgedNoEffect;
global.__LEO_ETORO_UCITS_PRE_SEND_NO_EFFECT_SHOULD_RESOLVE__ = shouldResolveKnownPreSendNoEffect;

// IMPORTANT: package.json loads this preload AFTER etoro-ucits-execution-bridge.js,
// so the wrapper catches deterministic bridge failures before they escape to index.js.
const preSendWrapper = installPreSendRejectionWrapper();

const indexPath = path.resolve(__dirname, 'index.js');
const originalJsLoader = Module._extensions['.js'];

Module._extensions['.js'] = function leoEtoroNoEffectLoader(module, filename) {
  if (path.resolve(filename) !== indexPath) {
    return originalJsLoader(module, filename);
  }

  // Restore the normal loader before compiling index.js so all nested requires
  // use Node's canonical behavior.
  Module._extensions['.js'] = originalJsLoader;
  const originalSource = fs.readFileSync(filename, 'utf8');
  const patchedSource = patchIndexSource(originalSource);
  module._compile(patchedSource, filename);
};

const startupConfig = acknowledgedNoEffectConfig();
const preSendConfig = preSendNoEffectConfig();
console.log(JSON.stringify({
  component: 'LEO_ETORO_ACKNOWLEDGED_NO_EFFECT_HOTFIX',
  version: VERSION,
  enabled: true,
  acknowledgedTimeoutMinutes: startupConfig.timeoutMinutes,
  acknowledgedMinReconciliations: startupConfig.minReconciliations,
  preSendTimeoutMinutes: preSendConfig.timeoutMinutes,
  preSendMinReconciliations: preSendConfig.minReconciliations,
  resolvesKnownUcitsPreSendFailures: true,
  convertsFutureUcitsPreSendFailuresToRejectedResponse: Boolean(preSendWrapper?.installed),
  requiresNoPositionId: true,
  requiresStateUnchanged: true,
  requiresCashUnchanged: true,
  sendsOrders: false,
  liveExecutionArmedModified: false,
  secretsLogged: false
}));

module.exports = {
  VERSION,
  UCITS_EXECUTION_SYMBOLS,
  PRE_SEND_CODES,
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
};
