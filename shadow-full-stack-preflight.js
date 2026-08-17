'use strict';

/** LEO-AI SENTINEL v10.25.4 — Full Shadow stack preflight (stages 2–15). */
const VERSION='v10.25.4-full-shadow-stack-preflight';

const REQUIRED=Object.freeze({
  shadowLab:{stage:2,global:'__LEO_SHADOW_LAB_STATE__',kind:'LAB'},
  research:{stage:2,global:'__LEO_SHADOW_RESEARCH_STATE__',kind:'STANDARD'},
  alpaca:{stage:3,global:'__LEO_ALPACA_VALIDATOR_STATE__',kind:'STANDARD'},
  quartr:{stage:4,global:'__LEO_QUARTR_FUNDAMENTAL_STATE__',kind:'STANDARD'},
  exa:{stage:5,global:'__LEO_EXA_CATALYST_STATE__',kind:'STANDARD'},
  foundationGuard:{stage:'3-5',global:'__LEO_FOUNDATION_RUNTIME_GUARD_STATE__',kind:'STANDARD'},
  discovery:{stage:6,global:'__LEO_OPPORTUNITY_DISCOVERY_V2_STATE__',kind:'STANDARD'},
  dynamicUniverse:{stage:7,global:'__LEO_DYNAMIC_UNIVERSE_STATE__',kind:'STANDARD'},
  profitability:{stage:8,global:'__LEO_PROFITABILITY_COST_STATE__',kind:'STANDARD'},
  aiRouter:{stage:9,global:'__LEO_ADAPTIVE_AI_ROUTER_STATE__',kind:'STANDARD'},
  aiValue:{stage:10,global:'__LEO_AI_VALUE_EXPERIMENT_STATE__',kind:'STANDARD'},
  regime:{stage:11,global:'__LEO_MARKET_REGIME_V2_STATE__',kind:'STANDARD'},
  macro:{stage:12,global:'__LEO_MACRO_INTELLIGENCE_STATE__',kind:'STANDARD'},
  eventRisk:{stage:13,global:'__LEO_EVENT_RISK_STATE__',kind:'STANDARD'},
  portfolioOptimizer:{stage:14,global:'__LEO_PORTFOLIO_OPTIMIZER_V2_STATE__',kind:'STANDARD'},
  institutionalRisk:{stage:15,global:'__LEO_INSTITUTIONAL_RISK_STATE__',kind:'STANDARD'}
});

async function stateOf(name){
  try{
    const fn=global[name];
    if(typeof fn!=='function')return null;
    return await Promise.resolve(fn());
  }catch(error){
    return{errorName:String(error?.name||'Error').slice(0,80)};
  }
}

function safeState(state,kind){
  if(!state||state.errorName)return false;
  const safety=state.safety||{};
  if(kind==='LAB')return safety.canTrade===false&&safety.executionEndpointAllowed===false&&safety.liveAllowlistModified===false;
  return safety.canTrade===false&&safety.canAuthorizeLive===false;
}

async function preflight(){
  const components={};let allPresent=true,allShadowSafe=true,noStateErrors=true;
  for(const [key,config] of Object.entries(REQUIRED)){
    const state=await stateOf(config.global);
    const present=Boolean(state);
    const errorName=state?.errorName||null;
    const safe=present&&!errorName&&safeState(state,config.kind);
    components[key]={stage:config.stage,global:config.global,present,safe,version:state?.version||null,errorName};
    if(!present)allPresent=false;
    if(!safe)allShadowSafe=false;
    if(errorName)noStateErrors=false;
  }
  return{
    version:VERSION,
    at:new Date().toISOString(),
    allPresent,
    allShadowSafe,
    noStateErrors,
    readyForFullShadowRuntime:allPresent&&allShadowSafe&&noStateErrors,
    livePromotionAllowed:false,
    livePromotionReason:'Full Shadow runtime readiness is not production authorization.',
    components,
    safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,networkCalls:0,openAiCalls:0,executionCalls:0,liveMutations:0}
  };
}

global.__LEO_FULL_SHADOW_STACK_PREFLIGHT__=preflight;
module.exports={VERSION,REQUIRED,stateOf,safeState,preflight};
