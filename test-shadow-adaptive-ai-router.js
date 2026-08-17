'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {routeAI}=require('./shadow-adaptive-ai-router.js');

test('uses quant-only for simple low-stakes decisions',()=>{
  const r=routeAI({ambiguityScore:10,stakesScore:20,dataQuality:.95,councilConflictScore:5,aiBudgetRemainingUsd:.5,aiCallsRemainingToday:10});
  assert.equal(r.route,'QUANT_ONLY');assert.equal(r.estimatedMaxCostUsd,0);assert.equal(r.safety.performsModelCall,false);
});

test('routes justified ambiguous case to Luna',()=>{
  const r=routeAI({ambiguityScore:70,stakesScore:70,dataQuality:.95,councilConflictScore:50,aiBudgetRemainingUsd:.5,aiCallsRemainingToday:10});
  assert.equal(r.route,'LUNA');assert.equal(r.model,'gpt-5.6-luna');assert.ok(r.maxTokens<=1200);
});

test('fails closed to quant-only when AI budget is exhausted',()=>{
  const r=routeAI({ambiguityScore:90,stakesScore:90,dataQuality:.95,councilConflictScore:90,aiBudgetRemainingUsd:0,aiCallsRemainingToday:10},{premiumModel:'premium-x'});
  assert.equal(r.route,'QUANT_ONLY');
});

test('blocks routing when data quality is too low',()=>{
  const r=routeAI({ambiguityScore:90,stakesScore:90,dataQuality:.4,councilConflictScore:90,aiBudgetRemainingUsd:1,aiCallsRemainingToday:10});
  assert.equal(r.route,'BLOCK');assert.equal(r.safety.canAuthorizeLive,false);
});
