'use strict';

/**
 * LEO-AI SENTINEL v10.23.5 — Foundation Runtime Preflight
 *
 * Rehearsal-only, read-only startup verification for the combined Stage 1–5 stack.
 * It makes no network request, no market-data request, no OpenAI call and no
 * trading mutation. It validates the actual Node preload order and safety
 * contracts already loaded in the current process.
 */

const VERSION = 'v10.23.5-foundation-runtime-preflight';
const PREFIX = '[LEO_FOUNDATION_PREFLIGHT]';
const SAFE_DIAG = './etoro-execution-diagnostics-v10.22.10.js';
const LEGACY_DIAG = './etoro-execution-diagnostics.js';
const AI_OPTIMIZER = './ai-cost-optimizer.js';
const LUNA_COMPAT = './ai-luna-temperature-compat.js';

function normalizeModuleName(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, './');
}

function parsePreloads(execArgv = process.execArgv) {
  const args = Array.isArray(execArgv) ? execArgv.map(String) : [];
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-r' || arg === '--require') {
      if (args[i + 1]) out.push(normalizeModuleName(args[++i]));
      continue;
    }
    if (arg.startsWith('--require=')) out.push(normalizeModuleName(arg.slice('--require='.length)));
  }
  return out;
}

function ordered(preloads, first, second) {
  const a = preloads.indexOf(first);
  const b = preloads.indexOf(second);
  return a >= 0 && b >= 0 && a < b;
}

function cachedExports(relativePath) {
  try {
    const resolved = require.resolve(relativePath);
    return require.cache[resolved]?.exports || null;
  } catch {
    return null;
  }
}

function inspectLunaCompatibility(exportsObject, options = {}) {
  const primaryModel = String(options.primaryModel || process.env.AI_PRIMARY_MODEL || 'gpt-5.6-luna').trim();
  const forcePrimaryModel = options.forcePrimaryModel ?? (process.env.AI_FORCE_PRIMARY_MODEL !== 'false');
  if (!exportsObject || typeof exportsObject.sanitizeLunaParams !== 'function') {
    return { loaded: false, behaviorVerified: false, primaryModel, forcePrimaryModel };
  }
  try {
    const original = { model: 'gpt-4.1-mini', temperature: 0.1, messages: [{ role: 'user', content: 'x' }] };
    const sanitized = exportsObject.sanitizeLunaParams(original, { primaryModel, forcePrimaryModel });
    const temperatureRemoved = !Object.prototype.hasOwnProperty.call(sanitized, 'temperature');
    const originalUntouched = original.temperature === 0.1;
    const expectedRemoval = Boolean(forcePrimaryModel) && primaryModel.toLowerCase().includes('gpt-5.6-luna');
    return {
      loaded: true,
      version: exportsObject.VERSION || null,
      primaryModel,
      forcePrimaryModel: Boolean(forcePrimaryModel),
      expectedRemoval,
      temperatureRemoved,
      originalUntouched,
      behaviorVerified: expectedRemoval ? (temperatureRemoved && originalUntouched) : originalUntouched
    };
  } catch (error) {
    return {
      loaded: true,
      version: exportsObject.VERSION || null,
      primaryModel,
      forcePrimaryModel: Boolean(forcePrimaryModel),
      behaviorVerified: false,
      error: String(error?.message || error).slice(0, 500)
    };
  }
}

function inspectExecutionSafety() {
  try {
    const fn = global.__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__;
    if (typeof fn !== 'function') return { loaded: false, safe: false };
    const state = fn();
    const safe = state?.breakerScope === 'NEW_OPEN_ORDERS_ONLY' && state?.closeAndReduceRoutesNeverBlocked === true;
    return {
      loaded: true,
      safe,
      diagnosticVersion: state?.diagnosticVersion || null,
      breakerScope: state?.breakerScope || null,
      closeAndReduceRoutesNeverBlocked: state?.closeAndReduceRoutesNeverBlocked === true,
      breakerActive: state?.breakerActive ?? null
    };
  } catch (error) {
    return { loaded: true, safe: false, error: String(error?.message || error).slice(0, 500) };
  }
}

function stageModulePresence() {
  return {
    shadowResearch: typeof global.__LEO_SHADOW_RESEARCH_STATE__ === 'function',
    alpacaValidator: typeof global.__LEO_ALPACA_VALIDATOR_STATE__ === 'function',
    quartrFundamentals: typeof global.__LEO_QUARTR_FUNDAMENTAL_STATE__ === 'function',
    exaCatalysts: typeof global.__LEO_EXA_CATALYST_STATE__ === 'function',
    shadowLab: typeof global.__LEO_SHADOW_LAB_STATE__ === 'function',
    opportunityDiscovery: typeof global.__LEO_SHADOW_DISCOVERY_STATE__ === 'function',
    calibrationBench: typeof global.__LEO_FOUNDATION_CALIBRATION_STATE__ === 'function',
    validationCockpit: typeof global.__LEO_FOUNDATION_VALIDATION_STATE__ === 'function'
  };
}

function buildPreflight(options = {}) {
  const preloads = parsePreloads(options.execArgv || process.execArgv);
  const execution = inspectExecutionSafety();
  const lunaExports = options.lunaExports || cachedExports(LUNA_COMPAT);
  const luna = inspectLunaCompatibility(lunaExports, options);
  const modules = stageModulePresence();
  const allStageModulesLoaded = Object.values(modules).every(Boolean);

  const preloadChecks = {
    safeDiagnosticPresent: preloads.includes(SAFE_DIAG),
    legacyDiagnosticAbsent: !preloads.includes(LEGACY_DIAG),
    aiOptimizerPresent: preloads.includes(AI_OPTIMIZER),
    lunaCompatibilityPresent: preloads.includes(LUNA_COMPAT),
    optimizerBeforeLunaCompatibility: ordered(preloads, AI_OPTIMIZER, LUNA_COMPAT)
  };

  const checks = {
    ...preloadChecks,
    executionSafetyVerified: execution.safe === true,
    lunaBehaviorVerified: luna.behaviorVerified === true,
    allStageModulesLoaded
  };
  const failedChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([name]) => name);
  const ready = failedChecks.length === 0;

  return {
    version: VERSION,
    at: new Date().toISOString(),
    readyForStage1To5IntegrationRehearsal: ready,
    readyForLivePromotion: false,
    failedChecks,
    preloads,
    checks,
    execution,
    luna,
    modules,
    safety: {
      readOnly: true,
      networkCalls: 0,
      marketDataCalls: 0,
      executionCalls: 0,
      openAiCalls: 0,
      strategyMutations: 0,
      sizingMutations: 0,
      liveExecutionArmedMutations: 0,
      automaticLivePromotion: false
    }
  };
}

const snapshot = buildPreflight();
global.__LEO_FOUNDATION_PREFLIGHT_STATE__ = () => buildPreflight();
global.__LEO_FOUNDATION_PREFLIGHT_LAST_SNAPSHOT__ = snapshot;
console.log(`${PREFIX} ${JSON.stringify({
  component: 'LEO_FOUNDATION_RUNTIME_PREFLIGHT',
  version: VERSION,
  event: 'STARTED',
  readyForStage1To5IntegrationRehearsal: snapshot.readyForStage1To5IntegrationRehearsal,
  readyForLivePromotion: false,
  failedChecks: snapshot.failedChecks,
  checks: snapshot.checks,
  safety: snapshot.safety
})}`);

module.exports = {
  VERSION,
  SAFE_DIAG,
  LEGACY_DIAG,
  AI_OPTIMIZER,
  LUNA_COMPAT,
  parsePreloads,
  ordered,
  inspectLunaCompatibility,
  buildPreflight
};
