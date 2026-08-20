'use strict';

/**
 * LEO eToro acknowledged-no-effect intent hotfix.
 *
 * Why this preload exists:
 * - eToro can acknowledge an execution request with an orderId/token/referenceId.
 * - An acknowledgement proves receipt, not that a position materialized.
 * - The legacy no-effect resolver only expired HTTP 2xx responses that had NO
 *   business acknowledgement, so an acknowledged order with no portfolio effect
 *   could remain POSITION_NOT_FOUND forever.
 *
 * Safety contract:
 * - This preload NEVER sends an order.
 * - It only patches the local reconciliation predicate in index.js at load time.
 * - Acknowledged intents use a much longer timeout and more reconciliations.
 * - A non-null positionId is never auto-expired by this hotfix.
 * - Any portfolio-state change or cash change prevents auto-expiry.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const VERSION = 'v10.22.11.2-etoro-acknowledged-no-effect-hotfix';
const DEFAULT_ACK_TIMEOUT_MINUTES = 180;
const DEFAULT_ACK_MIN_RECONCILIATIONS = 12;

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

const RESOLVE_TARGET = `  const resolve = httpWas2xx && !responseAcknowledged && stateUnchanged && cashUnchanged &&\n    timeoutReached && enoughReconciliations;`;

const RESOLVE_REPLACEMENT = `  const acknowledgedNoEffect = global.__LEO_ETORO_ACK_NO_EFFECT_SHOULD_RESOLVE__({\n    responseAcknowledged,\n    response: intent.response,\n    httpWas2xx,\n    stateUnchanged,\n    cashUnchanged,\n    ageMinutes,\n    reconciliations\n  });\n  const resolve = httpWas2xx && stateUnchanged && cashUnchanged && (\n    (!responseAcknowledged && timeoutReached && enoughReconciliations) ||\n    acknowledgedNoEffect\n  );`;

const REASONS_TARGET = `    reasons: resolve ? ["HTTP_2XX_EMPTY_BUSINESS_RESPONSE", "NO_PORTFOLIO_EFFECT", "CASH_UNCHANGED"] : []`;

const REASONS_REPLACEMENT = `    reasons: resolve ? [\n      acknowledgedNoEffect\n        ? "HTTP_2XX_ACKNOWLEDGED_NO_MATERIALIZED_EFFECT"\n        : "HTTP_2XX_EMPTY_BUSINESS_RESPONSE",\n      "NO_PORTFOLIO_EFFECT",\n      "CASH_UNCHANGED"\n    ] : []`;

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
console.log(JSON.stringify({
  component: 'LEO_ETORO_ACKNOWLEDGED_NO_EFFECT_HOTFIX',
  version: VERSION,
  enabled: true,
  acknowledgedTimeoutMinutes: startupConfig.timeoutMinutes,
  acknowledgedMinReconciliations: startupConfig.minReconciliations,
  requiresNoPositionId: true,
  requiresStateUnchanged: true,
  requiresCashUnchanged: true,
  sendsOrders: false,
  liveExecutionArmedModified: false,
  secretsLogged: false
}));

module.exports = {
  VERSION,
  acknowledgedNoEffectConfig,
  hasMaterializedPositionId,
  shouldResolveAcknowledgedNoEffect,
  patchIndexSource
};
