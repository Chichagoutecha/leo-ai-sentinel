'use strict';

/**
 * Critical Shadow Validation Harness for roadmap stages 11-15.
 * Deterministic, zero-network, zero-OpenAI, zero-trading scenario rehearsal.
 */
const { analyzeMacro } = require('./shadow-macro-intelligence-agent');
const { evaluateEventRisk } = require('./shadow-event-risk-calendar');
const { evaluateRegime } = require('./shadow-market-regime-engine-v2');
const { optimizePortfolio } = require('./shadow-portfolio-optimizer-v2');
const { assessInstitutionalRisk } = require('./shadow-institutional-risk-engine');

const VERSION='v10.25.1-critical-shadow-validation-11-15';
const NOW='2026-08-17T10:00:00.000Z';

function obs(value,sourceGroup,maxAgeDays){return{value,asOf:NOW,source:sourceGroup,sourceGroup,maxAgeDays};}
function macroInput(values={}){
  return {
    policyRate:obs(values.policyRate??4.0,'CENTRAL_BANK',120),
    inflationYoY:obs(values.inflationYoY??2.4,'STATISTICS_A',45),
    coreInflationYoY:obs(values.coreInflationYoY??2.5,'STATISTICS_A',45),
    unemployment:obs(values.unemployment??4.0,'STATISTICS_B',45),
    payrollTrend:obs(values.payrollTrend??140,'STATISTICS_B',45),
    pmi:obs(values.pmi??53,'SURVEY_A',45),
    yield2y:obs(values.yield2y??4.0,'MARKET_RATES',3),
    yield10y:obs(values.yield10y??4.3,'MARKET_RATES',3),
    dxyTrendPct:obs(values.dxyTrendPct??-1,'MARKET_FX',3),
    oilTrendPct:obs(values.oilTrendPct??0,'MARKET_COMMODITY',3),
    creditSpreadBps:obs(values.creditSpreadBps??105,'MARKET_CREDIT',3),
    vix:obs(values.vix??14,'MARKET_VOL',1)
  };
}

function deterministicSeries({length=120,drift=0.0003,vol=0.008,phase=0,shockEvery=0,shock=-0.04}={}){
  const out=[];
  for(let i=0;i<length;i++){
    const cyc=Math.sin((i+phase)*0.41)*vol*0.75+Math.cos((i+phase)*0.17)*vol*0.35;
    const periodic=shockEvery>0&&i>0&&i%shockEvery===0?shock:0;
    out.push(drift+cyc+periodic);
  }
  return out;
}
function returnsSet(crisis=false){
  const factor=crisis?2.2:1;
  return {
    SPY:deterministicSeries({vol:.007*factor,drift:crisis?-.0004:.00035,phase:1,shockEvery:crisis?21:0,shock:-.05}),
    QQQ:deterministicSeries({vol:.010*factor,drift:crisis?-.0007:.00045,phase:3,shockEvery:crisis?19:0,shock:-.065}),
    GLD:deterministicSeries({vol:.006*(crisis?1.2:1),drift:.0002,phase:7,shockEvery:0}),
    TLT:deterministicSeries({vol:.007*(crisis?1.5:1),drift:crisis?-.0001:.00015,phase:11,shockEvery:crisis?29:0,shock:-.03}),
    XLV:deterministicSeries({vol:.0065*factor,drift:crisis?-.0002:.0003,phase:5,shockEvery:crisis?23:0,shock:-.035}),
    XLE:deterministicSeries({vol:.011*factor,drift:crisis?-.0005:.00025,phase:9,shockEvery:crisis?17:0,shock:-.055})
  };
}

const SCENARIOS=Object.freeze({
  GOLDILOCKS:{
    macro:{pmi:54,unemployment:3.8,payrollTrend:180,inflationYoY:2.2,coreInflationYoY:2.3,policyRate:3.8,yield2y:3.7,yield10y:4.1,creditSpreadBps:90,vix:13,dxyTrendPct:-1.5,oilTrendPct:-1},
    market:{breadthPct:72,trendScore:65,realizedVolPct:13,vix:13,creditStressScore:-20,rateShockScore:-10,oilTrendPct:-1,yield2yChangeBps:-5,creditSpreadChangeBps:-8},events:[]
  },
  INFLATION_SHOCK:{
    macro:{pmi:52,unemployment:4.1,payrollTrend:100,inflationYoY:5.2,coreInflationYoY:4.8,policyRate:4.5,yield2y:5.1,yield10y:4.7,creditSpreadBps:165,vix:25,dxyTrendPct:2.5,oilTrendPct:18},
    market:{breadthPct:42,trendScore:-20,realizedVolPct:26,vix:27,creditStressScore:25,rateShockScore:85,oilTrendPct:18,yield2yChangeBps:48,creditSpreadChangeBps:20},events:[]
  },
  CREDIT_CRUNCH:{
    macro:{pmi:43,unemployment:5.4,payrollTrend:-120,inflationYoY:2.1,coreInflationYoY:2.4,policyRate:4.2,yield2y:3.4,yield10y:3.0,creditSpreadBps:330,vix:43,dxyTrendPct:4,oilTrendPct:-12},
    market:{breadthPct:18,trendScore:-78,realizedVolPct:42,vix:45,creditStressScore:95,rateShockScore:25,oilTrendPct:-12,yield2yChangeBps:-20,creditSpreadChangeBps:110},events:[]
  },
  FOMC_WINDOW:{
    macro:{pmi:51,unemployment:4.2,payrollTrend:90,inflationYoY:3.0,coreInflationYoY:3.2,policyRate:4.4,yield2y:4.3,yield10y:4.2,creditSpreadBps:130,vix:19,dxyTrendPct:.5,oilTrendPct:2},
    market:{breadthPct:51,trendScore:5,realizedVolPct:19,vix:20,creditStressScore:5,rateShockScore:15,oilTrendPct:2,yield2yChangeBps:6,creditSpreadChangeBps:3},
    events:[{id:'fomc-test',type:'FOMC',symbol:'MARKET',startAt:NOW,confidence:.99,source:'FED',sourceGroup:'FED',sourceClass:'PRIMARY',title:'FOMC rate decision'}]
  }
});

function probabilitySum(probabilities={}){return Object.values(probabilities).reduce((a,b)=>a+Number(b||0),0);}
function safeFlags(result){return result?.safety?.canTrade===false&&result?.safety?.canAuthorizeLive===false;}

function runScenario(name,definition){
  const macro=analyzeMacro(macroInput(definition.macro),{now:NOW});
  const eventRisk=evaluateEventRisk(definition.events,{now:NOW,symbol:'SPY'});
  const regime=evaluateRegime({macro,market:definition.market,eventRisk},{now:NOW,previousRegime:'NEUTRAL',hysteresisMargin:0});
  return {name,macro,eventRisk,regime};
}

function runCriticalValidation(){
  const scenarios=Object.fromEntries(Object.entries(SCENARIOS).map(([name,def])=>[name,runScenario(name,def)]));
  const calmReturns=returnsSet(false);const crisisReturns=returnsSet(true);
  const expected={SPY:.00035,QQQ:.00045,GLD:.0002,TLT:.00015,XLV:.0003,XLE:.00025};
  const current={SPY:.25,QQQ:.2,GLD:.15,TLT:.15,XLV:.15,XLE:.1};
  const optimizer=optimizePortfolio({returns:calmReturns,expectedReturns:expected,currentWeights:current,dataQuality:{SPY:1,QQQ:1,GLD:1,TLT:1,XLV:1,XLE:1}},{maxWeight:.25,minObservations:60,now:NOW});
  const infeasibleOptimizer=optimizePortfolio({returns:{SPY:calmReturns.SPY,QQQ:calmReturns.QQQ},expectedReturns:{SPY:.001,QQQ:.0008},currentWeights:{SPY:.5,QQQ:.5}},{maxWeight:.25,minObservations:60,now:NOW});
  const stress={EQUITY_CRASH:{SPY:-.2,QQQ:-.28,GLD:.04,TLT:.03,XLV:-.13,XLE:-.18},RATE_SPIKE:{SPY:-.08,QQQ:-.12,GLD:-.04,TLT:-.14,XLV:-.05,XLE:.02},CREDIT_EVENT:{SPY:-.14,QQQ:-.18,GLD:.03,TLT:.04,XLV:-.1,XLE:-.12}};
  const calmRisk=assessInstitutionalRisk({weights:current,returns:calmReturns,stressScenarios:stress},{minObservations:60,now:NOW});
  const crisisRisk=assessInstitutionalRisk({weights:current,returns:crisisReturns,stressScenarios:stress},{minObservations:60,now:NOW});
  const weights=Object.values(optimizer.targetWeights||{});
  const checks={
    macroCoverage:Object.values(scenarios).every(s=>s.macro.validInputs>=6&&s.macro.independentSources>=2),
    probabilityNormalization:Object.values(scenarios).every(s=>Math.abs(probabilitySum(s.regime.probabilities)-1)<0.0002),
    stageSafety:Object.values(scenarios).every(s=>safeFlags(s.macro)&&safeFlags(s.eventRisk)&&safeFlags(s.regime))&&safeFlags(optimizer)&&safeFlags(calmRisk)&&safeFlags(crisisRisk),
    fomcBlocksNewBuy:scenarios.FOMC_WINDOW.eventRisk.blockNewBuy===true&&scenarios.FOMC_WINDOW.eventRisk.safety.canSell===false,
    adverseRegimeTightensRisk:scenarios.CREDIT_CRUNCH.regime.riskMultiplier<=scenarios.GOLDILOCKS.regime.riskMultiplier&&scenarios.INFLATION_SHOCK.regime.riskMultiplier<=scenarios.GOLDILOCKS.regime.riskMultiplier,
    optimizerReady:optimizer.status==='READY_FOR_SHADOW_REVIEW',
    optimizerWeightsSum:Math.abs(weights.reduce((a,b)=>a+b,0)-1)<1e-8,
    optimizerCapRespected:weights.every(w=>w<=.25000001),
    infeasibleConstraintFailsClosed:infeasibleOptimizer.status==='INCONCLUSIVE'&&infeasibleOptimizer.reason==='CONSTRAINT_INFEASIBLE',
    crisisRiskNotSafer:crisisRisk.score>=calmRisk.score&&crisisRisk.shadowRiskMultiplier<=calmRisk.shadowRiskMultiplier
  };
  const failures=Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name);
  return {version:VERSION,at:NOW,status:failures.length?'FAILED':'TECHNICALLY_VALIDATED_FOR_EMPIRICAL_SHADOW',checks,failures,scenarios,optimizer,infeasibleOptimizer,calmRisk,crisisRisk,safety:{shadowOnly:true,networkCalls:0,openAiCalls:0,executionCalls:0,canTrade:false,canAuthorizeLive:false,livePromotionAllowed:false}};
}

global.__LEO_CRITICAL_11_15_VALIDATION__=runCriticalValidation;
module.exports={VERSION,NOW,SCENARIOS,deterministicSeries,returnsSet,runScenario,runCriticalValidation};