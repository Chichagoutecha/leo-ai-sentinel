'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.HOLD_SHADOW_AUTO_INSTALL = 'false';
process.env.HOLD_SHADOW_ENABLED = 'true';
const mod = require('./hold-opportunity-shadow-agent');

function basePayload() {
  return {
    source: 'auto-trade-cron',
    time: '2026-09-17T10:00:00.000Z',
    trading_mode: 'LIVE',
    watchlist: { SPY: 3417, QQQ: 3418 },
    portfolio_summary: { availableCash: 9000, positions: [] },
    market_data_summary: {
      assets: {
        SPY: { asset: 'SPY', instrumentId: 3417, bid: 650, ask: 650.2 },
        QQQ: { asset: 'QQQ', instrumentId: 3418, price: 590 }
      }
    },
    foundation_agents: {
      agentCouncil: {
        assets: {
          SPY: { status: 'APPROVED_BUY', recommendation: 'BUY', supportPct: 67, disagreementPct: 22 },
          QQQ: { status: 'HOLD', recommendation: 'HOLD' }
        }
      }
    },
    agent_council: {
      assets: {
        SPY: { status: 'APPROVED_BUY', recommendation: 'BUY', supportPct: 67, disagreementPct: 22 },
        QQQ: { status: 'HOLD', recommendation: 'HOLD' }
      }
    }
  };
}

function rateData(instrumentId, mid, date) {
  return {
    rates: [{ instrumentId, bid: mid - 0.05, ask: mid + 0.05, date }]
  };
}

test('governance is strictly shadow-only and cannot affect LIVE execution', () => {
  assert.equal(mod.GOVERNANCE.analysisOnly, true);
  assert.equal(mod.GOVERNANCE.shadowOnly, true);
  assert.equal(mod.GOVERNANCE.canPlaceOrder, false);
  assert.equal(mod.GOVERNANCE.canBlockOrder, false);
  assert.equal(mod.GOVERNANCE.canModifyOrder, false);
  assert.equal(mod.GOVERNANCE.canModifyDecision, false);
  assert.equal(mod.GOVERNANCE.canModifySizing, false);
  assert.equal(mod.GOVERNANCE.canModifyCouncilVote, false);
  assert.equal(mod.GOVERNANCE.canChangeRiskThresholds, false);
  assert.equal(mod.GOVERNANCE.canChangeSchedule, false);
  assert.equal(mod.GOVERNANCE.canPromoteLive, false);
  assert.equal(mod.GOVERNANCE.canPromoteAutomatically, false);
  assert.equal(mod.GOVERNANCE.providerCallsAdded, 0);
  assert.equal(mod.GOVERNANCE.originatesOrders, false);
});

test('approved BUY extraction only keeps council BUY approvals', () => {
  const assets = mod.approvedBuyAssetsFromCouncil(basePayload().agent_council);
  assert.deepEqual(assets, ['SPY']);
});

test('buildOpportunity records final HOLD without changing it and uses decision price', () => {
  mod._test.resetState();
  const payload = basePayload();
  const awareness = { approvedBuyAssets: ['SPY'], executableNow: ['SPY'], unavailableNow: [], mappedAssets: {} };
  const decision = { decision: 'HOLD', asset: 'NONE', confidence: 61, reason: 'Final coordinator prefers HOLD' };
  const o = mod.buildOpportunity(payload, decision, 'SPY', awareness, new Date('2026-09-17T10:00:05Z'));
  assert.equal(o.asset, 'SPY');
  assert.equal(o.analysisInstrumentId, 3417);
  assert.equal(o.entryMid, 650.1);
  assert.equal(o.finalDecision.action, 'HOLD');
  assert.equal(o.finalDecision.confidence, 61);
  assert.equal(o.cohort, 'EXECUTABLE_APPROVED_BUY_HELD');
  assert.equal(o.executableAtDecision, true);
});

test('venue unavailable candidate is separated from executable HOLD calibration', () => {
  const payload = basePayload();
  const awareness = { approvedBuyAssets: ['SPY'], executableNow: [], unavailableNow: ['SPY'], mappedAssets: {} };
  const decision = { decision: 'HOLD', confidence: 58, reason: 'Venue closed' };
  const o = mod.buildOpportunity(payload, decision, 'SPY', awareness, new Date('2026-09-17T10:00:05Z'));
  assert.equal(o.cohort, 'VENUE_UNAVAILABLE_APPROVED_BUY_HELD');
  assert.equal(o.executableAtDecision, false);
});

test('markouts are learned only from already supplied rate responses and preserve horizon quality', () => {
  mod._test.resetState();
  const opportunity = {
    id: 'x1', observedAt: '2026-09-17T10:00:05Z', decisionAt: '2026-09-17T10:00:00Z',
    source: 'auto-trade-cron', asset: 'SPY', analysisInstrumentId: 3417, entryMid: 100,
    cohort: 'EXECUTABLE_APPROVED_BUY_HELD', executableAtDecision: true,
    finalDecision: { action: 'HOLD', confidence: 60, reason: 'test' }, markouts: {}, governance: mod.GOVERNANCE
  };
  mod._test.setState({ ...mod._test.freshState(), opportunities: [opportunity] });
  const changed = mod.updateMarkoutsFromRates(
    rateData(3417, 102, '2026-09-17T11:05:00Z'),
    () => { throw new Error('must not call provider'); },
    new Date('2026-09-17T11:05:10Z')
  );
  assert.equal(changed, true);
  const saved = mod._test.getState().opportunities[0].markouts.h1;
  assert.equal(saved.nearHorizon, true);
  assert.equal(saved.grossReturnPct, 2);
  assert.equal(mod._test.getState().counters.markoutsRecorded, 1);
});

test('stale quotes do not create counterfactual markouts', () => {
  mod._test.resetState();
  const opportunity = {
    id: 'x2', decisionAt: '2026-09-17T10:00:00Z', asset: 'SPY', analysisInstrumentId: 3417,
    entryMid: 100, cohort: 'EXECUTABLE_APPROVED_BUY_HELD', markouts: {}, governance: mod.GOVERNANCE
  };
  mod._test.setState({ ...mod._test.freshState(), opportunities: [opportunity] });
  mod.updateMarkoutsFromRates(
    rateData(3417, 104, '2026-09-17T11:01:00Z'),
    () => null,
    new Date('2026-09-17T12:00:00Z')
  );
  assert.equal(mod._test.getState().opportunities[0].markouts.h1, undefined);
});

test('calibration interprets executable HOLDs only after minimum sample evidence', () => {
  mod._test.resetState();
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: `o${i}`, asset: 'SPY', cohort: 'EXECUTABLE_APPROVED_BUY_HELD',
    markouts: { h24: { grossReturnPct: 1 + i / 10, nearHorizon: true } }
  }));
  mod._test.setState({ ...mod._test.freshState(), opportunities: rows });
  const summary = mod.calibrationSummary();
  assert.equal(summary.ready, true);
  assert.equal(summary.executableApprovedBuyHeld.h24.samples, 10);
  assert.equal(summary.executableApprovedBuyHeld.interpretation24h, 'FINAL_HOLD_MEDIAN_MISSED_POSITIVE_RETURN');
  assert.equal(summary.methodology.noLiveInfluence, true);
});

test('BUY decisions are never turned into HOLD observations by the pure recorder', async () => {
  mod._test.resetState();
  const before = mod._test.getState().opportunities.length;
  const added = await mod.recordHoldOpportunities(basePayload(), { decision: 'BUY', asset: 'SPY', confidence: 80 }, async () => null);
  assert.deepEqual(added, []);
  assert.equal(mod._test.getState().opportunities.length, before);
});

test('fetch observer forwards request unchanged and adds no provider call', async () => {
  mod._test.resetState();
  const seen = [];
  const fakeFetch = async (input, init) => {
    seen.push({ input, init });
    return new Response(JSON.stringify(rateData(3417, 100, '2026-09-17T10:00:00Z')), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const agent = mod.installFetchObserver({ fetch: fakeFetch, installRoutes: false });
  const init = { method: 'GET', headers: { 'x-test': 'same' } };
  await agent.fetch('https://public-api.etoro.com/api/v1/market-data/instruments/rates?instrumentIds=3417', init);
  await mod._test.drainPendingTasks();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input, 'https://public-api.etoro.com/api/v1/market-data/instruments/rates?instrumentIds=3417');
  assert.equal(seen[0].init, init);
});


test('schema-native decision field is recognized by HOLD shadow', async () => {
  mod._test.resetState();
  const payload = basePayload();
  const added = await mod.recordHoldOpportunities(
    payload,
    { decision: 'HOLD', asset: 'NONE', confidence: 77, reason: 'schema-native HOLD' },
    async () => null,
    new Date('2026-09-17T10:00:05Z')
  );
  assert.equal(mod.decisionAction({ decision: 'HOLD' }), 'HOLD');
  assert.equal(added.length, 1);
  assert.equal(added[0].finalDecision.action, 'HOLD');
});
