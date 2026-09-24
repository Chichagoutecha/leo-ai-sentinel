'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const leo = require('./index.js');

function portfolioSummary(overrides = {}) {
  const base = {
    totalTrackedValue: 10000,
    availableCash: 8000,
    uniquePositionsCount: 4,
    uniqueOpenAssets: ['SPY', 'QQQ', 'GLD', 'BTC'],
    starterMode: true,
    assetValues: { SPY: 500, QQQ: 500, GLD: 500, BTC: 500 },
    categoryValues: {
      ETF_CORE: 500,
      ETF_GROWTH: 500,
      GOLD: 500,
      CRYPTO_MAJOR: 500
    },
    assetWeightsPct: { SPY: 5, QQQ: 5, GLD: 5, BTC: 5 },
    cryptoValue: 500,
    speculativeValue: 0
  };
  return { ...base, ...overrides };
}

test('ETH may use exactly one minimum executable lot when target gap is smaller but hard caps are safe', () => {
  const summary = portfolioSummary();
  const policy = leo.getProgressiveOrderPolicy(summary);
  const capacity = leo.buildLotAwareBuyCapacity('ETH', summary, policy.maximumOrderUsd);

  assert.equal(capacity.status, 'MINIMUM_LOT_ALLOWED');
  assert.equal(capacity.executable, true);
  assert.equal(capacity.minimumLotAllowed, true);
  assert.equal(capacity.allowedAmountUsd, policy.minimumExecutableVirtualOrderUsd);
  assert.ok(capacity.targetGapUsd < policy.minimumExecutableVirtualOrderUsd);
  assert.ok(capacity.hardRoomUsd >= policy.minimumExecutableVirtualOrderUsd);
  assert.ok(capacity.targetOvershootPct <= capacity.maxTargetOvershootPct);
  assert.equal(capacity.canExceedHardCaps, false);
  assert.equal(capacity.oneMinimumLotOnly, true);
});

test('SOL remains risk-limited when one minimum lot would exceed the starter single-speculative hard cap', () => {
  const summary = portfolioSummary();
  const policy = leo.getProgressiveOrderPolicy(summary);
  const capacity = leo.buildLotAwareBuyCapacity('SOL', summary, policy.maximumOrderUsd);

  assert.equal(capacity.status, 'RISK_LIMITED');
  assert.equal(capacity.executable, false);
  assert.equal(capacity.minimumLotAllowed, false);
  assert.ok(capacity.hardRoomUsd < policy.minimumExecutableVirtualOrderUsd);
  assert.ok(capacity.hardBlockers.some((reason) => reason.includes('plafond spéculatif individuel')));
  assert.equal(capacity.canExceedHardCaps, false);
});

test('SHY remains executable normally when its target gap already fits the minimum lot', () => {
  const summary = portfolioSummary();
  const policy = leo.getProgressiveOrderPolicy(summary);
  const capacity = leo.buildLotAwareBuyCapacity('SHY', summary, policy.maximumOrderUsd);

  assert.equal(capacity.status, 'EXECUTABLE_WITHIN_TARGET');
  assert.equal(capacity.executable, true);
  assert.equal(capacity.minimumLotAllowed, false);
  assert.ok(capacity.targetRoomUsd >= policy.minimumExecutableVirtualOrderUsd);
});

test('allocation guard and dynamic sizing use the lot-aware ETH capacity without exceeding one lot', () => {
  const summary = portfolioSummary();
  const policy = leo.getProgressiveOrderPolicy(summary);
  const guard = leo.allocationCheckForBuy('ETH', summary, policy.maximumOrderUsd);
  const dynamic = leo.dynamicBuyAmount(
    { asset: 'ETH', amount_usd: policy.maximumOrderUsd },
    summary
  );

  assert.equal(guard.ok, true);
  assert.equal(guard.status, 'MINIMUM_LOT_ALLOWED');
  assert.equal(guard.roomUsd, policy.minimumExecutableVirtualOrderUsd);
  assert.equal(dynamic, policy.minimumExecutableVirtualOrderUsd);
  assert.equal(guard.lotAware.canExceedHardCaps, false);
});

test('cash reserve remains a hard veto even when the target would otherwise qualify for a minimum lot', () => {
  const summary = portfolioSummary({ availableCash: 1200 });
  const policy = leo.getProgressiveOrderPolicy(summary);
  const capacity = leo.buildLotAwareBuyCapacity('ETH', summary, policy.maximumOrderUsd);

  assert.equal(capacity.status, 'RISK_LIMITED');
  assert.equal(capacity.executable, false);
  assert.ok(capacity.cashRoomUsd < policy.minimumExecutableVirtualOrderUsd);
  assert.ok(capacity.hardBlockers.includes('réserve de cash minimale'));
});

test('RiskBudgetAgent advertises lot-aware sizing as unable to override hard caps or hard vetoes', () => {
  const state = leo.buildRiskBudgetState(portfolioSummary());
  assert.equal(state.lotAwareExecutionSizing.enabled, true);
  assert.equal(state.lotAwareExecutionSizing.oneMinimumLotOnly, true);
  assert.equal(state.lotAwareExecutionSizing.canExceedAllocationTarget, true);
  assert.equal(state.lotAwareExecutionSizing.canExceedHardCaps, false);
  assert.equal(state.lotAwareExecutionSizing.canOverrideHardVeto, false);
});
