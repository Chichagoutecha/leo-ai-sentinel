'use strict';

/** LEO-AI SENTINEL — Stage 10 AI Value Experiment (Shadow evaluation only). */
const VERSION='v10.24.9-ai-value-experiment';
const ARMS=['QUANT_ONLY','QUANT_AI','COUNCIL'];
let state={runs:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:null;}
function std(a){if(a.length<2)return null;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));}
function summarize(rows){const returns=rows.map(x=>num(x.signedReturnPct));const costs=rows.map(x=>Math.max(0,num(x.aiCostUsd)+num(x.otherCostUsd)));const net=rows.map((x,i)=>returns[i]-costs[i]/Math.max(.01,num(x.notionalUsd,100))*100);return{n:rows.length,meanSignedReturnPct:mean(returns),hitRate:rows.length?rows.filter(x=>num(x.signedReturnPct)>0).length/rows.length:null,meanNetReturnPct:mean(net),totalAiCostUsd:rows.reduce((s,x)=>s+num(x.aiCostUsd),0)};}
function runAIValueExperiment(records=[],options={}){
  const minMatched=Math.max(10,Math.floor(options.minMatchedOpportunities??30));
  const grouped=new Map();for(const r of records){const id=String(r?.opportunityId||'');const arm=String(r?.arm||'').toUpperCase();if(!id||!ARMS.includes(arm))continue;if(!grouped.has(id))grouped.set(id,{});grouped.get(id)[arm]=r;}
  const matched=[...grouped.entries()].filter(([,arms])=>ARMS.every(a=>arms[a])).map(([id,arms])=>({id,arms}));
  const byArm={};for(const arm of ARMS)byArm[arm]=summarize(matched.map(x=>x.arms[arm]));
  const deltas={};for(const arm of ['QUANT_AI','COUNCIL']){const diffs=matched.map(x=>num(x.arms[arm].signedReturnPct)-num(x.arms.QUANT_ONLY.signedReturnPct));const costDiffs=matched.map(x=>num(x.arms[arm].aiCostUsd)-num(x.arms.QUANT_ONLY.aiCostUsd));deltas[`${arm}_vs_QUANT_ONLY`]={meanReturnDeltaPct:mean(diffs),stdReturnDeltaPct:std(diffs),positiveDeltaRate:diffs.length?diffs.filter(x=>x>0).length/diffs.length:null,totalIncrementalAiCostUsd:costDiffs.reduce((a,b)=>a+b,0),matchedN:diffs.length};}
  const sampleReady=matched.length>=minMatched;let verdict='INSUFFICIENT_SAMPLE';if(sampleReady){const best=Object.entries(byArm).sort((a,b)=>num(b[1].meanNetReturnPct,-999)-num(a[1].meanNetReturnPct,-999))[0];verdict=best?`BEST_NET_ARM_${best[0]}`:'INCONCLUSIVE';}
  state.runs++;const result={version:VERSION,at:new Date(options.now||Date.now()).toISOString(),verdict,sampleReady,minMatchedOpportunities:minMatched,matchedOpportunities:matched.length,unmatchedOpportunities:grouped.size-matched.length,byArm,deltas,protocol:{matchedSameOpportunityRequired:true,arms:ARMS,outOfSampleRequired:true,livePromotionAllowed:false},safety:{shadowOnly:true,performsAiCalls:false,canTrade:false,canAuthorizeLive:false,automaticLivePromotion:false,executionCalls:0}};state.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...state},safety:{shadowOnly:true,performsAiCalls:false,canTrade:false,canAuthorizeLive:false}};}
global.__LEO_AI_VALUE_EXPERIMENT_STATE__=getState;global.__LEO_AI_VALUE_EXPERIMENT_RUN__=runAIValueExperiment;
module.exports={VERSION,ARMS,summarize,runAIValueExperiment,getState};
