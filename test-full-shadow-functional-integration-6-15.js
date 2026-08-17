'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

const {discoverOpportunities}=require('./shadow-opportunity-discovery-v2');
const {manageUniverse}=require('./shadow-dynamic-universe-manager');
const {evaluateProfitability}=require('./shadow-profitability-cost-guard');
const {routeAI}=require('./shadow-adaptive-ai-router');
const {runAIValueExperiment}=require('./shadow-ai-value-experiment');
const {evaluateRegime}=require('./shadow-market-regime-engine-v2');
const {analyzeMacro}=require('./shadow-macro-intelligence-agent');
const {evaluateEventRisk}=require('./shadow-event-risk-calendar');
const {optimizePortfolio}=require('./shadow-portfolio-optimizer-v2');
const {assessInstitutionalRisk}=require('./shadow-institutional-risk-engine');
const {returnsSet}=require('./critical-shadow-validation-11-15');

const NOW='2026-08-17T10:00:00.000Z';
function obs(value,sourceGroup,maxAgeDays){return{value,asOf:NOW,source:sourceGroup,sourceGroup,maxAgeDays};}
function macroInput(){return{
  policyRate:obs(4,'CENTRAL_BANK',120),inflationYoY:obs(2.4,'STAT_A',45),coreInflationYoY:obs(2.5,'STAT_A',45),
  unemployment:obs(4,'STAT_B',45),payrollTrend:obs(150,'STAT_B',45),pmi:obs(53,'SURVEY',45),yield2y:obs(4,'RATES',3),yield10y:obs(4.3,'RATES',3),
  dxyTrendPct:obs(-1,'FX',3),oilTrendPct:obs(0,'OIL',3),creditSpreadBps:obs(105,'CREDIT',3),vix:obs(14,'VOL',1)
};}
function aiRows(n=10){const out=[];for(let i=0;i<n;i++)for(const arm of ['QUANT_ONLY','QUANT_AI','COUNCIL'])out.push({opportunityId:`O${i}`,arm,signedReturnPct:arm==='QUANT_ONLY'?.2:arm==='QUANT_AI'?.24:.27,aiCostUsd:arm==='QUANT_ONLY'?0:.001,notionalUsd:100});return out;}
function safe(result){return result?.safety?.canTrade===false&&result?.safety?.canAuthorizeLive===false;}

test('full roadmap 6-15 functional Shadow pipeline composes without LIVE authority',()=>{
  const universe=['SPY','QQQ','GLD','TLT','XLV','XLE'].map((symbol,i)=>({symbol,dataQuality:.95,liquidityScore:90-i,spreadBps:5+i,ageSeconds:20,momentumScore:70-i*3,trendScore:65-i*2}));
  const discovery=discoverOpportunities(universe,{shortlistSize:10,finalistSize:6,minimumFinalistScore:50,now:NOW});
  assert.equal(discovery.finalists.length,6);
  assert.ok(discovery.finalists.every(x=>Number.isFinite(x.discoveryScore)&&Number.isFinite(x.ageSeconds)));

  const candidates=discovery.finalists.map(x=>({...x,persistenceRuns:3}));
  const dynamic=manageUniverse([],candidates,{minPersistenceRuns:3,maxUniverse:20,now:NOW});
  assert.equal(dynamic.status,'READY_FOR_SHADOW_REVIEW');
  assert.equal(dynamic.universe.length,6);

  const profitability=evaluateProfitability(Array.from({length:12},(_,i)=>({decisionId:`D${i}`,source:i%2?'QUANT':'EXA',route:i%3?'QUANT_ONLY':'LUNA',grossPnlUsd:.5,spreadCostUsd:.01,slippageCostUsd:.01,aiCostUsd:i%3?0:.001})),{monthlyBudgetUsd:1,now:NOW});
  assert.notEqual(profitability.status,'UNPROFITABLE_SAMPLE');

  const router=routeAI({ambiguityScore:70,stakesScore:70,dataQuality:.95,councilConflictScore:50,aiBudgetRemainingUsd:.5,aiCallsRemainingToday:10},{now:NOW,maxAllowedCallCostUsd:.02});
  assert.equal(router.route,'LUNA');

  const experiment=runAIValueExperiment(aiRows(10),{minMatchedOpportunities:10,now:NOW});
  assert.equal(experiment.sampleReady,true);
  assert.equal(experiment.matchedOpportunities,10);

  const macro=analyzeMacro(macroInput(),{now:NOW});
  assert.notEqual(macro.status,'INCONCLUSIVE');
  const eventRisk=evaluateEventRisk([],{now:NOW,symbol:'SPY'});
  const regime=evaluateRegime({macro,market:{breadthPct:65,trendScore:55,realizedVolPct:15,vix:14,creditStressScore:-10,rateShockScore:-10},eventRisk},{now:NOW,previousRegime:'NEUTRAL',hysteresisMargin:0});
  assert.ok(regime.confidence>0);

  const returns=returnsSet(false);const weights={SPY:.2,QQQ:.2,GLD:.15,TLT:.15,XLV:.15,XLE:.15};
  const optimizer=optimizePortfolio({returns,expectedReturns:{SPY:.00035,QQQ:.00045,GLD:.0002,TLT:.00015,XLV:.0003,XLE:.00025},currentWeights:weights,dataQuality:{SPY:1,QQQ:1,GLD:1,TLT:1,XLV:1,XLE:1}},{maxWeight:.25,minObservations:60,now:NOW});
  assert.equal(optimizer.status,'READY_FOR_SHADOW_REVIEW');

  const stress={CRASH:{SPY:-.2,QQQ:-.28,GLD:.04,TLT:.03,XLV:-.13,XLE:-.18},RATE:{SPY:-.08,QQQ:-.12,GLD:-.04,TLT:-.14,XLV:-.05,XLE:.02}};
  const risk=assessInstitutionalRisk({weights,returns,stressScenarios:stress},{minObservations:60,now:NOW});
  assert.ok(['NORMAL','WATCH','DEFENSIVE','CRITICAL'].includes(risk.status));

  for(const result of [discovery,dynamic,profitability,router,experiment,macro,eventRisk,regime,optimizer,risk])assert.ok(safe(result),`${result?.version} safety`);
});

test('full roadmap stages remain exception-safe under deliberately corrupted handoffs',()=>{
  let discovery,dynamic,profitability,router,experiment,macro,eventRisk,regime,optimizer,risk;
  assert.doesNotThrow(()=>{discovery=discoverOpportunities([null,{symbol:'SPY',dataQuality:'bad'}],{now:'bad'});});
  assert.doesNotThrow(()=>{dynamic=manageUniverse(null,discovery?.finalists,{now:'bad'});});
  assert.doesNotThrow(()=>{profitability=evaluateProfitability([null,{grossPnlUsd:'bad',aiCostUsd:-1}],{now:'bad'});});
  assert.doesNotThrow(()=>{router=routeAI({ambiguityScore:'bad',stakesScore:Infinity,dataQuality:null,aiBudgetRemainingUsd:1,aiCallsRemainingToday:5},{now:'bad'});});
  assert.doesNotThrow(()=>{experiment=runAIValueExperiment([{opportunityId:'X',arm:'COUNCIL',signedReturnPct:'bad'}],{now:'bad'});});
  assert.doesNotThrow(()=>{macro=analyzeMacro(null,{now:'bad'});});
  assert.doesNotThrow(()=>{eventRisk=evaluateEventRisk({bad:true},{now:'bad'});});
  assert.doesNotThrow(()=>{regime=evaluateRegime({macro:null,market:null,eventRisk:null},{now:'bad'});});
  assert.doesNotThrow(()=>{optimizer=optimizePortfolio({returns:{SPY:'bad'},currentWeights:{SPY:1}},{now:'bad'});});
  assert.doesNotThrow(()=>{risk=assessInstitutionalRisk({weights:{SPY:1},returns:{SPY:'bad'},stressScenarios:null},{now:'bad'});});
  for(const result of [discovery,dynamic,profitability,router,experiment,macro,eventRisk,regime,optimizer,risk]){
    assert.notEqual(result?.safety?.canTrade,true);
    assert.notEqual(result?.safety?.canAuthorizeLive,true);
  }
});
