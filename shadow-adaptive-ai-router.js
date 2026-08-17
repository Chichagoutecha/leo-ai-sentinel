'use strict';

/** LEO-AI SENTINEL — Stage 9 Adaptive AI Router (policy only, no model calls). */
const VERSION='v10.24.8-adaptive-ai-router';
let state={decisions:0,byRoute:{},last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function clamp(n,min,max){return Math.max(min,Math.min(max,Number(n)));}
function routeAI(context={},options={}){
  const ambiguity=clamp(num(context.ambiguityScore,0),0,100);const stakes=clamp(num(context.stakesScore,0),0,100);const dataQuality=clamp(num(context.dataQuality,1),0,1);const councilConflict=clamp(num(context.councilConflictScore,0),0,100);
  const budgetRemaining=Math.max(0,num(context.aiBudgetRemainingUsd,0));const dailyRemaining=Math.max(0,Math.floor(num(context.aiCallsRemainingToday,0)));
  const lunaModel=String(options.lunaModel||'gpt-5.6-luna');const premiumModel=String(options.premiumModel||'PREMIUM_REVIEW_UNCONFIGURED');
  let route='QUANT_ONLY',reason='LOW_COMPLEXITY_OR_AI_NOT_NEEDED',model=null,maxTokens=0;
  if(dataQuality<.75){route='BLOCK';reason='DATA_QUALITY_TOO_LOW';}
  else if(budgetRemaining<=0||dailyRemaining<=0){route='QUANT_ONLY';reason='AI_BUDGET_OR_DAILY_CAP_EXHAUSTED';}
  else if(stakes>=85&&ambiguity>=70&&councilConflict>=60&&premiumModel!=='PREMIUM_REVIEW_UNCONFIGURED'){route='PREMIUM_REVIEW';reason='HIGH_STAKES_HIGH_AMBIGUITY';model=premiumModel;maxTokens=1200;}
  else if(ambiguity>=45||councilConflict>=40||stakes>=65){route='LUNA';reason='AI_REVIEW_JUSTIFIED';model=lunaModel;maxTokens=Math.min(1200,Math.max(300,Math.floor(300+ambiguity*7)));}
  const estimatedMaxCostUsd=route==='QUANT_ONLY'||route==='BLOCK'?0:num(options.maxAllowedCallCostUsd,.02);
  if(estimatedMaxCostUsd>budgetRemaining&&route!=='QUANT_ONLY'&&route!=='BLOCK'){route='QUANT_ONLY';reason='ESTIMATED_CALL_COST_EXCEEDS_REMAINING_BUDGET';model=null;maxTokens=0;}
  state.decisions++;state.byRoute[route]=(state.byRoute[route]||0)+1;
  const result={version:VERSION,at:new Date(options.now||Date.now()).toISOString(),route,reason,model,maxTokens,estimatedMaxCostUsd:route==='QUANT_ONLY'||route==='BLOCK'?0:estimatedMaxCostUsd,inputs:{ambiguity,stakes,dataQuality,councilConflict,budgetRemaining,dailyRemaining},safety:{policyOnly:true,performsModelCall:false,canTrade:false,canAuthorizeLive:false,failClosed:true,executionCalls:0}};state.last=result;return result;
}
function getState(){return{version:VERSION,stats:{decisions:state.decisions,byRoute:{...state.byRoute},last:state.last},safety:{policyOnly:true,performsModelCall:false,canTrade:false,canAuthorizeLive:false}};}
global.__LEO_ADAPTIVE_AI_ROUTER_STATE__=getState;global.__LEO_ADAPTIVE_AI_ROUTE__=routeAI;
module.exports={VERSION,routeAI,getState};
