'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('./ai-context-optimizer');

function largeDecisionPayload() {
  const history = Array.from({ length: 900 }, (_, i) => ({ at: `2026-08-${String((i % 17) + 1).padStart(2, '0')}T10:00:00Z`, price: 100 + i / 100, note: 'historical-noise-'.repeat(8) }));
  const assets = {};
  for (const symbol of ['SPY','QQQ','GLD','SHY','XLV','XLP','NVDA','AMD']) {
    assets[symbol] = { symbol, status: 'FRESH', tradable: true, price: 100, technicalScore: 75, history };
  }
  const votes = [];
  for (const symbol of Object.keys(assets)) {
    votes.push({ asset: symbol, agent: 'MarketDataAgent', action: 'VETO', hardVeto: true, reason: symbol === 'SPY' ? 'MARKET_CLOSED' : 'DATA_RISK' });
    for (let i = 0; i < 18; i += 1) votes.push({ asset: symbol, agent: `Agent${i}`, action: 'HOLD', confidence: 60 + (i % 20), reason: 'Neutral evidence' });
  }
  return {
    source: 'auto-trade-cron', time: '2026-08-17T10:00:00.000Z', version: 'test', trading_mode: 'LIVE',
    max_order_usd: 523.95,
    progressive_order_policy: { maximumOrderUsd: 523.95, minimumCopiedUsd: 10, status: 'ACTIVE' },
    starter_portfolio_mode: true,
    preferred_next_assets: ['SPY','GLD','SHY'],
    watchlist: { SPY: 1001, QQQ: 1002, GLD: 1003, SHY: 1004, XLV: 1005, XLP: 1006, NVDA: 1007, AMD: 1008 },
    asset_rules: { SPY: { category: 'ETF', maxWeightPct: 25 }, GLD: { category: 'ETF', maxWeightPct: 20 } },
    portfolio_summary: { availableCash: 9981.45, totalTrackedValue: 9981.45, uniquePositionsCount: 0, positions: [], performanceHistory: history, allocationPlan: { status: 'REBALANCE_NEEDED', recommendedBuys: ['SPY','GLD','SHY'] } },
    market_data_summary: { overallStatus: 'MIXED', freshCount: 8, assets, history },
    foundation_agents: {
      HealthAgent: { status: 'OK', circuitBreakerOpen: false, reasons: [] },
      RiskBudgetAgent: { status: 'OK', newBuyBlocked: false, reason: 'Budget OK' },
      agentCouncil: { status: 'VETOED', approved: false, votes, agentCouncilHistory: history }
    },
    agent_council: { status: 'VETOED', approved: false, votes },
    execution_stats_24h: { total: 0, confirmed: 0, status: 'OK' },
    instruction: 'Choisis une seule décision. Respecte tous les hard veto.'
  };
}

test('large decision payload is reduced by at least 70% while preserving negative safety facts', () => {
  const payload = largeDecisionPayload();
  const result = mod.compactDecisionPayload(payload);
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.beforeChars > 300000, `expected a truly large fixture, got ${result.beforeChars}`);
  assert.ok(result.afterChars < 120000, `compacted payload too large: ${result.afterChars}`);
  assert.ok(result.reductionPct >= 70, `reduction only ${result.reductionPct}%`);
  assert.equal(result.safety.ok, true);
  const text = JSON.stringify(result.payload);
  assert.match(text, /MARKET_CLOSED/);
  assert.match(text, /DATA_RISK/);
  assert.match(text, /VETO/);
  assert.match(text, /hardVeto/);
});

test('non-decision OpenAI requests remain byte-for-byte untouched', () => {
  const original = { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hello' }], response_format: { type: 'json_object' } };
  const result = mod.optimizeParams(original);
  assert.equal(result.optimized, false);
  assert.equal(result.reason, 'NON_DECISION_REQUEST');
  assert.deepEqual(result.params, original);
});

test('malformed decision user JSON is passed through unchanged', () => {
  const original = { messages: [{ role: 'user', content: '{not-json' }] };
  const result = mod.optimizeParams(original);
  assert.equal(result.optimized, false);
  assert.deepEqual(result.params, original);
});

test('safety comparison detects loss of an asset-specific veto', () => {
  const payload = largeDecisionPayload();
  const compact = JSON.parse(JSON.stringify(payload));
  compact.agent_council.votes = compact.agent_council.votes.filter((v) => !(v.asset === 'SPY' && v.action === 'VETO'));
  compact.foundation_agents.agentCouncil.votes = compact.foundation_agents.agentCouncil.votes.filter((v) => !(v.asset === 'SPY' && v.action === 'VETO'));
  const result = mod.sameSafetyFacts(payload, compact);
  assert.equal(result.ok, false);
  assert.match(result.missing, /SPY/);
});

test('unsafe oversize payload falls back to original instead of deleting current scalar facts', () => {
  const payload = largeDecisionPayload();
  payload.foundation_agents.CurrentMassiveState = {};
  for (let i = 0; i < 18000; i += 1) payload.foundation_agents.CurrentMassiveState[`metric_${i}`] = i;
  const result = mod.compactDecisionPayload(payload);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SAFE_COMPACTION_ABOVE_LIMIT');
  assert.equal(result.payload, payload);
});

test('opaque current payload/raw keys are not discarded because they may carry current safety facts', () => {
  const payload = largeDecisionPayload();
  payload.foundation_agents.ProviderAdapter = {
    payload: { symbol: 'SPY', status: 'BLOCKED', hardVeto: true, reason: 'CURRENT_PROVIDER_BLOCK' },
    raw: { symbol: 'GLD', approved: false, reason: 'CURRENT_RAW_REJECT' },
    rawData: { symbol: 'QQQ', tradable: false, reason: 'CURRENT_RAWDATA_CLOSED' }
  };
  const result = mod.compactDecisionPayload(payload);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.payload.foundation_agents.ProviderAdapter.payload.hardVeto, true);
  assert.equal(result.payload.foundation_agents.ProviderAdapter.payload.reason, 'CURRENT_PROVIDER_BLOCK');
  assert.equal(result.payload.foundation_agents.ProviderAdapter.raw.approved, false);
  assert.equal(result.payload.foundation_agents.ProviderAdapter.raw.reason, 'CURRENT_RAW_REJECT');
  assert.equal(result.payload.foundation_agents.ProviderAdapter.rawData.tradable, false);
  assert.equal(result.payload.foundation_agents.ProviderAdapter.rawData.reason, 'CURRENT_RAWDATA_CLOSED');
});

test('historical arrays preserve both edges because runtime histories use mixed orientation', () => {
  const payload = largeDecisionPayload();
  payload.portfolio_summary.performanceHistory = [
    { id: 'front-newest', value: 1 },
    { id: 'front-2', value: 2 },
    { id: 'middle-1', value: 3 },
    { id: 'middle-2', value: 4 },
    { id: 'tail-2', value: 5 },
    { id: 'tail-newest', value: 6 }
  ];
  const result = mod.compactDecisionPayload(payload);
  assert.equal(result.ok, true, result.reason);
  const history = result.payload.portfolio_summary.performanceHistory;
  assert.equal(history.compacted, true);
  assert.deepEqual(history.first.map((x) => x.id), ['front-newest', 'front-2']);
  assert.deepEqual(history.last.map((x) => x.id), ['tail-2', 'tail-newest']);
  assert.equal(history.omittedMiddleCount, 2);
});

test('wrapper state explicitly has no strategy, sizing, eToro or LIVE mutation authority', () => {
  const state = global.__LEO_AI_CONTEXT_STATE__();
  assert.equal(state.safety.strategyModified, false);
  assert.equal(state.safety.sizingModified, false);
  assert.equal(state.safety.etoroModified, false);
  assert.equal(state.safety.liveExecutionArmedModified, false);
  assert.equal(state.safety.providerCallsAdded, 0);
});
