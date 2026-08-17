'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const preflight = require('./foundation-runtime-preflight.js');

test('parsePreloads preserves Node require order', () => {
  const list = preflight.parsePreloads([
    '-r', './etoro-execution-diagnostics-v10.22.10.js',
    '--require=./ai-cost-optimizer.js',
    '-r', './ai-luna-temperature-compat.js'
  ]);
  assert.deepEqual(list, [
    './etoro-execution-diagnostics-v10.22.10.js',
    './ai-cost-optimizer.js',
    './ai-luna-temperature-compat.js'
  ]);
  assert.equal(preflight.ordered(list, './ai-cost-optimizer.js', './ai-luna-temperature-compat.js'), true);
});

test('Luna inspection verifies forced effective-model temperature removal', () => {
  const compat = {
    VERSION: 'test-compat',
    sanitizeLunaParams(original, options) {
      const copy = { ...original };
      if (options.forcePrimaryModel && String(options.primaryModel).includes('gpt-5.6-luna')) delete copy.temperature;
      return copy;
    }
  };
  const result = preflight.inspectLunaCompatibility(compat, {
    primaryModel: 'gpt-5.6-luna',
    forcePrimaryModel: true
  });
  assert.equal(result.loaded, true);
  assert.equal(result.expectedRemoval, true);
  assert.equal(result.temperatureRemoved, true);
  assert.equal(result.originalUntouched, true);
  assert.equal(result.behaviorVerified, true);
});

test('preflight is green only when safe execution, AI compatibility and all research modules are present', () => {
  const names = [
    '__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__',
    '__LEO_SHADOW_RESEARCH_STATE__',
    '__LEO_ALPACA_VALIDATOR_STATE__',
    '__LEO_QUARTR_FUNDAMENTAL_STATE__',
    '__LEO_EXA_CATALYST_STATE__',
    '__LEO_SHADOW_LAB_STATE__',
    '__LEO_SHADOW_DISCOVERY_STATE__',
    '__LEO_FOUNDATION_CALIBRATION_STATE__',
    '__LEO_FOUNDATION_VALIDATION_STATE__'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, global[name]]));
  try {
    global.__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__ = () => ({
      diagnosticVersion: 'v10.22.10-safe-open-order-breaker',
      breakerScope: 'NEW_OPEN_ORDERS_ONLY',
      closeAndReduceRoutesNeverBlocked: true,
      breakerActive: false
    });
    for (const name of names.slice(1)) global[name] = () => ({});

    const compat = {
      VERSION: 'v10.22.9.1-luna-temperature-compat',
      sanitizeLunaParams(original, options) {
        const copy = { ...original };
        if (options.forcePrimaryModel && options.primaryModel === 'gpt-5.6-luna') delete copy.temperature;
        return copy;
      }
    };
    const snapshot = preflight.buildPreflight({
      execArgv: [
        '-r', './etoro-execution-diagnostics-v10.22.10.js',
        '-r', './ai-cost-optimizer.js',
        '-r', './ai-luna-temperature-compat.js'
      ],
      lunaExports: compat,
      primaryModel: 'gpt-5.6-luna',
      forcePrimaryModel: true
    });

    assert.equal(snapshot.readyForStage1To5IntegrationRehearsal, true);
    assert.equal(snapshot.readyForLivePromotion, false);
    assert.deepEqual(snapshot.failedChecks, []);
    assert.equal(snapshot.safety.networkCalls, 0);
    assert.equal(snapshot.safety.executionCalls, 0);
    assert.equal(snapshot.safety.openAiCalls, 0);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete global[name];
      else global[name] = value;
    }
  }
});

test('legacy execution diagnostics or wrong AI preload order fail closed', () => {
  const compat = {
    VERSION: 'test',
    sanitizeLunaParams(original) {
      const copy = { ...original };
      delete copy.temperature;
      return copy;
    }
  };
  const snapshot = preflight.buildPreflight({
    execArgv: [
      '-r', './etoro-execution-diagnostics.js',
      '-r', './ai-luna-temperature-compat.js',
      '-r', './ai-cost-optimizer.js'
    ],
    lunaExports: compat,
    primaryModel: 'gpt-5.6-luna',
    forcePrimaryModel: true
  });
  assert.equal(snapshot.readyForStage1To5IntegrationRehearsal, false);
  assert.ok(snapshot.failedChecks.includes('safeDiagnosticPresent'));
  assert.ok(snapshot.failedChecks.includes('legacyDiagnosticAbsent'));
  assert.ok(snapshot.failedChecks.includes('optimizerBeforeLunaCompatibility'));
});
