'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AI_DECISION_CONTEXT_V2_AUTO_INSTALL = 'false';
const mod = require('./ai-decision-context-v2.js');

function bridgeState() {
  return {
    mode: 'live',
    approvedSymbols: ['CSPX.L', 'CNDX.L', 'IGLN.L', 'IBTA.L'],
    mappings: {
      SPY: { analysisInstrumentId: 3417, executionSymbol: 'CSPX.L', venue: 'LSE' },
      QQQ: { analysisInstrumentId: 3418, executionSymbol: 'CNDX.L', venue: 'LSE' },
      GLD: { analysisInstrumentId: 15634, executionSymbol: 'IGLN.L', venue: 'LSE' },
      SHY: { analysisInstrumentId: 3100, executionSymbol: 'IBTA.L', venue: 'LSE' }
    }
  };
}

function decisionPayload() {
  return {
    source: 'auto-trade-cron',
    time: '2026-09-02T20:00:00.000Z',
    version: 'test',
    trading_mode: 'LIVE',
    max_order_usd: 523.95,
    progressive_order_policy: { maximumOrderUsd: 523.95, minimumCopiedUsd: 10, status: 'ACTIVE' },
    starter_portfolio_mode: true,
    preferred_next_assets: ['SPY', 'QQQ', 'SHY'],
    watchlist: { SPY: 3417, QQQ: 3418, GLD: 15634, SHY: 3100, BTC: 100109 },
    asset_rules: { SPY: { category: 'ETF', maxWeightPct: 25 }, BTC: { category: 'CRYPTO', maxWeightPct: 10 } },
    portfolio_summary: { availableCash: 8928.37, totalTrackedValue: 9976.21, positions: [] },
    market_data_summary: { overallStatus: 'LIVE', assets: { SPY: { asset: 'SPY', status: 'FRESH', tradable: true, price: 650 }, BTC: { asset: 'BTC', status: 'FRESH', tradable: true, price: 100000 } } },
    foundation_agents: { HealthAgent: { status: 'OK', circuitBreakerOpen: false }, RiskBudgetAgent: { status: 'OK', newBuyBlocked: false } },
    agent_council: {
      status: 'READY',
      approvedBuyAssets: ['SPY'],
      assets: {
        SPY: { asset: 'SPY', status: 'APPROVED_BUY', recommendation: 'BUY', buySupportPct: 66, disagreementPct: 20, hardVetoes: [], reasons: ['support'] },
        BTC: { asset: 'BTC', status: 'HOLD', recommendation: 'HOLD', buySupportPct: 30, disagreementPct: 40, hardVetoes: [], reasons: ['weak'] }
      },
      ranking: [{ asset: 'SPY', status: 'APPROVED_BUY', recommendation: 'BUY', buySupportPct: 66 }]
    },
    execution_stats_24h: { total: 0, confirmed: 0, status: 'OK' },
    instruction: 'Choose one decision and respect hard vetoes.'
  };
}

test('execution window marks LSE mapped assets closed after venue hours and open during session', () => {
  const closed = mod.buildExecutionWindow(decisionPayload(), new Date('2026-09-02T20:00:00.000Z'), bridgeState());
  assert.equal(closed.mappedAssets.SPY.buyExecutableNow, false);
  assert.equal(closed.mappedAssets.SPY.reason, 'UCITS_EXECUTION_VENUE_CLOSED');
  const open = mod.buildExecutionWindow(decisionPayload(), new Date('2026-09-02T14:00:00.000Z'), bridgeState());
  assert.equal(open.mappedAssets.SPY.buyExecutableNow, true);
  assert.equal(open.mappedAssets.SPY.reason, 'UCITS_EXECUTION_WINDOW_OPEN');
});

test('execution-aware instruction is fail-closed without relaxing existing risk gates', () => {
  const window = mod.buildExecutionWindow(decisionPayload(), new Date('2026-09-02T20:00:00.000Z'), bridgeState());
  const instruction = mod.executionAwareInstruction('ORIGINAL RULES', window);
  assert.match(instruction, /never choose BUY/i);
  assert.match(instruction, /does not relax/i);
  assert.match(instruction, /SPY/);
  assert.match(instruction, /ORIGINAL RULES/);
});

test('focused v2 projection shrinks unique massive current state below target while preserving safety facts', () => {
  const payload = decisionPayload();
  payload.foundation_agents.CurrentMassiveState = {
    asset: 'SPY', status: 'BLOCKED', approved: false, hardVeto: true, reason: 'CURRENT_UNIQUE_HARD_VETO',
    ...Object.fromEntries(Array.from({ length: 22000 }, (_, i) => [`metric_${i}`, i]))
  };
  const params = { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: JSON.stringify(payload) }] };
  const prepared = mod.prepareDecisionParams(params, new Date('2026-09-02T20:00:00.000Z'), bridgeState());
  assert.equal(prepared.optimized, true);
  assert.ok(prepared.beforeChars > 200000, `fixture too small: ${prepared.beforeChars}`);
  assert.ok(prepared.afterChars < 90000, `v2 too large: ${prepared.afterChars}`);
  assert.equal(prepared.safety.ok, true);
  const text = prepared.params.messages[0].content;
  assert.match(text, /CURRENT_UNIQUE_HARD_VETO/);
  assert.match(text, /UCITS_EXECUTION_VENUE_CLOSED/);
});

test('non-decision request stays unchanged', () => {
  const original = { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hello' }] };
  const prepared = mod.prepareDecisionParams(original, new Date('2026-09-02T20:00:00.000Z'), bridgeState());
  assert.equal(prepared.optimized, false);
  assert.equal(prepared.reason, 'NON_DECISION_REQUEST');
  assert.deepEqual(prepared.params, original);
});

test('governance explicitly adds no provider call and changes no broker/risk/sizing authority', () => {
  const state = global.__LEO_DECISION_CONTEXT_V2_STATE__();
  assert.equal(state.governance.providerCallsAdded, 0);
  assert.equal(state.governance.riskThresholdsModified, false);
  assert.equal(state.governance.sizingModified, false);
  assert.equal(state.governance.etoroOrderRuntimeModified, false);
  assert.equal(state.governance.liveExecutionArmedModified, false);
  assert.equal(state.governance.directOrderAuthority, false);
});
