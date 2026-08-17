'use strict';

process.env.FOUNDATION_VALIDATION_LOG_INTERVAL_MINUTES = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const cockpit = require('./foundation-validation-cockpit');

function wrapped(value) { return { available: true, value, error: null }; }

test('stage 1 rejects legacy all-execution breaker scope', () => {
  const report = cockpit.stage1ExecutionSafety(wrapped({
    diagnosticVersion: 'v10.22.8-etoro-execution-diagnostics',
    breakerActive: false,
    lastDiagnostic: null
  }));
  assert.equal(report.gate, false);
  assert.equal(report.technicalStatus, 'INTEGRATION_BLOCKED');
});

test('stage 1 accepts only the open-order breaker with close/reduce guarantee', () => {
  const report = cockpit.stage1ExecutionSafety(wrapped({
    diagnosticVersion: 'v10.22.10-safe-open-order-breaker',
    breakerScope: 'NEW_OPEN_ORDERS_ONLY',
    closeAndReduceRoutesNeverBlocked: true,
    breakerActive: false,
    lastDiagnostic: { classification: 'BUSINESS_ACKNOWLEDGED', businessAcknowledged: true }
  }));
  assert.equal(report.gate, true);
  assert.equal(report.providerAckObserved, true);
  assert.equal(report.truePortfolioProofObserved, false);
});

test('stage 2 distinguishes technical readiness from elapsed-time outcome calibration', () => {
  const report = cockpit.stage2ShadowLab(wrapped({
    configuredUniverse: 83,
    signalsTracked: 25,
    outcomeSummary: {
      d1: { evaluatedSignals: 20 },
      d3: { evaluatedSignals: 15 },
      d7: { evaluatedSignals: 10 },
      d30: { evaluatedSignals: 5 }
    },
    safety: { canTrade: false, openAiEnabled: false, executionEndpointAllowed: false }
  }));
  assert.equal(report.gate, true);
  assert.equal(report.thresholdsMet, true);
  assert.equal(report.empiricalStatus, 'CALIBRATION_SAMPLE_READY');
});

test('stage 3 computes calibration rates without averaging providers', () => {
  const report = cockpit.stage3Alpaca(wrapped({
    stats: { validations: 40, confirmed: 32, divergent: 2, stale: 3, inconclusive: 3 },
    safety: { canTrade: false, canAuthorizeLive: false, networkClientPresent: false }
  }));
  assert.equal(report.gate, true);
  assert.equal(report.confirmedPct, 80);
  assert.equal(report.divergentPct, 5);
  assert.equal(report.sampleReady, true);
});

test('stage 4 remains technically ready while real connector validation stays external', () => {
  delete process.env.QUARTR_REAL_CONNECTOR_VALIDATED;
  const report = cockpit.stage4Quartr(wrapped({
    stats: { analyses: 4, strong: 1, healthy: 2, mixed: 1 },
    safety: {
      canTrade: false,
      canAuthorizeLive: false,
      networkClientPresent: false,
      rawExternalInstructionsExecuted: false
    }
  }));
  assert.equal(report.gate, true);
  assert.equal(report.empiricalStatus, 'EXTERNAL_ACCESS_BLOCKED');
  assert.match(report.externalDependency, /Quartr Pro/);
});

test('stage 5 requires both event volume and credible catalyst sample', () => {
  const report = cockpit.stage5Exa(wrapped({
    stats: {
      events: 35,
      confirmed: 4,
      primarySource: 3,
      possible: 8,
      rumorRisk: 2,
      conflicting: 1,
      rejectedInjection: 2,
      duplicatesRemoved: 5
    },
    safety: {
      canTrade: false,
      canAuthorizeLive: false,
      networkClientPresent: false,
      rawExternalInstructionsExecuted: false
    }
  }));
  assert.equal(report.gate, true);
  assert.equal(report.sourceSampleReady, true);
  assert.equal(report.predictiveCalibrationComplete, false);
});

test('cockpit snapshot is read-only and stage 6 is blocked when stage 1 safe integration is absent', async () => {
  const previous = {};
  const names = [
    '__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__', '__LEO_AI_COST_STATE__', '__LEO_SHADOW_LAB_STATE__',
    '__LEO_SHADOW_RESEARCH_STATE__', '__LEO_ALPACA_VALIDATOR_STATE__', '__LEO_QUARTR_FUNDAMENTAL_STATE__',
    '__LEO_EXA_CATALYST_STATE__', '__LEO_SHADOW_DISCOVERY_STATE__'
  ];
  for (const name of names) previous[name] = global[name];
  const originalFetch = global.fetch;
  let networkCalls = 0;
  global.fetch = async () => { networkCalls += 1; throw new Error('NETWORK_MUST_NOT_BE_CALLED'); };
  try {
    global.__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__ = () => ({ diagnosticVersion: 'v10.22.8-etoro-execution-diagnostics' });
    global.__LEO_AI_COST_STATE__ = async () => ({ enabled: true, primaryModel: 'gpt-5.6-luna', monthlyBudgetUsd: 1, persistent: true, state: { calls: 1 } });
    global.__LEO_SHADOW_LAB_STATE__ = async () => ({ safety: { canTrade: false, openAiEnabled: false }, outcomeSummary: {} });
    global.__LEO_SHADOW_RESEARCH_STATE__ = async () => ({ evidenceCount: 0, symbolScores: [] });
    global.__LEO_ALPACA_VALIDATOR_STATE__ = async () => ({ stats: {}, safety: { canTrade: false, networkClientPresent: false } });
    global.__LEO_QUARTR_FUNDAMENTAL_STATE__ = async () => ({ stats: {}, safety: { canTrade: false, networkClientPresent: false } });
    global.__LEO_EXA_CATALYST_STATE__ = async () => ({ stats: {}, safety: { canTrade: false, networkClientPresent: false, rawExternalInstructionsExecuted: false } });
    global.__LEO_SHADOW_DISCOVERY_STATE__ = async () => ({ runs: 0, lastRanking: [] });

    const snapshot = await cockpit.buildSnapshot();
    assert.equal(snapshot.safety.readOnly, true);
    assert.equal(snapshot.safety.networkCalls, 0);
    assert.equal(snapshot.safety.executionCalls, 0);
    assert.equal(snapshot.safety.openAiCalls, 0);
    assert.equal(snapshot.integration.stage1SafeIntegration, false);
    assert.equal(snapshot.roadmapPosition.stage6ShadowBuildAllowed, false);
    assert.equal(snapshot.roadmapPosition.livePromotionAllowed, false);
    assert.equal(networkCalls, 0);
  } finally {
    global.fetch = originalFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete global[name];
      else global[name] = previous[name];
    }
  }
});

test('cockpit source has no direct execution, network or OpenAI client surface', () => {
  const source = fs.readFileSync(path.join(__dirname, 'foundation-validation-cockpit.js'), 'utf8');
  assert.equal(/fetch\s*\(/.test(source), false);
  assert.equal(/require\s*\(\s*['"]openai['"]\s*\)/.test(source), false);
  assert.equal(/public-api\.etoro\.com/.test(source), false);
  assert.equal(/LIVE_EXECUTION_ARMED\s*=/.test(source), false);
});
