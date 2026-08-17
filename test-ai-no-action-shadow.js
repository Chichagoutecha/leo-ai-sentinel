'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('./ai-no-action-shadow');

function payload(overrides = {}) {
  const councilAssets = {
    SPY: { status: 'VETOED' },
    GLD: { status: 'VETOED' },
    SHY: { status: 'VETOED' }
  };
  const base = {
    trading_mode: 'LIVE',
    portfolio_summary: { uniquePositionsCount: 0 },
    market_data_summary: { overallStatus: 'OK' },
    foundation_agents: {
      agentCouncil: {
        assets: councilAssets,
        approvedBuyAssets: [],
        approvedSellAssets: [],
        summary: { analyzedAssets: 3, approvedBuys: 0, approvedSells: 0, vetoed: 3 }
      }
    },
    agent_council: {
      assets: councilAssets,
      approvedBuyAssets: [],
      approvedSellAssets: [],
      summary: { analyzedAssets: 3, approvedBuys: 0, approvedSells: 0, vetoed: 3 }
    },
    instruction: 'Choisis une seule décision.'
  };
  return { ...base, ...overrides };
}

test('marks empty portfolio with every analyzed asset vetoed as shadow deterministic HOLD candidate', () => {
  const result = mod.analyzeNoAction(payload());
  assert.equal(result.wouldHold, true);
  assert.equal(result.reason, 'EMPTY_PORTFOLIO_ALL_COUNCIL_ASSETS_VETOED');
  assert.equal(result.analyzedAssets, 3);
});

test('never proposes skip when any position is open because SELL review must remain possible', () => {
  const p = payload();
  p.portfolio_summary.uniquePositionsCount = 1;
  const result = mod.analyzeNoAction(p);
  assert.equal(result.wouldHold, false);
  assert.equal(result.reason, 'OPEN_POSITION_REQUIRES_FULL_REVIEW');
});

test('never proposes skip when council has an approved BUY', () => {
  const p = payload();
  p.agent_council.summary.approvedBuys = 1;
  p.agent_council.approvedBuyAssets = ['SPY'];
  const result = mod.analyzeNoAction(p);
  assert.equal(result.wouldHold, false);
  assert.equal(result.reason, 'COUNCIL_HAS_ACTIONABLE_APPROVAL');
});

test('never proposes skip when council has an approved SELL', () => {
  const p = payload();
  p.agent_council.summary.approvedSells = 1;
  p.agent_council.approvedSellAssets = ['SPY'];
  const result = mod.analyzeNoAction(p);
  assert.equal(result.wouldHold, false);
  assert.equal(result.reason, 'COUNCIL_HAS_ACTIONABLE_APPROVAL');
});

test('never proposes skip for partial veto coverage', () => {
  const p = payload();
  p.agent_council.summary.vetoed = 2;
  const result = mod.analyzeNoAction(p);
  assert.equal(result.wouldHold, false);
  assert.equal(result.reason, 'NOT_ALL_ANALYZED_ASSETS_VETOED');
});

test('cross-checks per-asset statuses against the council summary', () => {
  const p = payload();
  p.agent_council.assets.GLD.status = 'HIGH_DISAGREEMENT';
  const result = mod.analyzeNoAction(p);
  assert.equal(result.wouldHold, false);
  assert.equal(result.reason, 'COUNCIL_SUMMARY_ASSET_STATUS_MISMATCH');
});

test('wrapper explicitly remains shadow-only with no execution or request mutation authority', () => {
  const state = global.__LEO_AI_NO_ACTION_SHADOW_STATE__();
  assert.equal(state.safety.requestActuallySkipped, false);
  assert.equal(state.safety.responseModified, false);
  assert.equal(state.safety.strategyModified, false);
  assert.equal(state.safety.sizingModified, false);
  assert.equal(state.safety.etoroModified, false);
  assert.equal(state.safety.liveExecutionArmedModified, false);
  assert.equal(state.safety.providerCallsAdded, 0);
});
