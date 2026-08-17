'use strict';

/**
 * LEO-AI SENTINEL — deterministic property/fuzz validation for stages 11-15.
 * Shadow-only: zero network, zero OpenAI, zero trading.
 */
const { analyzeMacro } = require('./shadow-macro-intelligence-agent');
const { evaluateEventRisk } = require('./shadow-event-risk-calendar');
const { evaluateRegime, REGIMES } = require('./shadow-market-regime-engine-v2');
const { optimizePortfolio } = require('./shadow-portfolio-optimizer-v2');
const { assessInstitutionalRisk } = require('./shadow-institutional-risk-engine');

const VERSION = 'v10.25.5-critical-fuzz-11-15';
const NOW = '2026-08-17T12:00:00.000Z';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function between(rand,min,max){ return min + (max-min)*rand(); }
function obs(value,sourceGroup,maxAgeDays){ return {value,asOf:NOW,source:sourceGroup,sourceGroup,maxAgeDays}; }
function macroInput(rand){
  return {
    policyRate:obs(between(rand,0,8),'CENTRAL_BANK',120),
    inflationYoY:obs(between(rand,-1,9),'STATISTICS_A',45),
    coreInflationYoY:obs(between(rand,-1,8),'STATISTICS_A',45),
    unemployment:obs(between(rand,2.5,10),'STATISTICS_B',45),
    payrollTrend:obs(between(rand,-350,450),'STATISTICS_B',45),
    pmi:obs(between(rand,35,65),'SURVEY_A',45),
    yield2y:obs(between(rand,0,9),'MARKET_RATES',3),
    yield10y:obs(between(rand,0,9),'MARKET_RATES',3),
    dxyTrendPct:obs(between(rand,-12,12),'MARKET_FX',3),
    oilTrendPct:obs(between(rand,-45,55),'MARKET_COMMODITY',3),
    creditSpreadBps:obs(between(rand,50,650),'MARKET_CREDIT',3),
    vix:obs(between(rand,8,80),'MARKET_VOL',1)
  };
}
function marketInput(rand){
  return {
    breadthPct:between(rand,0,100),
    trendScore:between(rand,-100,100),
    realizedVolPct:between(rand,4,90),
    vix:between(rand,8,80),
    creditStressScore:between(rand,-100,100),
    rateShockScore:between(rand,-100,100),
    oilTrendPct:between(rand,-50,60),
    yield2yChangeBps:between(rand,-150,180),
    creditSpreadChangeBps:between(rand,-100,300)
  };
}
function makeEvent(rand,i){
  if(rand()<0.65) return [];
  const types=['FOMC','CPI','JOBS','EARNINGS','FDA','REGULATORY'];
  const type=types[Math.floor(rand()*types.length)];
  return [{id:`fuzz-${i}-${type}`,type,symbol:type==='EARNINGS'?'SPY':'MARKET',startAt:NOW,confidence:between(rand,.55,1),source:'FUZZ_PRIMARY',sourceGroup:'FUZZ_PRIMARY',sourceClass:'PRIMARY',title:`${type} validation fixture`}];
}
function makeSeries(rand,length,vol,drift){
  const out=[];
  for(let i=0;i<length;i++){
    const cyc=Math.sin((i+1)*.31)*vol*.55+Math.cos((i+3)*.11)*vol*.35;
    const noise=(rand()-.5)*vol*.9;
    const shock=rand()<.025?-between(rand,.015,.12):0;
    out.push(drift+cyc+noise+shock);
  }
  return out;
}
function finiteObject(obj){ return Object.values(obj||{}).every(Number.isFinite); }
function probabilitySum(p){ return Object.values(p||{}).reduce((a,b)=>a+Number(b||0),0); }
function safeShadow(result){ return result?.safety?.canTrade===false && result?.safety?.canAuthorizeLive===false; }

function runCriticalFuzz({seed=20260817,cases=300}={}){
  const rand=mulberry32(seed);
  const failures=[];
  const statuses={regime:{},optimizer:{},risk:{},events:{}};
  for(let i=0;i<cases;i++){
    const macro=analyzeMacro(macroInput(rand),{now:NOW});
    const event=evaluateEventRisk(makeEvent(rand,i),{now:NOW,symbol:'SPY'});
    const regime=evaluateRegime({macro,market:marketInput(rand),eventRisk:event},{now:NOW,previousRegime:REGIMES[Math.floor(rand()*REGIMES.length)],hysteresisMargin:between(rand,0,.3)});
    statuses.regime[regime.regime]=(statuses.regime[regime.regime]||0)+1;
    statuses.events[event.severity]=(statuses.events[event.severity]||0)+1;

    const ps=probabilitySum(regime.probabilities);
    if(!REGIMES.includes(regime.regime)) failures.push({i,stage:11,reason:'UNKNOWN_REGIME',value:regime.regime});
    if(Math.abs(ps-1)>.00035) failures.push({i,stage:11,reason:'PROBABILITY_SUM',value:ps});
    if(!finiteObject(regime.probabilities)||!finiteObject(regime.rawScores)) failures.push({i,stage:11,reason:'NON_FINITE_REGIME'});
    if(!(regime.riskMultiplier>=.5&&regime.riskMultiplier<=1.1)) failures.push({i,stage:11,reason:'RISK_MULTIPLIER_BOUNDS',value:regime.riskMultiplier});
    if(!safeShadow(macro)||!safeShadow(event)||!safeShadow(regime)) failures.push({i,stage:'11-13',reason:'LIVE_AUTHORITY_LEAK'});

    const symbols=['SPY','QQQ','GLD','TLT','XLV','XLE'];
    const returns={}; const expected={}; const current={}; const quality={};
    let weightSeed=0;
    for(const s of symbols){
      const historyLen=Math.floor(between(rand,55,150));
      const vol=between(rand,.003,.035),drift=between(rand,-.0015,.0018);
      returns[s]=makeSeries(rand,historyLen,vol,drift);
      expected[s]=between(rand,-.0015,.0025);
      current[s]=between(rand,0,.5); weightSeed+=current[s];
      quality[s]=between(rand,.4,1);
    }
    if(weightSeed>0) for(const s of symbols) current[s]/=weightSeed;
    const maxWeight=between(rand,.17,.35);
    const minObservations=Math.floor(between(rand,60,100));
    const optimizer=optimizePortfolio({returns,expectedReturns:expected,currentWeights:current,dataQuality:quality},{maxWeight,minObservations,now:NOW});
    statuses.optimizer[optimizer.status]=(statuses.optimizer[optimizer.status]||0)+1;
    if(!safeShadow(optimizer)) failures.push({i,stage:14,reason:'LIVE_AUTHORITY_LEAK'});
    if(optimizer.status==='READY_FOR_SHADOW_REVIEW'){
      const weights=Object.values(optimizer.targetWeights||{});
      const sum=weights.reduce((a,b)=>a+b,0);
      if(Math.abs(sum-1)>1e-8) failures.push({i,stage:14,reason:'WEIGHT_SUM',value:sum});
      if(weights.some(w=>!Number.isFinite(w)||w<0||w>optimizer.constraints.maxWeight+1e-8)) failures.push({i,stage:14,reason:'WEIGHT_CAP_OR_FINITE'});
      if(!Number.isFinite(optimizer.turnover)||optimizer.turnover<0||optimizer.turnover>1.0000001) failures.push({i,stage:14,reason:'TURNOVER_BOUNDS',value:optimizer.turnover});
      if(!Number.isFinite(optimizer.concentrationHhi)||optimizer.concentrationHhi<=0||optimizer.concentrationHhi>1.0000001) failures.push({i,stage:14,reason:'HHI_BOUNDS',value:optimizer.concentrationHhi});
    } else if(optimizer.status!=='INCONCLUSIVE') failures.push({i,stage:14,reason:'UNKNOWN_OPTIMIZER_STATUS',value:optimizer.status});

    const riskWeights=optimizer.status==='READY_FOR_SHADOW_REVIEW'?optimizer.targetWeights:current;
    const stressScenarios={
      EQUITY_CRASH:{SPY:-.2,QQQ:-.28,GLD:.04,TLT:.03,XLV:-.13,XLE:-.18},
      RATE_SPIKE:{SPY:-.08,QQQ:-.12,GLD:-.04,TLT:-.14,XLV:-.05,XLE:.02},
      CREDIT_EVENT:{SPY:-.14,QQQ:-.18,GLD:.03,TLT:.04,XLV:-.10,XLE:-.12}
    };
    const risk=assessInstitutionalRisk({weights:riskWeights,returns,stressScenarios},{minObservations,now:NOW});
    statuses.risk[risk.status]=(statuses.risk[risk.status]||0)+1;
    if(!safeShadow(risk)) failures.push({i,stage:15,reason:'LIVE_AUTHORITY_LEAK'});
    if(risk.status!=='INCONCLUSIVE'){
      const allowed=['NORMAL','WATCH','DEFENSIVE','CRITICAL'];
      if(!allowed.includes(risk.status)) failures.push({i,stage:15,reason:'UNKNOWN_RISK_STATUS',value:risk.status});
      if(!finiteObject(risk.metrics)||!finiteObject(risk.riskContributions)||!finiteObject(risk.stressResults)) failures.push({i,stage:15,reason:'NON_FINITE_RISK'});
      if(!(risk.shadowRiskMultiplier>=.45&&risk.shadowRiskMultiplier<=1)) failures.push({i,stage:15,reason:'RISK_MULTIPLIER_BOUNDS',value:risk.shadowRiskMultiplier});
      const rcSum=Object.values(risk.riskContributions||{}).reduce((a,b)=>a+b,0);
      if(Object.keys(risk.riskContributions||{}).length&&Math.abs(rcSum-1)>.000001) failures.push({i,stage:15,reason:'RISK_CONTRIBUTION_SUM',value:rcSum});
      if(risk.worstStressReturn>1e-12) failures.push({i,stage:15,reason:'WORST_STRESS_POSITIVE',value:risk.worstStressReturn});
    }
  }
  const result={version:VERSION,at:NOW,seed,cases,status:failures.length?'FAILED':'PROPERTY_VALIDATED',failureCount:failures.length,failures:failures.slice(0,50),statuses,safety:{shadowOnly:true,networkCalls:0,openAiCalls:0,executionCalls:0,canTrade:false,canAuthorizeLive:false,livePromotionAllowed:false}};
  return result;
}

global.__LEO_CRITICAL_11_15_FUZZ__=runCriticalFuzz;
module.exports={VERSION,mulberry32,runCriticalFuzz};