'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('./ai-context-optimizer');

function basePayload() {
  return {
    trading_mode: 'LIVE',
    portfolio_summary: { availableCash: 9981.45, totalTrackedValue: 9981.45, positions: [] },
    market_data_summary: { overallStatus: 'LIVE', assets: {} },
    foundation_agents: { HealthAgent: { status: 'OK', circuitBreakerOpen: false } },
    agent_council: { status: 'VETOED', approved: false, votes: [] },
    instruction: 'Respect all hard vetoes.'
  };
}

test('adaptive dedupe shrinks repeated large current subtrees and preserves safety facts', () => {
  const payload = basePayload();
  const repeated = {
    asset: 'SPY', status: 'BLOCKED', approved: false, hardVeto: true,
    reason: 'CURRENT_PROVIDER_BLOCK',
    metrics: Object.fromEntries(Array.from({length: 2200}, (_, i) => [`metric_${i}`, i]))
  };
  for (const key of ['DuplicateA','DuplicateB','DuplicateC','DuplicateD','DuplicateE','DuplicateF']) {
    payload.foundation_agents[key] = JSON.parse(JSON.stringify(repeated));
  }
  const result = mod.compactDecisionPayload(payload);
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.afterChars < 120000, `too large: ${result.afterChars}`);
  assert.equal(result.safety.ok, true);
  assert.match(JSON.stringify(result.payload), /CURRENT_PROVIDER_BLOCK/);
  assert.ok((result.adaptive?.dedupeMetrics?.references || 0) >= 1);
});

test('adaptive opaque compaction reduces oversized rawData while preserving live safety projection', () => {
  const payload = basePayload();
  payload.foundation_agents.ProviderAdapter = {
    rawData: {
      symbol: 'GLD', tradable: false, status: 'BLOCKED',
      reason: 'CURRENT_RAWDATA_CLOSED', confidence: 91,
      metrics: Object.fromEntries(Array.from({length: 18000}, (_, i) => [`raw_metric_${i}`, i]))
    }
  };
  const result = mod.compactDecisionPayload(payload);
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.afterChars < 120000, `too large: ${result.afterChars}`);
  assert.equal(result.safety.ok, true);
  const raw = result.payload.foundation_agents.ProviderAdapter.rawData;
  assert.equal(raw.compacted, true);
  assert.equal(raw.kind, 'opaque-current-bulk');
  assert.equal(raw.safetyProjection.symbol, 'GLD');
  assert.equal(raw.safetyProjection.tradable, false);
  assert.equal(raw.safetyProjection.reason, 'CURRENT_RAWDATA_CLOSED');
  assert.equal(raw.safetyProjection.confidence, 91);
});

test('unique oversized current state still fails closed instead of deleting unknown current fields', () => {
  const payload = basePayload();
  payload.foundation_agents.CurrentMassiveState = Object.fromEntries(
    Array.from({length: 18000}, (_, i) => [`metric_${i}`, i])
  );
  const result = mod.compactDecisionPayload(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SAFE_COMPACTION_ABOVE_LIMIT');
  assert.equal(result.payload, payload);
});

test('small opaque current payload is preserved in full', () => {
  const payload = basePayload();
  payload.foundation_agents.ProviderAdapter = {
    rawData: { symbol: 'QQQ', tradable: false, reason: 'CURRENT_SMALL_BLOCK', extra: 'keep-me' }
  };
  const result = mod.compactDecisionPayload(payload);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.payload.foundation_agents.ProviderAdapter.rawData.extra, 'keep-me');
  assert.equal(result.payload.foundation_agents.ProviderAdapter.rawData.tradable, false);
});
