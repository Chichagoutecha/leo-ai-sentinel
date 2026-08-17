'use strict';

/** Integration preflight for roadmap stages 6–15. Zero network / zero execution. */
const VERSION='v10.25.0-shadow-roadmap-6-15-preflight';
const REQUIRED=Object.freeze({
  6:'__LEO_OPPORTUNITY_DISCOVERY_V2_STATE__',
  7:'__LEO_DYNAMIC_UNIVERSE_STATE__',
  8:'__LEO_PROFITABILITY_COST_STATE__',
  9:'__LEO_ADAPTIVE_AI_ROUTER_STATE__',
  10:'__LEO_AI_VALUE_EXPERIMENT_STATE__',
  11:'__LEO_MARKET_REGIME_V2_STATE__',
  12:'__LEO_MACRO_INTELLIGENCE_STATE__',
  13:'__LEO_EVENT_RISK_STATE__',
  14:'__LEO_PORTFOLIO_OPTIMIZER_V2_STATE__',
  15:'__LEO_INSTITUTIONAL_RISK_STATE__'
});
function stateOf(name){try{const fn=global[name];return typeof fn==='function'?fn():null;}catch(error){return{error:String(error?.message||error)}};}
function preflight(){
  const stages={};let allPresent=true,allShadowSafe=true;
  for(const [stage,name] of Object.entries(REQUIRED)){const s=stateOf(name);const present=Boolean(s);const safety=s?.safety||{};const safe=present&&safety.canTrade===false&&safety.canAuthorizeLive===false;stages[stage]={global:name,present,safe,version:s?.version||null,error:s?.error||null};if(!present)allPresent=false;if(!safe)allShadowSafe=false;}
  return {version:VERSION,at:new Date().toISOString(),allPresent,allShadowSafe,readyForEmpiricalShadow:allPresent&&allShadowSafe,livePromotionAllowed:false,livePromotionReason:'Separate empirical validation and explicit production authorization remain mandatory.',stages,safety:{networkCalls:0,openAiCalls:0,executionCalls:0,liveMutations:0}};
}
global.__LEO_ROADMAP_6_15_PREFLIGHT__=preflight;
console.log(`[LEO_ROADMAP_6_15_PREFLIGHT] ${JSON.stringify(preflight())}`);
module.exports={VERSION,REQUIRED,preflight};
