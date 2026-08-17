'use strict';

/** LEO-AI SENTINEL — Stage 8 Profitability & Cost Guard (Shadow analytics only). */
const VERSION='v10.24.7-profitability-cost-guard';
let state={runs:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function groupBy(items,keyFn){const out={};for(const x of items){const k=keyFn(x)||'UNKNOWN';(out[k]??=[]).push(x);}return out;}
function summarize(items){
  const gross=items.reduce((s,x)=>s+num(x.grossPnlUsd),0);const tradingCosts=items.reduce((s,x)=>s+num(x.spreadCostUsd)+num(x.slippageCostUsd)+num(x.feesUsd),0);const ai=items.reduce((s,x)=>s+num(x.aiCostUsd),0);const data=items.reduce((s,x)=>s+num(x.dataCostUsd),0);const infra=items.reduce((s,x)=>s+num(x.infrastructureCostUsd),0);const totalCosts=tradingCosts+ai+data+infra;const net=gross-totalCosts;const wins=items.filter(x=>num(x.grossPnlUsd)>0).length;return{count:items.length,grossPnlUsd:gross,tradingCostsUsd:tradingCosts,aiCostUsd:ai,dataCostUsd:data,infrastructureCostUsd:infra,totalCostsUsd:totalCosts,netPnlUsd:net,winRate:items.length?wins/items.length:null,roiOnCost:totalCosts>0?net/totalCosts:null};
}
function evaluateProfitability(records=[],options={}){
  const clean=records.filter(x=>x&&typeof x==='object').map(x=>({...x,decisionId:String(x.decisionId||''),source:String(x.source||'UNKNOWN').toUpperCase(),route:String(x.route||'UNKNOWN').toUpperCase()}));
  const overall=summarize(clean);const bySource=Object.fromEntries(Object.entries(groupBy(clean,x=>x.source)).map(([k,v])=>[k,summarize(v)]));const byRoute=Object.fromEntries(Object.entries(groupBy(clean,x=>x.route)).map(([k,v])=>[k,summarize(v)]));
  const monthlyBudgetUsd=Math.max(0,num(options.monthlyBudgetUsd,1));const aiSpend=overall.aiCostUsd;const budgetRemainingUsd=Math.max(0,monthlyBudgetUsd-aiSpend);const costRatio=overall.grossPnlUsd>0?overall.totalCostsUsd/overall.grossPnlUsd:null;
  let status='HEALTHY';if(aiSpend>monthlyBudgetUsd)status='AI_BUDGET_EXCEEDED';else if(overall.count>=10&&overall.netPnlUsd<0)status='UNPROFITABLE_SAMPLE';else if(costRatio!=null&&costRatio>.5)status='COST_DRAG_HIGH';else if(overall.count<10)status='INSUFFICIENT_SAMPLE';
  state.runs++;const result={version:VERSION,at:new Date(options.now||Date.now()).toISOString(),status,overall,bySource,byRoute,budget:{monthlyBudgetUsd,aiSpendUsd:aiSpend,budgetRemainingUsd},costRatio,safety:{shadowOnly:true,canTrade:false,canBlockLive:false,canAuthorizeLive:false,openAiCalls:0,executionCalls:0}};state.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...state},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false}};}
global.__LEO_PROFITABILITY_COST_STATE__=getState;global.__LEO_PROFITABILITY_COST_EVALUATE__=evaluateProfitability;
module.exports={VERSION,summarize,evaluateProfitability,getState};
