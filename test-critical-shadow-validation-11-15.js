'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { runCriticalValidation, returnsSet }=require('./critical-shadow-validation-11-15');
const { cappedNormalize, optimizePortfolio }=require('./shadow-portfolio-optimizer-v2');

test('critical stages 11-15 pass deterministic cross-scenario validation',()=>{
  const result=runCriticalValidation();
  assert.equal(result.status,'TECHNICALLY_VALIDATED_FOR_EMPIRICAL_SHADOW',JSON.stringify(result.failures));
  assert.deepEqual(result.failures,[]);
  assert.equal(result.safety.canTrade,false);
  assert.equal(result.safety.canAuthorizeLive,false);
  assert.equal(result.safety.livePromotionAllowed,false);
  assert.equal(result.safety.networkCalls,0);
  assert.equal(result.safety.openAiCalls,0);
  assert.equal(result.safety.executionCalls,0);
});

test('Stage 14 never violates a feasible max-weight constraint',()=>{
  const a=cappedNormalize({A:10,B:8,C:6,D:4,E:2},0.25);
  assert.equal(a.ok,true);
  const vals=Object.values(a.weights);
  assert.ok(Math.abs(vals.reduce((x,y)=>x+y,0)-1)<1e-8);
  assert.ok(vals.every(v=>v<=0.25000001));
});

test('Stage 14 fails closed instead of silently breaching an infeasible cap',()=>{
  const a=cappedNormalize({A:10,B:9},0.25);
  assert.equal(a.ok,false);
  assert.equal(a.reason,'CONSTRAINT_INFEASIBLE');
  assert.equal(a.requiredAssets,4);
  assert.equal(a.eligibleAssets,2);

  const r=returnsSet(false);
  const result=optimizePortfolio({returns:{SPY:r.SPY,QQQ:r.QQQ},expectedReturns:{SPY:.001,QQQ:.001},currentWeights:{SPY:.5,QQQ:.5}},{maxWeight:.25,minObservations:60,now:'2026-08-17T10:00:00.000Z'});
  assert.equal(result.status,'INCONCLUSIVE');
  assert.equal(result.reason,'CONSTRAINT_INFEASIBLE');
  assert.deepEqual(result.targetWeights,{});
  assert.equal(result.safety.canTrade,false);
});

test('FOMC window can block a new buy but never creates SELL authority',()=>{
  const result=runCriticalValidation();
  const event=result.scenarios.FOMC_WINDOW.eventRisk;
  assert.equal(event.blockNewBuy,true);
  assert.equal(event.sizeMultiplier,0);
  assert.equal(event.safety.canSell,false);
  assert.equal(event.safety.canTrade,false);
});

test('credit crunch and inflation shock are not classified as safer than goldilocks',()=>{
  const result=runCriticalValidation();
  const gold=result.scenarios.GOLDILOCKS.regime;
  const credit=result.scenarios.CREDIT_CRUNCH.regime;
  const inflation=result.scenarios.INFLATION_SHOCK.regime;
  assert.ok(credit.riskMultiplier<=gold.riskMultiplier);
  assert.ok(inflation.riskMultiplier<=gold.riskMultiplier);
  assert.ok(result.crisisRisk.score>=result.calmRisk.score);
  assert.ok(result.crisisRisk.shadowRiskMultiplier<=result.calmRisk.shadowRiskMultiplier);
});