'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('./ai-context-optimizer-v2');

function hugePayload() {
  return {
    source: 'auto-trade-cron',
    time: '2026-09-24T10:10:00.000Z',
    version: 'test',
    trading_mode: 'LIVE',
    max_order_usd: 523.95,
    starter_portfolio_mode: true,
    progressive_order_policy: {
      maximumOrderUsd: 523.95,
      minimumVirtualExecutableUsd: 523.95,
      status: 'ACTIVE'
    },
    preferred_next_assets: ['SPY','QQQ','SHY','XLV','XLP'],
    portfolio_summary: {
      availableCash: 7880.53,
      totalTrackedValue: 9976.21,
      positions: [
        { asset: 'SPY', value: 500, status: 'OPEN' },
        { asset: 'QQQ', value: 500, status: 'OPEN' },
        { asset: 'GLD', value: 500, status: 'OPEN' },
        { asset: 'BTC', value: 523.89, status: 'OPEN' }
      ]
    },
    market_data_summary: {
      overallStatus: 'MIXED',
      freshCount: 3,
      ratesByAsset: {
        SPY: { asset: 'SPY', priceStatus: 'MARKET_CLOSED', marketState: 'CLOSED', eligibleForTrade: false, price: 650 },
        QQQ: { asset: 'QQQ', priceStatus: 'MARKET_CLOSED', marketState: 'CLOSED', eligibleForTrade: false, price: 580 },
        BTC: { asset: 'BTC', priceStatus: 'FRESH', marketState: 'OPEN_24_7', eligibleForTrade: true, price: 72000 }
      }
    },
    foundation_agents: {
      HugeCurrentState: Object.fromEntries(Array.from({length: 30000}, (_, i) => ['metric_' + i, i])),
      RiskBudgetAgent: {
        asset: 'SOL',
        status: 'BLOCKED',
        newBuyBlocked: true,
        reason: 'ALLOCABLE_MARGIN_BELOW_MINIMUM_VIRTUAL_523_95'
      },
      DataAgent: {
        asset: 'QQQ',
        status: 'BLOCKED',
        hardVeto: true,
        reason: 'CURRENT_PROVIDER_BLOCK'
      }
    },
    agent_council: {
      status: 'MIXED',
      approvedBuyAssets: ['SPY'],
      approvedSellAssets: [],
      assets: {
        SPY: {
          status: 'APPROVED_BUY',
          recommendation: 'BUY',
          confidence: 82,
          buySupportPct: 66,
          hardVetoes: []
        },
        QQQ: {
          status: 'VETOED',
          recommendation: 'HOLD',
          hardVeto: true,
          reason: 'CURRENT_PROVIDER_BLOCK'
        },
        SOL: {
          status: 'VETOED',
          recommendation: 'HOLD',
          hardVeto: true,
          reason: 'ALLOCABLE_MARGIN_BELOW_MINIMUM_VIRTUAL_523_95'
        }
      }
    },
    execution_stats_24h: { confirmed: 0, status: 'OK' },
    execution_awareness: {
      approvedBuyAssets: ['SPY'],
      approvedBuyExecutableNow: [],
      approvedBuyUnavailableNow: ['SPY'],
      executionSafe: false,
      reason: 'UCITS_EXECUTION_VENUE_CLOSED'
    },
    instruction: 'Respect all hard vetoes and only select council-approved actions.'
  };
}

function deeplyNestedBlocker() {
  let value = {
    asset: 'SOL',
    status: 'BLOCKED',
    hardVeto: true,
    reason: 'DEEP_UNIQUE_HARD_VETO_MUST_SURVIVE'
  };
  for (let i = 0; i < 16; i += 1) value = { ['layer_' + i]: value };
  return value;
}

test('v10.22.18 compacts oversized current state into the 50k target when possible', () => {
  const payload = hugePayload();
  const result = mod.compactDecisionPayloadV2(payload);
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.beforeChars > 300000, 'fixture must reproduce an oversized request');
  assert.ok(result.afterChars <= 50000, 'afterChars=' + result.afterChars);
  assert.equal(result.safety.ok, true);
  assert.equal(result.targetMet, true);

  const text = JSON.stringify(result.payload);
  assert.match(text, /CURRENT_PROVIDER_BLOCK/);
  assert.match(text, /ALLOCABLE_MARGIN_BELOW_MINIMUM_VIRTUAL_523_95/);
  assert.match(text, /APPROVED_BUY/);
  assert.match(text, /UCITS_EXECUTION_VENUE_CLOSED/);
});

test('exact safety manifest preserves a hard veto omitted by depth-focused projection', () => {
  const payload = hugePayload();
  payload.foundation_agents.DeeplyNestedAgent = deeplyNestedBlocker();

  const result = mod.compactDecisionPayloadV2(payload);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.safety.ok, true);
  assert.ok(result.safety.manifestCount >= 1);

  const manifest = result.payload.__leo_safety_manifest;
  assert.ok(manifest);
  assert.equal(manifest.exact, true);
  assert.ok(manifest.facts.some((fact) => fact.includes('DEEP_UNIQUE_HARD_VETO_MUST_SURVIVE')));
  assert.equal(mod.manifestSafetyCheck(payload, result.payload).ok, true);
});

test('production-like many-agent safety state stays under fail-closed ceiling', () => {
  const payload = hugePayload();
  for (let i = 0; i < 140; i += 1) {
    payload.foundation_agents['Guard_' + i] = {
      asset: i % 2 === 0 ? 'SPY' : 'QQQ',
      status: i % 3 === 0 ? 'BLOCKED' : 'OK',
      hardVeto: i % 3 === 0,
      confidence: 60 + (i % 35),
      reason: i % 3 === 0 ? 'UNIQUE_GUARD_REASON_' + i : 'GUARD_OK_' + i,
      metrics: Object.fromEntries(Array.from({length: 120}, (_, j) => ['m_' + j, j]))
    };
  }

  const result = mod.compactDecisionPayloadV2(payload);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.safety.ok, true);
  assert.ok(result.afterChars <= 70000, 'afterChars=' + result.afterChars);
});

test('request diagnostics include system prompt and show a materially smaller provider request', () => {
  const payload = hugePayload();
  const params = {
    model: 'gpt-5.6-luna',
    temperature: 0.1,
    messages: [
      { role: 'system', content: 'SYSTEM_RULES '.repeat(1500) },
      { role: 'user', content: JSON.stringify(payload) }
    ]
  };

  const result = mod.optimizeParams(params);
  assert.equal(result.optimized, true, result.reason);
  assert.ok(result.metrics.requestCharsBefore > result.metrics.requestCharsAfter);
  assert.ok(result.metrics.requestCharsAfter < 100000, 'requestCharsAfter=' + result.metrics.requestCharsAfter);
  assert.ok(result.metrics.roughInputTokenEstimateAfter < 25000);
});

test('v2 leaves small decision payload alone', () => {
  const payload = hugePayload();
  payload.foundation_agents.HugeCurrentState = { metric_1: 1 };
  const result = mod.compactDecisionPayloadV2(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'BELOW_TRIGGER');
});

test('v2 wrapper governance exposes no LIVE mutation authority', () => {
  const state = global.__LEO_AI_CONTEXT_V2_STATE__();
  assert.equal(state.version, 'v10.22.18.0-ai-context-v2');
  assert.equal(state.safety.exactMissingFactsManifested, true);
  assert.equal(state.safety.failClosedAboveCeiling, true);
  assert.equal(state.safety.strategyModified, false);
  assert.equal(state.safety.sizingModified, false);
  assert.equal(state.safety.etoroModified, false);
  assert.equal(state.safety.liveExecutionArmedModified, false);
  assert.equal(state.safety.providerCallsAdded, 0);
});
