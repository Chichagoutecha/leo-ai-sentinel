'use strict';

/** LEO-AI SENTINEL — Stage 10 AI Value Experiment 1.1 (Shadow evaluation only). */
const VERSION='v10.24.9.1-ai-value-experiment-runtime-safe';
const ARMS=['QUANT_ONLY','QUANT_AI','COUNCIL'];
let state={runs:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function safeObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
function safeDate(v){const t=v instanceof Date?v.getTime():Date.parse(v);return Number.isFinite(t)?new Date(t):new Date();}
function mean(a){const x=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite);return x.length?x.reduce((p,q)=>p+q,0)/x.length:null;}
function std(a){const x=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite);if(x.length<2)return null;const m=mean(x);return Math.sqrt(x.reduce((s,v)=>s+(v-m)**2,0)/(x.length-1));}
function normalizeRecord(raw){const r=safeObject(raw);const opportunityId=String(r.opportunityId||'').trim();const arm=String(r.arm||'').toUpperCase();const signedReturnPct=Number(r.signedReturnPct);const notionalUsd=Number(r.notionalUsd??100);if(!opportunityId||!ARMS.includes(arm)||!Number.isFinite(signedReturnPct)||!Number.isFinite(notionalUsd)||notionalUsd<=0)return null;return{...r,opportunityId,arm,signedReturnPct,notionalUsd,aiCostUsd:Math.max(0,num(r.aiCostUsd)),otherCostUsd:Math.max(0,num(r.otherCostUsd))};}
function summarize(rows){const clean=(Array.isArray(rows)?rows:[]).map(normalizeRecord).filter(Boolean);const returns=clean.map(x=>x.signedReturnPct);const costs=clean.map(x=>x.aiCostUsd+x.otherCostUsd);const net=clean.map((x,i)=>returns[i]-costs[i]/x.notionalUsd*100);return{n:clean.length,meanSignedReturnPct:mean(returns),hitRate:clean.length?clean.filter(x=>x.signedReturnPct>0).length/clean.length:null,meanNetReturnPct:mean(net),totalAiCostUsd:clean.reduce((s,x)=>s+x.aiCostUsd,0)};}
function runAIValueExperiment(records=[],options={}){
  const source=Array.isArray(records)?records:[],opts=safeObject(options);const minMatched=Math.max(10,Math.min(10000,Math.floor(num(opts.minMatchedOpportunities,30))));
  const grouped=new Map();let invalidRecords=0,duplicateArmRecords=0;
  for(const raw of source){const r=normalizeRecord(raw);if(!r){invalidRecords++;continue;}if(!grouped.has(r.opportunityId))grouped.set(r.opportunityId,{arms:{},duplicates:new Set()});const g=grouped.get(r.opportunityId);if(g.arms[r.arm]){g.duplicates.add(r.arm);duplicateArmRecords++;continue;}g.arms[r.arm]=r;}
  const matched=[...grouped.entries()].filter(([,g])=>g.duplicates.size===0&&ARMS.every(a=>g.arms[a])).map(([id,g])=>({id,arms:g.arms}));
  const duplicateOpportunityCount=[...grouped.values()].filter(g=>g.duplicates.size>0).length;
  const byArm={};for(const arm of ARMS)byArm[arm]=summarize(matched.map(x=>x.arms[arm]));
  const deltas={};for(const arm of ['QUANT_AI','COUNCIL']){const diffs=matched.map(x=>x.arms[arm].signedReturnPct-x.arms.QUANT_ONLY.signedReturnPct);const costDiffs=matched.map(x=>x.arms[arm].aiCostUsd-x.arms.QUANT_ONLY.aiCostUsd);deltas[`${arm}_vs_QUANT_ONLY`]={meanReturnDeltaPct:mean(diffs),stdReturnDeltaPct:std(diffs),positiveDeltaRate:diffs.length?diffs.filter(x=>x>0).length/diffs.length:null,totalIncrementalAiCostUsd:costDiffs.reduce((a,b)=>a+b,0),matchedN:diffs.length};}
  const sampleReady=matched.length>=minMatched;let verdict='INSUFFICIENT_SAMPLE';if(sampleReady){const best=Object.entries(byArm).sort((a,b)=>num(b[1].meanNetReturnPct,-999)-num(a[1].meanNetReturnPct,-999))[0];verdict=best?`BEST_NET_ARM_${best[0]}`:'INCONCLUSIVE';}
  state.runs++;const result={version:VERSION,at:safeDate(opts.now).toISOString(),verdict,sampleReady,minMatchedOpportunities:minMatched,recordsReceived:source.length,invalidRecords,duplicateArmRecords,duplicateOpportunityCount,matchedOpportunities:matched.length,unmatchedOpportunities:grouped.size-matched.length,byArm,deltas,protocol:{matchedSameOpportunityRequired:true,duplicateArmsDisqualifyOpportunity:true,invalidMetricRowsExcluded:true,arms:ARMS,outOfSampleRequired:true,livePromotionAllowed:false},safety:{shadowOnly:true,performsAiCalls:false,canTrade:false,canAuthorizeLive:false,automaticLivePromotion:false,executionCalls:0}};state.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...state},safety:{shadowOnly:true,performsAiCalls:false,canTrade:false,canAuthorizeLive:false}};}
global.__LEO_AI_VALUE_EXPERIMENT_STATE__=getState;global.__LEO_AI_VALUE_EXPERIMENT_RUN__=runAIValueExperiment;
module.exports={VERSION,ARMS,normalizeRecord,summarize,runAIValueExperiment,getState};
