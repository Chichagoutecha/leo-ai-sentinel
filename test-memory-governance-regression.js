'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fitPersistentStateToBudget,
  serializedByteLength,
  persistentSectionSizes,
  EXECUTION_STATUS
} = require('./index');

function makeRows(count, prefix, newestAtEnd = false) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, time: `2026-08-17T10:${String(i % 60).padStart(2, '0')}:00.000Z`, blob: `${prefix}-payload-`.repeat(35) }));
  return newestAtEnd ? rows : rows.reverse();
}

function largeState() {
  const orderIntents = {
    activeA: { id: 'activeA', status: EXECUTION_STATUS.SENT, asset: 'SPY', createdAt: '2026-08-17T10:50:00.000Z', requestId: 'req-active', criticalProof: 'must-survive' }
  };
  for (let i = 0; i < 120; i += 1) {
    orderIntents[`terminal-${i}`] = { id: `terminal-${i}`, status: EXECUTION_STATUS.CONFIRMED, asset: i % 2 ? 'SPY' : 'GLD', createdAt: `2026-08-16T${String(i % 24).padStart(2, '0')}:00:00.000Z`, detail: 'terminal-history-'.repeat(20) };
  }
  return {
    savedAt: '2026-08-17T10:50:00.000Z', version: 'test', persistenceMode: 'UPSTASH_COMPACT_V2_PROACTIVE',
    automationGuards: { lastAutoScanStartedAt: '2026-08-17T10:00:00.000Z', lastAutoScanCompletedAt: '2026-08-17T10:00:09.000Z' },
    cooldownMemory: { SPY: { until: '2026-08-18T10:00:00.000Z', reason: 'test' } },
    livePortfolioIdentity: { confirmed: true, contextKind: 'AGENT_PORTFOLIO', portfolioId: 'portfolio-test' },
    riskSellHighWaterByAsset: { SPY: { high: 999, updatedAt: '2026-08-17T10:00:00.000Z' } },
    executionMilestones: { confirmedBuys: 1, confirmedSells: 0, lastConfirmedAt: '2026-08-16T10:00:00.000Z' },
    strategyRegistry: { active: { id: 'strategy-active', status: 'ACTIVE' } },
    archiveCursor: 77,
    orderIntents,
    executionVerificationHistory: makeRows(180, 'verify'),
    pointInTimeArchive: makeRows(220, 'archive', true),
    agentCouncilHistory: makeRows(180, 'council'),
    researchEvents: makeRows(160, 'research'),
    researchEvidence: makeRows(140, 'evidence'),
    researchHypotheses: makeRows(100, 'hypothesis'),
    researchExperiments: makeRows(100, 'experiment'),
    macroCreditRegimeHistory: makeRows(160, 'macro', true),
    riskSellHistory: makeRows(120, 'risk'),
    performanceHistory: makeRows(260, 'performance', true),
    equityHistory: Array.from({ length: 600 }, (_, i) => ({ time: `2026-08-17T${String(Math.floor(i / 60) % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`, equity: 9000 + i, note: 'equity'.repeat(12) })),
    logs: makeRows(160, 'log'),
    auditTrail: makeRows(180, 'audit'),
    dataQualityHistory: makeRows(120, 'dq'),
    scientificBacktestRegistry: makeRows(100, 'backtest'),
    antiOverfittingEvents: makeRows(100, 'anti-event'),
    antiOverfittingReports: makeRows(80, 'anti-report'),
    antiOverfittingLeaderboard: makeRows(80, 'anti-leader'),
    strategyCandidates: makeRows(80, 'candidate'),
    improvementHistory: makeRows(80, 'improvement'),
    trendMemory: {
      SPY: Array.from({ length: 300 }, (_, i) => ({ time: `t-${i}`, price: 100 + i / 10 })),
      GLD: Array.from({ length: 300 }, (_, i) => ({ time: `g-${i}`, price: 200 + i / 10 }))
    },
    paperPortfolio: { snapshots: makeRows(180, 'paper-snapshot', true), orders: makeRows(160, 'paper-order'), closedTrades: makeRows(160, 'paper-closed') }
  };
}

function assertCriticalStateSurvives(result) {
  assert.equal(result.state.cooldownMemory.SPY.reason, 'test');
  assert.equal(result.state.livePortfolioIdentity.confirmed, true);
  assert.equal(result.state.riskSellHighWaterByAsset.SPY.high, 999);
  assert.equal(result.state.executionMilestones.confirmedBuys, 1);
  assert.equal(result.state.strategyRegistry.active.id, 'strategy-active');
  assert.equal(result.state.archiveCursor, 77);
  assert.equal(result.state.orderIntents.activeA.status, EXECUTION_STATUS.SENT);
  assert.equal(result.state.orderIntents.activeA.criticalProof, 'must-survive');
}

test('proactive compaction reaches a production-like target by reducing reconstructible history before critical state', () => {
  const state = largeState();
  const initial = serializedByteLength(state);
  assert.ok(initial > 700000, `fixture should exceed current Upstash scale, got ${initial}`);
  const result = fitPersistentStateToBudget(state, 600000, 900000);
  assert.equal(result.targetReached, true, `target not reached: ${result.finalBytes}`);
  assert.ok(result.finalBytes <= 600000);
  assert.ok(result.finalBytes < result.initialBytes);
  assertCriticalStateSurvives(result);
  assert.equal(result.reductions.includes('critical-fallback'), false);
  assert.ok(result.reductions.length > 0);
});

test('newest-at-end equity, macro and point-in-time data keep their recent tail after deeper compaction', () => {
  const state = largeState();
  const newestEquity = state.equityHistory.at(-1);
  const newestMacro = state.macroCreditRegimeHistory.at(-1);
  const newestArchive = state.pointInTimeArchive.at(-1);
  const result = fitPersistentStateToBudget(state, 450000, 900000);
  assert.equal(result.targetReached, true, `target not reached: ${result.finalBytes}`);
  assert.deepEqual(result.state.equityHistory.at(-1), newestEquity);
  assert.deepEqual(result.state.macroCreditRegimeHistory.at(-1), newestMacro);
  assert.deepEqual(result.state.pointInTimeArchive.at(-1), newestArchive);
});

test('newest-at-front logs, audit, risk history and execution verification keep their recent head', () => {
  const state = largeState();
  const newestLog = state.logs[0];
  const newestAudit = state.auditTrail[0];
  const newestRisk = state.riskSellHistory[0];
  const newestVerify = state.executionVerificationHistory[0];
  const result = fitPersistentStateToBudget(state, 450000, 900000);
  assert.equal(result.targetReached, true, `target not reached: ${result.finalBytes}`);
  assert.deepEqual(result.state.logs[0], newestLog);
  assert.deepEqual(result.state.auditTrail[0], newestAudit);
  assert.deepEqual(result.state.riskSellHistory[0], newestRisk);
  assert.deepEqual(result.state.executionVerificationHistory[0], newestVerify);
});

test('trend memory preserves the newest point for every tracked asset under deep compaction', () => {
  const state = largeState();
  const spyLast = state.trendMemory.SPY.at(-1);
  const gldLast = state.trendMemory.GLD.at(-1);
  const result = fitPersistentStateToBudget(state, 450000, 900000);
  assert.equal(result.targetReached, true, `target not reached: ${result.finalBytes}`);
  assert.deepEqual(result.state.trendMemory.SPY.at(-1), spyLast);
  assert.deepEqual(result.state.trendMemory.GLD.at(-1), gldLast);
  assert.ok(result.state.trendMemory.SPY.length >= 8);
  assert.ok(result.state.trendMemory.GLD.length >= 8);
});

test('an infeasible target is reported honestly without deleting critical state', () => {
  const state = largeState();
  const result = fitPersistentStateToBudget(state, 250000, 900000);
  assert.equal(result.targetReached, false);
  assert.ok(result.finalBytes > 250000);
  assert.ok(result.finalBytes < result.initialBytes);
  assertCriticalStateSurvives(result);
  assert.equal(result.reductions.includes('critical-fallback'), false);
});

test('persistent section size audit is deterministic and sorted largest-first', () => {
  const rows = persistentSectionSizes(largeState());
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length > 5);
  for (let i = 1; i < rows.length; i += 1) {
    const prev = Number(rows[i - 1].bytes ?? rows[i - 1][1] ?? 0);
    const next = Number(rows[i].bytes ?? rows[i][1] ?? 0);
    assert.ok(prev >= next, `section sizes not sorted at ${i}: ${prev} < ${next}`);
  }
});
