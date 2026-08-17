'use strict';

/**
 * LEO-AI SENTINEL v10.23.5 — Foundation Validation Cockpit
 *
 * Read-only observability for roadmap stages 1–5.
 * It performs no network request, no trading action, no strategy mutation,
 * no OpenAI call and no LIVE promotion. It only aggregates state already
 * exposed by the stage modules loaded in the same Node.js process.
 */

const VERSION = 'v10.23.5-foundation-validation-cockpit';
const ENABLED = process.env.FOUNDATION_VALIDATION_COCKPIT_ENABLED !== 'false';
const LOG_INTERVAL_MINUTES = clamp(process.env.FOUNDATION_VALIDATION_LOG_INTERVAL_MINUTES, 60, 0, 1440);
const LOG_INTERVAL_MS = LOG_INTERVAL_MINUTES * 60_000;

const THRESHOLDS = Object.freeze({
  shadowOutcomes: { d1: 20, d3: 15, d7: 10, d30: 5 },
  alpaca: { minimumValidations: 30, minimumConfirmedPct: 70, maximumDivergentPct: 10 },
  exa: { minimumEvents: 30, minimumConfirmedOrPrimary: 5 }
});

let lastSnapshot = null;
let lastEvent = null;
let timer = null;

function iso() { return new Date().toISOString(); }
function clamp(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}
function pct(part, total) {
  const p = Number(part || 0);
  const t = Number(total || 0);
  return t > 0 ? round((p / t) * 100, 2) : null;
}
function log(event, details = {}, level = 'log') {
  const payload = { component: 'LEO_FOUNDATION_VALIDATION_COCKPIT', version: VERSION, event, at: iso(), ...details };
  lastEvent = payload;
  global.__LEO_FOUNDATION_VALIDATION_LAST_EVENT__ = payload;
  (console[level] || console.log)(`[LEO_FOUNDATION_COCKPIT] ${JSON.stringify(payload)}`);
}
async function safeState(globalName) {
  try {
    const fn = global[globalName];
    if (typeof fn !== 'function') return { available: false, value: null, error: null };
    const value = await fn();
    return { available: true, value, error: null };
  } catch (error) {
    return { available: true, value: null, error: String(error?.message || error).slice(0, 700) };
  }
}

function stage1ExecutionSafety(diagState) {
  const diag = diagState?.value || null;
  const safeScope = diag?.breakerScope === 'NEW_OPEN_ORDERS_ONLY' && diag?.closeAndReduceRoutesNeverBlocked === true;
  const diagnosticVersion = diag?.diagnosticVersion || null;
  const last = diag?.lastDiagnostic || null;
  const providerAckObserved = Boolean(last?.businessAcknowledged === true || last?.classification === 'BUSINESS_ACKNOWLEDGED');
  return {
    stage: 1,
    name: 'eToro execution safety',
    technicalStatus: safeScope ? 'READY' : 'INTEGRATION_BLOCKED',
    empiricalStatus: providerAckObserved ? 'PARTIAL_PROVIDER_ACK' : 'PENDING_TRUE_PORTFOLIO_PROOF',
    diagnosticAvailable: Boolean(diagState?.available),
    diagnosticVersion,
    breakerScope: diag?.breakerScope || null,
    closeAndReduceRoutesNeverBlocked: diag?.closeAndReduceRoutesNeverBlocked === true,
    breakerActive: diag?.breakerActive ?? null,
    lastClassification: last?.classification || null,
    providerAckObserved,
    truePortfolioProofObserved: false,
    gate: safeScope,
    note: safeScope
      ? 'Safe open-order-only breaker loaded. Final proof still requires an accepted LIVE order followed by portfolio re-read.'
      : 'The loaded diagnostics are not the v10.22.10 open-order-only safety scope; do not promote this stack to LIVE.'
  };
}

function stage2ShadowLab(shadowState) {
  const shadow = shadowState?.value || null;
  const outcomes = shadow?.outcomeSummary || {};
  const counts = Object.fromEntries(Object.keys(THRESHOLDS.shadowOutcomes).map((key) => [key, Number(outcomes?.[key]?.evaluatedSignals || 0)]));
  const thresholdsMet = Object.entries(THRESHOLDS.shadowOutcomes).every(([key, minimum]) => counts[key] >= minimum);
  const safety = shadow?.safety || {};
  const technicalSafe = Boolean(shadowState?.available && shadow && safety.canTrade === false && safety.openAiEnabled === false);
  return {
    stage: 2,
    name: 'Shadow Intelligence Lab',
    technicalStatus: technicalSafe ? 'READY' : 'NOT_READY',
    empiricalStatus: thresholdsMet ? 'CALIBRATION_SAMPLE_READY' : 'COLLECTING_OUTCOMES',
    configuredUniverse: shadow?.configuredUniverse ?? null,
    signalsTracked: shadow?.signalsTracked ?? null,
    outcomeCounts: counts,
    requiredOutcomeCounts: THRESHOLDS.shadowOutcomes,
    thresholdsMet,
    safety: {
      canTrade: safety.canTrade ?? null,
      openAiEnabled: safety.openAiEnabled ?? null,
      executionEndpointAllowed: safety.executionEndpointAllowed ?? null
    },
    gate: technicalSafe
  };
}

function stage3Alpaca(alpacaState) {
  const alpaca = alpacaState?.value || null;
  const stats = alpaca?.stats || {};
  const validations = Number(stats.validations || 0);
  const confirmed = Number(stats.confirmed || 0);
  const divergent = Number(stats.divergent || 0);
  const confirmedPct = pct(confirmed, validations);
  const divergentPct = pct(divergent, validations);
  const sampleReady = validations >= THRESHOLDS.alpaca.minimumValidations &&
    confirmedPct != null && confirmedPct >= THRESHOLDS.alpaca.minimumConfirmedPct &&
    divergentPct != null && divergentPct <= THRESHOLDS.alpaca.maximumDivergentPct;
  const safety = alpaca?.safety || {};
  const technicalSafe = Boolean(alpacaState?.available && alpaca && safety.canTrade === false && safety.networkClientPresent === false);
  return {
    stage: 3,
    name: 'Alpaca Independent Data Validator',
    technicalStatus: technicalSafe ? 'READY' : 'NOT_READY',
    empiricalStatus: sampleReady ? 'CALIBRATED_SAMPLE_READY' : 'COLLECTING_PAIRED_OBSERVATIONS',
    validations,
    confirmed,
    divergent,
    stale: Number(stats.stale || 0),
    inconclusive: Number(stats.inconclusive || 0),
    confirmedPct,
    divergentPct,
    thresholds: THRESHOLDS.alpaca,
    sampleReady,
    safety: {
      canTrade: safety.canTrade ?? null,
      canAuthorizeLive: safety.canAuthorizeLive ?? null,
      networkClientPresent: safety.networkClientPresent ?? null
    },
    gate: technicalSafe
  };
}

function stage4Quartr(quartrState) {
  const quartr = quartrState?.value || null;
  const stats = quartr?.stats || {};
  const safety = quartr?.safety || {};
  const technicalSafe = Boolean(quartrState?.available && quartr && safety.canTrade === false && safety.networkClientPresent === false);
  const realConnectorValidated = process.env.QUARTR_REAL_CONNECTOR_VALIDATED === 'true';
  return {
    stage: 4,
    name: 'Quartr Fundamental Intelligence Agent',
    technicalStatus: technicalSafe ? 'READY' : 'NOT_READY',
    empiricalStatus: realConnectorValidated ? 'REAL_CONNECTOR_VALIDATED' : 'EXTERNAL_ACCESS_BLOCKED',
    analyses: Number(stats.analyses || 0),
    strong: Number(stats.strong || 0),
    healthy: Number(stats.healthy || 0),
    mixed: Number(stats.mixed || 0),
    weak: Number(stats.weak || 0),
    inconclusive: Number(stats.inconclusive || 0),
    realConnectorValidated,
    externalDependency: realConnectorValidated ? null : 'Quartr Pro access required for real connector/schema validation',
    safety: {
      canTrade: safety.canTrade ?? null,
      canAuthorizeLive: safety.canAuthorizeLive ?? null,
      networkClientPresent: safety.networkClientPresent ?? null,
      rawExternalInstructionsExecuted: safety.rawExternalInstructionsExecuted ?? null
    },
    gate: technicalSafe
  };
}

function stage5Exa(exaState) {
  const exa = exaState?.value || null;
  const stats = exa?.stats || {};
  const events = Number(stats.events || 0);
  const confirmed = Number(stats.confirmed || 0);
  const primarySource = Number(stats.primarySource || 0);
  const sourceSampleReady = events >= THRESHOLDS.exa.minimumEvents && (confirmed + primarySource) >= THRESHOLDS.exa.minimumConfirmedOrPrimary;
  const safety = exa?.safety || {};
  const technicalSafe = Boolean(exaState?.available && exa && safety.canTrade === false && safety.networkClientPresent === false && safety.rawExternalInstructionsExecuted === false);
  return {
    stage: 5,
    name: 'Exa News & Catalyst Agent',
    technicalStatus: technicalSafe ? 'READY' : 'NOT_READY',
    empiricalStatus: sourceSampleReady ? 'SOURCE_SAMPLE_READY_PREDICTIVE_CALIBRATION_PENDING' : 'COLLECTING_SOURCE_SAMPLE',
    events,
    confirmed,
    primarySource,
    possible: Number(stats.possible || 0),
    rumorRisk: Number(stats.rumorRisk || 0),
    conflicting: Number(stats.conflicting || 0),
    rejectedInjection: Number(stats.rejectedInjection || 0),
    duplicatesRemoved: Number(stats.duplicatesRemoved || 0),
    sourceSampleReady,
    predictiveCalibrationComplete: false,
    thresholds: THRESHOLDS.exa,
    safety: {
      canTrade: safety.canTrade ?? null,
      canAuthorizeLive: safety.canAuthorizeLive ?? null,
      networkClientPresent: safety.networkClientPresent ?? null,
      rawExternalInstructionsExecuted: safety.rawExternalInstructionsExecuted ?? null
    },
    gate: technicalSafe
  };
}

async function buildSnapshot() {
  const [diag, aiCost, shadow, research, alpaca, quartr, exa, discovery] = await Promise.all([
    safeState('__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__'),
    safeState('__LEO_AI_COST_STATE__'),
    safeState('__LEO_SHADOW_LAB_STATE__'),
    safeState('__LEO_SHADOW_RESEARCH_STATE__'),
    safeState('__LEO_ALPACA_VALIDATOR_STATE__'),
    safeState('__LEO_QUARTR_FUNDAMENTAL_STATE__'),
    safeState('__LEO_EXA_CATALYST_STATE__'),
    safeState('__LEO_SHADOW_DISCOVERY_STATE__')
  ]);

  const stages = [
    stage1ExecutionSafety(diag),
    stage2ShadowLab(shadow),
    stage3Alpaca(alpaca),
    stage4Quartr(quartr),
    stage5Exa(exa)
  ];
  const technicalReadyCount = stages.filter((stage) => stage.gate).length;
  const allTechnicalReady = technicalReadyCount === stages.length;
  const stage1SafeIntegration = stages[0].gate === true;
  const stage6ShadowBuildAllowed = allTechnicalReady;
  const livePromotionAllowed = false;

  const snapshot = {
    version: VERSION,
    generatedAt: iso(),
    enabled: ENABLED,
    roadmapPosition: {
      technicallyBuiltStages: 5,
      totalStages: 15,
      technicalReadyCount,
      allTechnicalReady,
      stage6ShadowBuildAllowed,
      livePromotionAllowed,
      livePromotionBlockReason: 'Separate production validation is mandatory; empirical gates and true eToro portfolio proof remain independent requirements.'
    },
    integration: {
      stage1SafeIntegration,
      expectedDiagnosticVersion: 'v10.22.10-safe-open-order-breaker',
      loadedDiagnosticVersion: stages[0].diagnosticVersion,
      safeBreakerScopeRequired: 'NEW_OPEN_ORDERS_ONLY',
      closeAndReduceRoutesMustRemainAvailable: true
    },
    aiCost: aiCost?.value ? {
      enabled: aiCost.value.enabled ?? null,
      primaryModel: aiCost.value.primaryModel ?? null,
      monthlyBudgetUsd: aiCost.value.monthlyBudgetUsd ?? null,
      persistent: aiCost.value.persistent ?? null,
      providerBreakerActive: aiCost.value.providerBreakerActive ?? null,
      state: aiCost.value.state ? {
        monthCostUsd: aiCost.value.state.monthCostUsd ?? null,
        calls: aiCost.value.state.calls ?? null,
        successfulCalls: aiCost.value.state.successfulCalls ?? null,
        failedCalls: aiCost.value.state.failedCalls ?? null,
        blockedCalls: aiCost.value.state.blockedCalls ?? null,
        lastModel: aiCost.value.state.lastModel ?? null,
        lastSuccessAt: aiCost.value.state.lastSuccessAt ?? null
      } : null
    } : null,
    research: research?.value ? {
      evidenceCount: research.value.evidenceCount ?? null,
      topSymbolScores: Array.isArray(research.value.symbolScores) ? research.value.symbolScores.slice(0, 10) : []
    } : null,
    discovery: discovery?.value ? {
      runs: discovery.value.runs ?? null,
      topRanking: Array.isArray(discovery.value.lastRanking) ? discovery.value.lastRanking.slice(0, 10) : []
    } : null,
    stages,
    moduleErrors: {
      executionDiagnostics: diag.error,
      aiCost: aiCost.error,
      shadowLab: shadow.error,
      research: research.error,
      alpaca: alpaca.error,
      quartr: quartr.error,
      exa: exa.error,
      discovery: discovery.error
    },
    safety: {
      readOnly: true,
      networkCalls: 0,
      executionCalls: 0,
      openAiCalls: 0,
      strategyMutations: 0,
      sizingMutations: 0,
      liveAllowlistMutations: 0,
      automaticLivePromotion: false
    },
    lastEvent
  };
  lastSnapshot = snapshot;
  global.__LEO_FOUNDATION_VALIDATION_LAST_SNAPSHOT__ = snapshot;
  return snapshot;
}

async function emitSnapshot(trigger = 'manual') {
  const snapshot = await buildSnapshot();
  log('SNAPSHOT', {
    trigger,
    technicalReadyCount: snapshot.roadmapPosition.technicalReadyCount,
    stage1SafeIntegration: snapshot.integration.stage1SafeIntegration,
    stage6ShadowBuildAllowed: snapshot.roadmapPosition.stage6ShadowBuildAllowed,
    livePromotionAllowed: false,
    stageStatuses: snapshot.stages.map((stage) => ({ stage: stage.stage, technicalStatus: stage.technicalStatus, empiricalStatus: stage.empiricalStatus }))
  }, snapshot.integration.stage1SafeIntegration ? 'log' : 'warn');
  return snapshot;
}

global.__LEO_FOUNDATION_VALIDATION_STATE__ = buildSnapshot;
global.__LEO_FOUNDATION_VALIDATION_EMIT__ = emitSnapshot;

if (ENABLED && LOG_INTERVAL_MS > 0) {
  timer = setInterval(() => {
    emitSnapshot('interval').catch((error) => log('SNAPSHOT_FAILED', { error: String(error?.message || error).slice(0, 700) }, 'warn'));
  }, LOG_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

log('STARTED', {
  enabled: ENABLED,
  logIntervalMinutes: LOG_INTERVAL_MINUTES,
  readOnly: true,
  networkCalls: 0,
  executionCalls: 0,
  openAiCalls: 0,
  livePromotionAllowed: false
});

module.exports = {
  VERSION,
  THRESHOLDS,
  buildSnapshot,
  emitSnapshot,
  stage1ExecutionSafety,
  stage2ShadowLab,
  stage3Alpaca,
  stage4Quartr,
  stage5Exa
};
