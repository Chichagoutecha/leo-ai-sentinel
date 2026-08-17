'use strict';

/** LEO-AI SENTINEL — Stage 8 Profitability & Cost Guard 1.1 (Shadow analytics only). */
const VERSION='v10.24.7.1-profitability-cost-runtime-safe';
let state={runs:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function safeObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
function safeDate(v){const t=v instanceof Date?v.getTime():Date.parse(v);return Number.isFinite(t)?new Date(t):new Date();}
function nonNegative(v){return Math.max(0,num(v,0));}
function groupBy(items,keyFn){const out={};for(const x of Array.isArray(items)?items:[]){const k=keyFn(x)||'UNKNOWN';(out[k]??=[]).push(x);}return out;}
function normalizeRecord(raw){const x=safeObject(raw);return{...x,decisionId:String(x.decisionId||''),source:String(x.source||'UNKNOWN').toUpperCase(),route:String(x.route||'UNKNOWN').toUpperCase(),grossPnlUsd:num(x.grossPnlUsd),spreadCostUsd:nonNegative(x.spreadCostUsd),slippageCostUsd:nonNegative(x.slippageCostUsd),feesUsd:nonNegative(x.feesUsd),aiCostUsd:nonNegative(x.aiCostUsd),dataCostUsd:nonNegative(x.dataCostUsd),infrastructureCostUsd:nonNegative(x.infrastructureCostUsd)};}
function fingerprint(x){return JSON.stringify([x.decisionId,x.source,x.route,x.grossPnlUsd,x.spreadCostUsd,x.slippageCostUsd,x.feesUsd,x.aiCostUsd,x.dataCostUsd,x.infrastructureCostUsd]);}
function summarize(items){
  const rows=(Array.isArray(items)?items:[]).map(normalizeRecord);
  const gross=rows.reduce((s,x)=>s+x.grossPnlUsd,0);const tradingCosts=rows.reduce((s,x)=>s+x.spreadCostUsd+x.slippageCostUsd+x.feesUsd,0);const ai=rows.reduce((s,x)=>s+x.aiCostUsd,0);const data=rows.reduce((s,x)=>s+x.dataCostUsd,0);const infra=rows.reduce((s,x)=>s+x.infrastructureCostUsd,0);const totalCosts=tradingCosts+ai+data+infra;const net=gross-totalCosts;const wins=rows.filter(x=>x.grossPnlUsd>0).length;return{count:rows.length,grossPnlUsd:gross,tradingCostsUsd:tradingCosts,aiCostUsd:ai,dataCostUsd:data,infrastructureCostUsd:infra,totalCostsUsd:totalCosts,netPnlUsd:net,winRate:rows.length?wins/rows.length:null,roiOnCost:totalCosts>0?net/totalCosts:null};
}
function evaluateProfitability(records=[],options={}){
  const opts=safeObject(options),source=Array.isArray(records)?records:[];const seen=new Set();let duplicatesExcluded=0;const clean=[];
  for(const raw of source){if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;const row=normalizeRecord(raw);const fp=fingerprint(row);if(seen.has(fp)){duplicatesExcluded++;continue;}seen.add(fp);clean.push(row);}
  const overall=summarize(clean);const bySource=Object.fromEntries(Object.entries(groupBy(clean,x=>x.source)).map(([k,v])=>[k,summarize(v)]));const byRoute=Object.fromEntries(Object.entries(groupBy(clean,x=>x.route)).map(([k,v])=>[k,summarize(v)]));
  const monthlyBudgetUsd=Math.max(0,num(opts.monthlyBudgetUsd,1));const aiSpend=overall.aiCostUsd;const budgetRemainingUsd=Math.max(0,monthlyBudgetUsd-aiSpend);const costRatio=overall.grossPnlUsd>0?overall.totalCostsUsd/overall.grossPnlUsd:null;
  let status='HEALTHY';if(aiSpend>monthlyBudgetUsd)status='AI_BUDGET_EXCEEDED';else if(overall.count>=10&&overall.netPnlUsd<0)status='UNPROFITABLE_SAMPLE';else if(costRatio!=null&&costRatio>.5)status='COST_DRAG_HIGH';else if(overall.count<10)status='INSUFFICIENT_SAMPLE';
  state.runs++;const result={version:VERSION,at:safeDate(opts.now).toISOString(),status,recordsReceived:source.length,recordsUsed:clean.length,duplicatesExcluded,overall,bySource,byRoute,budget:{monthlyBudgetUsd,aiSpendUsd:aiSpend,budgetRemainingUsd},costRatio,safety:{shadowOnly:true,canTrade:false,canBlockLive:false,canAuthorizeLive:false,openAiCalls:0,executionCalls:0}};state.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...state},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false}};}
global.__LEO_PROFITABILITY_COST_STATE__=getState;global.__LEO_PROFITABILITY_COST_EVALUATE__=evaluateProfitability;
module.exports={VERSION,normalizeRecord,summarize,evaluateProfitability,getState};
