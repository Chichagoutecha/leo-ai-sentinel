'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const leo = require('./index.js');

function snapshot({
  ids = [],
  details = null,
  units = null,
  invested = null,
  cash = 1000,
  closeOrderIds = []
} = {}) {
  const positionDetails = details || ids.map((id, index) => ({
    positionId: id,
    amount: invested === null ? 100 + index : invested / Math.max(ids.length, 1),
    units: units === null ? 1 + index : units / Math.max(ids.length, 1),
    profit: 0,
    estimatedValue: invested === null ? 100 + index : invested / Math.max(ids.length, 1)
  }));
  return {
    asset: 'BTC',
    instrumentId: 100109,
    positionLineCount: ids.length,
    positionIds: ids,
    positionDetails,
    investedAmount: invested,
    positionUnits: units,
    positionProfit: 0,
    openOrderCount: 0,
    openOrderIds: [],
    closeOrderCount: closeOrderIds.length,
    closeOrderIds,
    availableCash: cash
  };
}

test('SELL is confirmed when the exact targeted positionId disappears even if another BTC line remains', () => {
  const before = snapshot({
    ids: [3551537645, 4000000001],
    units: 0.012,
    invested: 800,
    cash: 7800
  });
  const after = snapshot({
    ids: [4000000001],
    units: 0.0045,
    invested: 300,
    cash: 8290
  });

  const proof = leo.buildSellCloseProof({
    beforeSnapshot: before,
    afterSnapshot: after,
    expectedPositionId: 3551537645
  });
  const evaluation = leo.evaluateExecutionEvidence({
    side: 'SELL',
    beforeSnapshot: before,
    afterSnapshot: after,
    expectedPositionId: 3551537645
  });

  assert.equal(proof.fullCloseProven, true);
  assert.equal(proof.targetWasPresent, true);
  assert.equal(proof.targetStillPresent, false);
  assert.equal(proof.targetRemoved, true);
  assert.equal(proof.proofType, 'EXACT_TARGET_POSITION_REMOVAL');
  assert.equal(proof.closeDescriptorIsProof, false);
  assert.equal(proof.cashDeltaIsProof, false);
  assert.ok(proof.evidence.includes('EXACT_POSITION_ID_CLOSE_PROOF'));

  assert.equal(evaluation.status, leo.EXECUTION_STATUS.CONFIRMED);
  assert.equal(evaluation.confirmed, true);
  assert.equal(evaluation.closeProof.fullCloseProven, true);
});

test('SELL is not confirmed if another position disappears but the targeted positionId remains', () => {
  const before = snapshot({
    ids: [3551537645, 4000000001],
    units: 0.012,
    invested: 800,
    cash: 7800
  });
  const after = snapshot({
    ids: [3551537645],
    units: 0.0072,
    invested: 500,
    cash: 8090
  });

  const evaluation = leo.evaluateExecutionEvidence({
    side: 'SELL',
    beforeSnapshot: before,
    afterSnapshot: after,
    expectedPositionId: 3551537645
  });

  assert.equal(evaluation.status, leo.EXECUTION_STATUS.NOT_FOUND);
  assert.equal(evaluation.confirmed, false);
  assert.equal(evaluation.closeProof.targetStillPresent, true);
  assert.ok(evaluation.evidence.includes('TARGET_POSITION_STILL_PRESENT'));
  assert.ok(evaluation.evidence.includes('EXACT_CLOSE_NOT_PROVEN'));
});

test('cash increase and lower units do not prove a full SELL while the target positionId remains', () => {
  const before = snapshot({
    ids: [3551537645],
    units: 0.007269,
    invested: 523.89,
    cash: 7880.53
  });
  const after = snapshot({
    ids: [3551537645],
    units: 0.003,
    invested: 220,
    cash: 8180.53
  });

  const proof = leo.buildSellCloseProof({
    beforeSnapshot: before,
    afterSnapshot: after,
    expectedPositionId: 3551537645
  });

  assert.equal(proof.fullCloseProven, false);
  assert.equal(proof.totalUnitsReduced, true);
  assert.equal(proof.totalInvestedReduced, true);
  assert.equal(proof.cashIncreaseSupports, true);
  assert.equal(proof.targetStillPresent, true);
  assert.equal(proof.cashDeltaIsProof, false);
});

test('ordersForClose descriptor changes are supplemental only and cannot confirm or accept a SELL', () => {
  const before = snapshot({
    ids: [3551537645],
    units: 0.007269,
    invested: 523.89,
    cash: 7880.53,
    closeOrderIds: ['descriptor-old']
  });
  const after = snapshot({
    ids: [3551537645],
    units: 0.007269,
    invested: 523.89,
    cash: 7880.53,
    closeOrderIds: ['descriptor-old', 'descriptor-new']
  });

  const evaluation = leo.evaluateExecutionEvidence({
    side: 'SELL',
    beforeSnapshot: before,
    afterSnapshot: after,
    expectedPositionId: 3551537645
  });

  assert.equal(evaluation.status, leo.EXECUTION_STATUS.NOT_FOUND);
  assert.equal(evaluation.confirmed, false);
  assert.equal(evaluation.closeProof.closeDescriptorChanged, true);
  assert.equal(evaluation.closeProof.closeDescriptorIsProof, false);
  assert.ok(evaluation.evidence.includes('CLOSE_DESCRIPTOR_CHANGED_NOT_EXECUTION_PROOF'));
});

test('SELL confirmation fails closed when the expected positionId is missing', () => {
  const before = snapshot({
    ids: [3551537645],
    units: 0.007269,
    invested: 523.89,
    cash: 7880.53
  });
  const after = snapshot({
    ids: [],
    units: 0,
    invested: 0,
    cash: 8390
  });

  const evaluation = leo.evaluateExecutionEvidence({
    side: 'SELL',
    beforeSnapshot: before,
    afterSnapshot: after
  });

  assert.equal(evaluation.status, leo.EXECUTION_STATUS.NOT_FOUND);
  assert.equal(evaluation.confirmed, false);
  assert.equal(evaluation.closeProof.requiresExactTargetPositionId, true);
  assert.ok(evaluation.evidence.includes('TARGET_POSITION_ID_REQUIRED'));
});

test('BUY evidence behavior remains unchanged', () => {
  const before = snapshot({ ids: [], units: 0, invested: 0, cash: 9000 });
  const after = snapshot({ ids: [999], units: 1, invested: 500, cash: 8500 });

  const evaluation = leo.evaluateExecutionEvidence({
    side: 'BUY',
    beforeSnapshot: before,
    afterSnapshot: after
  });

  assert.equal(evaluation.status, leo.EXECUTION_STATUS.CONFIRMED);
  assert.equal(evaluation.confirmed, true);
  assert.equal(evaluation.closeProof, null);
  assert.ok(evaluation.evidence.includes('NEW_POSITION_VISIBLE'));
});

test('execution verifier exposes the exact SELL proof contract without triggering an order', () => {
  const status = leo.executionVerifierStatus();

  assert.equal(status.sellCloseProof.version, 'v10.22.20.0-real-sell-proof');
  assert.equal(status.sellCloseProof.confirmationRule, 'EXACT_TARGET_POSITION_ID_MUST_DISAPPEAR');
  assert.equal(status.sellCloseProof.requiresExactTargetPositionId, true);
  assert.equal(status.sellCloseProof.closeDescriptorIsProof, false);
  assert.equal(status.sellCloseProof.cashDeltaIsProof, false);
  assert.equal(status.sellCloseProof.automaticRetryOnUncertain, false);
});
