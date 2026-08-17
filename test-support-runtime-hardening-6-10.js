'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

const {discoverOpportunities}=require('./shadow-opportunity-discovery-v2');
const {manageUniverse}=require('./shadow-dynamic-universe-manager');
const {evaluateProfitability}=require('./shadow-profitability-cost-guard');
const {routeAI}=require('./shadow-adaptive-ai-router');
const {runAIValueExperiment}=require('./shadow-ai-value-experiment');

function seeded(seed){let x=seed>>>0;return()=>{x=(1664525*x+1013904223)>>>0;return x/4294967296;};}

test('Stages 6-10 never throw on malformed top-level inputs',()=>{
  assert.doesNotThrow(()=>discoverOpportunities(null,null));
  assert.doesNotThrow(()=>manageUniverse(null,null,null));
  assert.doesNotThrow(()=>evaluateProfitability(null,null));
  assert.doesNotThrow(()=>routeAI(null,null));
  assert.doesNotThrow(()=>runAIValueExperiment(null,null));
});

test('invalid timestamps and numeric options fall back safely',()=>{
  const d=discoverOpportunities([], {now:'bad',shortlistSize:'bad',finalistSize:'bad'});
  const u=manageUniverse([],[],{now:'bad',maxUniverse:'bad',minPersistenceRuns:'bad'});
  const p=evaluateProfitability([],{now:'bad',monthlyBudgetUsd:'bad'});
  const r=routeAI({dataQuality:.9,aiBudgetRemainingUsd:1,aiCallsRemainingToday:2},{now:'bad',maxAllowedCallCostUsd:'bad'});
  const e=runAIValueExperiment([],{now:'bad',minMatchedOpportunities:'bad'});
  for(const x of [d,u,p,r,e]) assert.ok(Number.isFinite(Date.parse(x.at)));
  assert.equal(d.policy.shortlistSize,25);
  assert.equal(d.policy.finalistSize,8);
  assert.equal(u.policy.maxUniverse,120);
  assert.equal(u.policy.minPersistenceRuns,3);
  assert.equal(e.minMatchedOpportunities,30);
});

test('Stage 6 collapses exact duplicates and rejects conflicting duplicate eligibility',()=>{
  const good={symbol:'SPY',dataQuality:.95,liquidityScore:95,spreadBps:5,ageSeconds:10,momentumScore:70,trendScore:70};
  const bad={symbol:'SPY',dataQuality:.2,liquidityScore:95,spreadBps:5,ageSeconds:10,momentumScore:99,trendScore:99};
  const conflict=discoverOpportunities([good,bad]);
  assert.equal(conflict.universeSize,1);
  assert.equal(conflict.duplicateConflicts,1);
  assert.equal(conflict.eligibleCount,0);
  const exact=discoverOpportunities([good,{...good}]);
  assert.equal(exact.universeSize,1);
  assert.equal(exact.duplicatesRemoved,1);
  assert.equal(exact.eligibleCount,1);
});

test('Stage 7 duplicate candidates use conservative eligibility and protected overflow is explicit',()=>{
  const r=manageUniverse([], [
    {symbol:'NVDA',dataQuality:.95,liquidityScore:95,spreadBps:5,ageSeconds:10,discoveryScore:90,persistenceRuns:5},
    {symbol:'NVDA',dataQuality:.3,liquidityScore:95,spreadBps:5,ageSeconds:10,discoveryScore:99,persistenceRuns:5}
  ], {minPersistenceRuns:3});
  assert.ok(!r.universe.some(x=>x.symbol==='NVDA'));
  assert.equal(r.duplicatesCollapsed,1);

  const current=Array.from({length:11},(_,i)=>({symbol:`CORE${i}`,addedBy:'CORE'}));
  const overflow=manageUniverse(current,[],{maxUniverse:10});
  assert.equal(overflow.status,'UNIVERSE_CAP_UNRESOLVED');
  assert.equal(overflow.unresolvedOverflow,1);
  assert.equal(overflow.safety.canModifyLiveUniverse,false);
});

test('Stage 8 clamps negative costs and excludes exact duplicate accounting rows',()=>{
  const row={decisionId:'D1',source:'EXA',route:'LUNA',grossPnlUsd:2,spreadCostUsd:-5,slippageCostUsd:-1,feesUsd:-2,aiCostUsd:-.1,dataCostUsd:-.2,infrastructureCostUsd:-.3};
  const r=evaluateProfitability([row,{...row}],{monthlyBudgetUsd:1});
  assert.equal(r.recordsReceived,2);
  assert.equal(r.recordsUsed,1);
  assert.equal(r.duplicatesExcluded,1);
  assert.equal(r.overall.totalCostsUsd,0);
  assert.equal(r.overall.netPnlUsd,2);
  assert.equal(r.safety.canTrade,false);
});

test('Stage 9 fails closed when data quality is missing and treats zero call-cost limit as no AI spend',()=>{
  const missingQuality=routeAI({ambiguityScore:90,stakesScore:90,councilConflictScore:90,aiBudgetRemainingUsd:1,aiCallsRemainingToday:10});
  assert.equal(missingQuality.route,'BLOCK');
  const zeroCost=routeAI({ambiguityScore:90,stakesScore:70,councilConflictScore:60,dataQuality:.95,aiBudgetRemainingUsd:1,aiCallsRemainingToday:10},{maxAllowedCallCostUsd:0});
  assert.equal(zeroCost.route,'QUANT_ONLY');
  assert.equal(zeroCost.reason,'AI_CALL_COST_LIMIT_ZERO');
  assert.equal(zeroCost.estimatedMaxCostUsd,0);
});

test('Stage 10 invalid metrics are excluded and duplicate arm records disqualify the opportunity',()=>{
  const base=[
    {opportunityId:'O1',arm:'QUANT_ONLY',signedReturnPct:.2,notionalUsd:100,aiCostUsd:0},
    {opportunityId:'O1',arm:'QUANT_AI',signedReturnPct:.3,notionalUsd:100,aiCostUsd:.001},
    {opportunityId:'O1',arm:'COUNCIL',signedReturnPct:.35,notionalUsd:100,aiCostUsd:.001},
    {opportunityId:'O1',arm:'COUNCIL',signedReturnPct:.4,notionalUsd:100,aiCostUsd:.001},
    {opportunityId:'BAD',arm:'QUANT_ONLY',signedReturnPct:'not-a-number',notionalUsd:100}
  ];
  const r=runAIValueExperiment(base,{minMatchedOpportunities:10});
  assert.equal(r.matchedOpportunities,0);
  assert.equal(r.duplicateArmRecords,1);
  assert.equal(r.duplicateOpportunityCount,1);
  assert.equal(r.invalidRecords,1);
  assert.equal(r.sampleReady,false);
  assert.equal(r.protocol.livePromotionAllowed,false);
});

test('deterministic malformed-input sweep never throws and never grants LIVE authority',()=>{
  const rnd=seeded(6102026);
  const junk=[null,undefined,'bad',42,[],{},NaN,Infinity,{now:'bad'}];
  for(let i=0;i<100;i++){
    const pick=()=>junk[Math.floor(rnd()*junk.length)];
    const calls=[
      ()=>discoverOpportunities(pick(),pick()),
      ()=>manageUniverse(pick(),pick(),pick()),
      ()=>evaluateProfitability(pick(),pick()),
      ()=>routeAI(pick(),pick()),
      ()=>runAIValueExperiment(pick(),pick())
    ];
    for(const call of calls){let result;assert.doesNotThrow(()=>{result=call();});assert.notEqual(result?.safety?.canTrade,true);assert.notEqual(result?.safety?.canAuthorizeLive,true);}
  }
});
