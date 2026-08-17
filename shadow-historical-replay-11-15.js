'use strict';

/**
 * LEO-AI SENTINEL — Historical Replay Harness for stages 11-15 (Shadow only)
 *
 * Provider-decoupled replay engine. It accepts normalized point-in-time rows and
 * deliberately makes zero network/OpenAI/eToro calls. The included fixture is
 * HISTORICAL_STYLE synthetic data only; it is not empirical market history.
 */
const { analyzeMacro } = require('./shadow-macro-intelligence-agent');
const { evaluateEventRisk } = require('./shadow-event-risk-calendar');
const { evaluateRegime } = require('./shadow-market-regime-engine-v2');
const { optimizePortfolio } = require('./shadow-portfolio-optimizer-v2');
const { assessInstitutionalRisk } = require('./shadow-institutional-risk-engine');

const VERSION = 'v10.25.6-historical-replay-11-15';
const SYMBOLS = Object.freeze(['SPY','QQQ','GLD','TLT','XLV','XLE']);
const DEFAULT_WEIGHTS = Object.freeze({SPY:.25,QQQ:.20,GLD:.15,TLT:.15,XLV:.15,XLE:.10});
const DEFAULT_STRESS = Object.freeze({
  EQUITY_CRASH:{SPY:-.20,QQQ:-.28,GLD:.04,TLT:.03,XLV:-.13,XLE:-.18},
  RATE_SPIKE:{SPY:-.08,QQQ:-.12,GLD:-.04,TLT:-.14,XLV:-.05,XLE:.02},
  CREDIT_EVENT:{SPY:-.14,QQQ:-.18,GLD:.03,TLT:.04,XLV:-.10,XLE:-.12}
});

function safeObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function iso(v){const t=Date.parse(v);return Number.isFinite(t)?new Date(t).toISOString():null;}
function avg(a){const x=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite);return x.length?x.reduce((p,q)=>p+q,0)/x.length:null;}
function probabilitySum(p){return Object.values(safeObject(p)).reduce((a,b)=>a+num(b),0);}
function safeFlags(x){return x?.safety?.canTrade===false&&x?.safety?.canAuthorizeLive===false;}

function observation(value, at, sourceGroup, maxAgeDays){
  return {value,asOf:at,source:sourceGroup,sourceGroup,maxAgeDays};
}
function macroInput(values, at){
  const v=safeObject(values);
  return {
    policyRate:observation(v.policyRate??4,at,'CENTRAL_BANK',120),
    inflationYoY:observation(v.inflationYoY??2.4,at,'STATISTICS_A',45),
    coreInflationYoY:observation(v.coreInflationYoY??2.5,at,'STATISTICS_A',45),
    unemployment:observation(v.unemployment??4.1,at,'STATISTICS_B',45),
    payrollTrend:observation(v.payrollTrend??130,at,'STATISTICS_B',45),
    pmi:observation(v.pmi??52,at,'SURVEY_A',45),
    yield2y:observation(v.yield2y??4,at,'MARKET_RATES',3),
    yield10y:observation(v.yield10y??4.2,at,'MARKET_RATES',3),
    dxyTrendPct:observation(v.dxyTrendPct??0,at,'MARKET_FX',3),
    oilTrendPct:observation(v.oilTrendPct??0,at,'MARKET_COMMODITY',3),
    creditSpreadBps:observation(v.creditSpreadBps??110,at,'MARKET_CREDIT',3),
    vix:observation(v.vix??16,at,'MARKET_VOL',1)
  };
}

function validateReplayRows(rows){
  if(!Array.isArray(rows)||rows.length<4)return{ok:false,reason:'INSUFFICIENT_REPLAY_ROWS',rows:Array.isArray(rows)?rows.length:0};
  let previous=-Infinity;const seen=new Set();
  for(let i=0;i<rows.length;i++){
    const row=rows[i];const at=iso(row?.at);if(!at)return{ok:false,reason:'INVALID_TIMESTAMP',index:i};
    const ms=Date.parse(at);if(seen.has(ms))return{ok:false,reason:'DUPLICATE_TIMESTAMP',index:i};
    if(ms<=previous)return{ok:false,reason:'NON_MONOTONIC_TIME',index:i};
    seen.add(ms);previous=ms;
    if(!Object.keys(safeObject(row?.market)).length||!Object.keys(safeObject(row?.macro)).length)return{ok:false,reason:'MISSING_POINT_IN_TIME_INPUT',index:i};
    if(!Object.keys(safeObject(row?.returns)).length)return{ok:false,reason:'MISSING_RISK_INPUT',index:i};
  }
  return{ok:true,reason:null,rows:rows.length};
}

function replayStages11to15(rows, options={}){
  const validation=validateReplayRows(rows);
  const safety={shadowOnly:true,networkCalls:0,openAiCalls:0,executionCalls:0,canTrade:false,canAuthorizeLive:false,livePromotionAllowed:false};
  if(!validation.ok)return{version:VERSION,status:'INCONCLUSIVE',reason:validation.reason,validation,results:[],metrics:{},checks:{},safety};
  const opts=safeObject(options);const maxWeight=num(opts.maxWeight,.25);const minObservations=num(opts.minObservations,60);
  let previousRegime='NEUTRAL';const results=[];
  for(const row of rows){
    const at=iso(row.at);const macro=analyzeMacro(macroInput(row.macro,at),{now:at});
    const eventRisk=evaluateEventRisk(Array.isArray(row.events)?row.events:[],{now:at,symbol:String(row.symbol||'SPY')});
    const regime=evaluateRegime({macro,market:row.market,eventRisk},{now:at,previousRegime,hysteresisMargin:num(opts.hysteresisMargin,.06)});
    previousRegime=regime.regime;
    const currentWeights=safeObject(row.currentWeights);const effectiveCurrent=Object.keys(currentWeights).length?currentWeights:DEFAULT_WEIGHTS;
    const optimizer=optimizePortfolio({returns:row.returns,expectedReturns:safeObject(row.expectedReturns),currentWeights:effectiveCurrent,dataQuality:safeObject(row.dataQuality)},{maxWeight,minObservations,now:at});
    const riskWeights=optimizer.status==='READY_FOR_SHADOW_REVIEW'?optimizer.targetWeights:effectiveCurrent;
    const risk=assessInstitutionalRisk({weights:riskWeights,returns:row.returns,stressScenarios:row.stressScenarios||DEFAULT_STRESS},{minObservations,now:at});
    results.push({at,phase:String(row.phase||'UNLABELED'),macro,eventRisk,regime,optimizer,risk});
  }
  const phases={};for(const r of results){if(!phases[r.phase])phases[r.phase]=[];phases[r.phase].push(r);}
  const phaseMetrics=Object.fromEntries(Object.entries(phases).map(([phase,list])=>[phase,{
    rows:list.length,
    avgRegimeRiskMultiplier:avg(list.map(x=>x.regime.riskMultiplier)),
    avgInstitutionalRiskMultiplier:avg(list.map(x=>x.risk.shadowRiskMultiplier).filter(Number.isFinite)),
    avgRiskScore:avg(list.map(x=>x.risk.score).filter(Number.isFinite)),
    blockNewBuyRate:list.filter(x=>x.eventRisk.blockNewBuy).length/list.length
  }]));
  const transitions=results.slice(1).filter((r,i)=>r.regime.regime!==results[i].regime.regime).length;
  const optimizerReady=results.filter(r=>r.optimizer.status==='READY_FOR_SHADOW_REVIEW').length;
  const riskReady=results.filter(r=>['NORMAL','WATCH','DEFENSIVE','CRITICAL'].includes(r.risk.status)).length;
  const finiteRegime=results.every(r=>Number.isFinite(r.regime.riskMultiplier)&&Math.abs(probabilitySum(r.regime.probabilities)-1)<.001);
  const finitePortfolio=results.every(r=>r.optimizer.status!=='READY_FOR_SHADOW_REVIEW'||(
    Math.abs(Object.values(r.optimizer.targetWeights).reduce((a,b)=>a+b,0)-1)<1e-8&&
    Object.values(r.optimizer.targetWeights).every(w=>Number.isFinite(w)&&w<=maxWeight+1e-8)
  ));
  const finiteRisk=results.every(r=>r.risk.status==='INCONCLUSIVE'||[
    r.risk.score,r.risk.shadowRiskMultiplier,r.risk.metrics?.historicalVaR95,r.risk.metrics?.historicalCVaR95,r.risk.metrics?.annualizedVolatility,r.risk.metrics?.maxDrawdown,r.risk.worstStressReturn
  ].every(Number.isFinite));
  const safetyInvariant=results.every(r=>safeFlags(r.macro)&&safeFlags(r.eventRisk)&&safeFlags(r.regime)&&safeFlags(r.optimizer)&&safeFlags(r.risk)&&r.eventRisk.safety?.canSell===false);
  const calm=phaseMetrics.CALM;const inflation=phaseMetrics.INFLATION_SHOCK;const credit=phaseMetrics.CREDIT_STRESS;const recovery=phaseMetrics.RECOVERY;
  const shockTightens=!!(calm&&inflation&&credit&&inflation.avgRegimeRiskMultiplier<=calm.avgRegimeRiskMultiplier&&credit.avgRegimeRiskMultiplier<=calm.avgRegimeRiskMultiplier);
  const recoveryImproves=!!(credit&&recovery&&recovery.avgRegimeRiskMultiplier>=credit.avgRegimeRiskMultiplier);
  const transitionRate=transitions/Math.max(1,results.length-1);
  const checks={finiteRegime,finitePortfolio,finiteRisk,safetyInvariant,optimizerCoverage:optimizerReady/results.length>=.9,riskCoverage:riskReady/results.length>=.9,shockTightens,recoveryImproves,transitionRateBounded:transitionRate<=.5};
  const failures=Object.entries(checks).filter(([,ok])=>!ok).map(([k])=>k);
  return {version:VERSION,status:failures.length?'FAILED':'TECHNICALLY_READY_FOR_REAL_HISTORY',dataClass:String(opts.dataClass||'UNSPECIFIED'),validation,checks,failures,metrics:{rows:results.length,transitions,transitionRate,optimizerReady,riskReady,phaseMetrics},results,safety};
}

function deterministicReturns(seed, phase, length=90){
  const out={};const phaseVol=phase==='CREDIT_STRESS'?2.2:phase==='INFLATION_SHOCK'?1.55:phase==='RECOVERY'?1.1:1;
  const phaseDrift=phase==='CREDIT_STRESS'?-.0008:phase==='INFLATION_SHOCK'?-.00025:phase==='RECOVERY'?.00045:.00035;
  SYMBOLS.forEach((s,si)=>{const arr=[];for(let i=0;i<length;i++){
    const baseVol=[.007,.010,.006,.007,.0065,.011][si]*phaseVol;
    const cyc=Math.sin((i+seed+si*3)*.37)*baseVol*.7+Math.cos((i+seed+si)*.13)*baseVol*.3;
    const shock=phase==='CREDIT_STRESS'&&i>0&&i%23===0?(-.025-si*.004):0;
    const defensive=(s==='GLD'||s==='TLT')&&phase==='CREDIT_STRESS'?.0005:0;
    arr.push(phaseDrift+defensive+cyc+shock);
  }out[s]=arr;});return out;
}

function phaseDefinition(phase, step){
  if(phase==='INFLATION_SHOCK')return{
    macro:{pmi:51,unemployment:4.2,payrollTrend:90,inflationYoY:4.8,coreInflationYoY:4.5,policyRate:4.7,yield2y:5.0,yield10y:4.6,creditSpreadBps:165,vix:25,dxyTrendPct:2,oilTrendPct:16},
    market:{breadthPct:40,trendScore:-22,realizedVolPct:27,vix:27,creditStressScore:25,rateShockScore:82,oilTrendPct:16,yield2yChangeBps:45,creditSpreadChangeBps:18}
  };
  if(phase==='CREDIT_STRESS')return{
    macro:{pmi:43,unemployment:5.3,payrollTrend:-100,inflationYoY:2.3,coreInflationYoY:2.5,policyRate:4.1,yield2y:3.4,yield10y:3.0,creditSpreadBps:320,vix:42,dxyTrendPct:3.5,oilTrendPct:-12},
    market:{breadthPct:20,trendScore:-75,realizedVolPct:41,vix:44,creditStressScore:94,rateShockScore:20,oilTrendPct:-12,yield2yChangeBps:-18,creditSpreadChangeBps:105}
  };
  if(phase==='RECOVERY')return{
    macro:{pmi:51+step*.25,unemployment:4.7-step*.04,payrollTrend:60+step*8,inflationYoY:2.5,coreInflationYoY:2.7,policyRate:3.9,yield2y:3.7,yield10y:4.0,creditSpreadBps:145-step*3,vix:21-step*.4,dxyTrendPct:0,oilTrendPct:1},
    market:{breadthPct:52+step*2,trendScore:10+step*4,realizedVolPct:22-step*.5,vix:21-step*.4,creditStressScore:20-step*3,rateShockScore:5,oilTrendPct:1,yield2yChangeBps:-2,creditSpreadChangeBps:-3}
  };
  return{
    macro:{pmi:54,unemployment:3.9,payrollTrend:175,inflationYoY:2.2,coreInflationYoY:2.3,policyRate:3.8,yield2y:3.7,yield10y:4.1,creditSpreadBps:92,vix:14,dxyTrendPct:-1,oilTrendPct:-1},
    market:{breadthPct:70,trendScore:60,realizedVolPct:14,vix:14,creditStressScore:-15,rateShockScore:-8,oilTrendPct:-1,yield2yChangeBps:-4,creditSpreadChangeBps:-6}
  };
}

function buildHistoricalStyleFixture(){
  const phases=[...Array(10).fill('CALM'),...Array(8).fill('INFLATION_SHOCK'),...Array(8).fill('CREDIT_STRESS'),...Array(10).fill('RECOVERY')];
  const start=Date.parse('2025-01-02T16:00:00.000Z');
  return phases.map((phase,i)=>{
    const at=new Date(start+i*86400000).toISOString();const localStep=phase==='RECOVERY'?i-26:i;
    const d=phaseDefinition(phase,localStep);const returns=deterministicReturns(i+11,phase,90);
    const expectedReturns=Object.fromEntries(SYMBOLS.map((s,si)=>[s,phase==='CREDIT_STRESS'?((s==='GLD'||s==='TLT')?.00035:-.0001):(.00025+si*.00002)]));
    const events=phase==='INFLATION_SHOCK'&&i===13?[{id:'cpi-fixture',type:'CPI',symbol:'MARKET',startAt:at,confidence:.99,source:'PRIMARY_FIXTURE',sourceGroup:'PRIMARY_FIXTURE',sourceClass:'PRIMARY',title:'Synthetic CPI replay marker'}]:[];
    return{at,phase,macro:d.macro,market:d.market,events,returns,expectedReturns,currentWeights:{...DEFAULT_WEIGHTS},dataQuality:Object.fromEntries(SYMBOLS.map(s=>[s,1])),stressScenarios:DEFAULT_STRESS};
  });
}

function runHistoricalStyleValidation(){return replayStages11to15(buildHistoricalStyleFixture(),{dataClass:'HISTORICAL_STYLE_SYNTHETIC',minObservations:60,maxWeight:.25,hysteresisMargin:.06});}

global.__LEO_HISTORICAL_REPLAY_11_15__=replayStages11to15;
module.exports={VERSION,SYMBOLS,DEFAULT_WEIGHTS,DEFAULT_STRESS,validateReplayRows,replayStages11to15,buildHistoricalStyleFixture,runHistoricalStyleValidation};
