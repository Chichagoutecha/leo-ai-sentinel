'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('./execution-aware-decision-runtime');

test('LSE mapped BUY is unavailable after close while crypto remains executable', () => {
  const payload = { agent_council: { approvedBuyAssets: ['SPY','BTC'] } };
  const awareness = mod.buildExecutionAwareness(payload, new Date('2026-09-02T20:00:00Z'));
  assert.deepEqual(awareness.approvedBuyUnavailableNow, ['SPY']);
  assert.ok(awareness.approvedBuyExecutableNow.includes('BTC'));
  assert.equal(awareness.mappedAssets.SPY.executionSymbol, 'CSPX.L');
});

test('mapped UCITS BUY is executable during the venue window', () => {
  const payload = { agent_council: { approvedBuyAssets: ['SPY','XLV'] } };
  const awareness = mod.buildExecutionAwareness(payload, new Date('2026-09-02T12:00:00Z'));
  assert.equal(awareness.mappedAssets.SPY.executableNow, true);
  assert.equal(awareness.mappedAssets.XLV.executableNow, true);
});

test('augmentation adds execution policy without changing council state', () => {
  const payload = {
    trading_mode: 'LIVE', portfolio_summary: {}, market_data_summary: {}, foundation_agents: {},
    agent_council: { approvedBuyAssets: ['SPY'], assets: { SPY: { status: 'APPROVED_BUY' } } },
    instruction: 'Respect the council.'
  };
  const originalCouncil = JSON.parse(JSON.stringify(payload.agent_council));
  const augmented = mod.augmentDecisionPayload(payload, new Date('2026-09-02T20:00:00Z'));
  assert.deepEqual(augmented.agent_council, originalCouncil);
  assert.match(augmented.instruction, /EXECUTION-AWARE RULE/);
  assert.equal(augmented.execution_awareness.mappedAssets.SPY.executableNow, false);
});

test('diagnostics identify HOLD despite an executable approved BUY', () => {
  const payload = { agent_council: { status: 'MIXED', approvedBuyAssets: ['BTC'] } };
  const awareness = mod.buildExecutionAwareness(payload, new Date('2026-09-02T20:00:00Z'));
  const diag = mod.buildDiagnostics(payload, { action: 'HOLD', asset: 'NONE', confidence: 58, reason: 'No trade' }, awareness);
  assert.equal(diag.holdDespiteExecutableApprovedBuy, true);
  assert.deepEqual(diag.approvedBuyExecutableNow, ['BTC']);
});

test('runtime governance cannot place or rewrite orders', () => {
  const state = global.__LEO_EXECUTION_AWARE_DECISION_STATE__();
  assert.equal(state.governance.canPlaceOrder, false);
  assert.equal(state.governance.canModifyOrder, false);
  assert.equal(state.governance.canModifySizing, false);
  assert.equal(state.governance.canOverrideHardVeto, false);
  assert.equal(state.governance.providerCallsAdded, 0);
});
