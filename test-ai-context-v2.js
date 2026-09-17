'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('./ai-context-optimizer-v2');

function hugePayload() {
  return {
    source: 'auto-trade-cron', time: '2026-09-02T20:00:00.000Z', version: 'test', trading_mode: 'LIVE',
    max_order_usd: 523.95, starter_portfolio_mode: true,
    preferred_next_assets: ['SPY','QQQ','SHY'],
    portfolio_summary: { availableCash: 8928.37, totalTrackedValue: 9976.21, positions: [] },
    market_data_summary: { overallStatus: 'LIVE', freshCount: 9 },
    foundation_agents: {
      HugeCurrentState: Object.fromEntries(Array.from({length: 26000}, (_, i) => [`metric_${i}`, i])),
      RiskBudgetAgent: { asset: 'SPY', status: 'OK', newBuyBlocked: false, reason: 'Budget OK' },
      DataAgent: { asset: 'QQQ', status: 'BLOCKED', hardVeto: true, reason: 'CURRENT_PROVIDER_BLOCK' }
    },
    agent_council: {
      status: 'MIXED', approvedBuyAssets: ['SPY'],
      assets: {
        SPY: { status: 'APPROVED_BUY', recommendation: 'BUY', confidence: 82, buySupportPct: 66 },
        QQQ: { status: 'VETOED', recommendation: 'HOLD', hardVeto: true, reason: 'CURRENT_PROVIDER_BLOCK' }
      }
    },
    execution_stats_24h: { confirmed: 0 },
    instruction: 'Respect all hard vetoes.'
  };
}

test('v2 compacts unique oversized current state while preserving safety facts', () => {
  const payload = hugePayload();
  const result = mod.compactDecisionPayloadV2(payload);
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.beforeChars > 300000);
  assert.ok(result.afterChars < 80000, `afterChars=${result.afterChars}`);
  assert.equal(result.safety.ok, true);
  const text = JSON.stringify(result.payload);
  assert.match(text, /CURRENT_PROVIDER_BLOCK/);
  assert.match(text, /APPROVED_BUY/);
  assert.match(text, /SPY/);
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
  assert.equal(state.safety.strategyModified, false);
  assert.equal(state.safety.sizingModified, false);
  assert.equal(state.safety.etoroModified, false);
  assert.equal(state.safety.liveExecutionArmedModified, false);
  assert.equal(state.safety.providerCallsAdded, 0);
});
