'use strict';

/**
 * LEO-AI SENTINEL v10.22.9.3 — production AI preload composition preflight.
 * Zero network calls, zero OpenAI calls, zero eToro calls.
 */
const VERSION='v10.22.9.3-production-ai-preflight';
const optimizerPath=require.resolve('./ai-cost-optimizer.js');
const lunaPath=require.resolve('./ai-luna-temperature-compat.js');
const legacyDiagnosticPath=require.resolve('./etoro-execution-diagnostics.js');

function cacheLoaded(path){return Boolean(require.cache[path]);}
function inspectComposition(overrides={}){
  const loaded={
    optimizer:overrides.optimizerLoaded??cacheLoaded(optimizerPath),
    luna:overrides.lunaLoaded??cacheLoaded(lunaPath),
    legacyDiagnostic:overrides.legacyDiagnosticLoaded??cacheLoaded(legacyDiagnosticPath)
  };
  const failures=[];
  if(!loaded.optimizer)failures.push('AI_COST_OPTIMIZER_NOT_PRELOADED');
  if(!loaded.luna)failures.push('LUNA_COMPAT_NOT_PRELOADED');
  if(loaded.legacyDiagnostic)failures.push('LEGACY_ETORO_DIAGNOSTIC_PRELOADED');
  if(loaded.optimizer&&typeof global.__LEO_AI_COST_STATE__!=='function'&&!overrides.ignoreOptimizerGlobal)failures.push('AI_COST_STATE_GLOBAL_MISSING');

  let optimizerCheck=null,lunaCheck=null;
  if(loaded.optimizer){
    const exp=require.cache[optimizerPath]?.exports||{};
    if(typeof exp.optimizedParams!=='function')failures.push('OPTIMIZED_PARAMS_EXPORT_MISSING');
    else{
      const p=exp.optimizedParams({model:'gpt-4.1-mini',max_tokens:5000,messages:[{role:'user',content:'x'}]});
      optimizerCheck={model:p.model||null,maxCompletionTokens:p.max_completion_tokens||null,hasLegacyMaxTokens:Object.prototype.hasOwnProperty.call(p,'max_tokens')};
      if(String(p.model||'').toLowerCase()!=='gpt-5.6-luna')failures.push('EFFECTIVE_MODEL_NOT_GPT_5_6_LUNA');
      if(Number(p.max_completion_tokens)!==1200)failures.push('MAX_COMPLETION_TOKENS_NOT_1200');
      if(Object.prototype.hasOwnProperty.call(p,'max_tokens'))failures.push('LEGACY_MAX_TOKENS_NOT_REMOVED');
    }
  }
  if(loaded.luna){
    const exp=require.cache[lunaPath]?.exports||{};
    if(typeof exp.sanitizeLunaParams!=='function')failures.push('LUNA_SANITIZER_EXPORT_MISSING');
    else{
      const p=exp.sanitizeLunaParams({model:'gpt-4.1-mini',temperature:.1},{primaryModel:'gpt-5.6-luna',forcePrimaryModel:true});
      lunaCheck={temperaturePresent:Object.prototype.hasOwnProperty.call(p,'temperature')};
      if(lunaCheck.temperaturePresent)failures.push('LUNA_TEMPERATURE_NOT_REMOVED');
    }
  }

  return{
    version:VERSION,
    at:new Date().toISOString(),
    ok:failures.length===0,
    failures,
    loaded,
    optimizerCheck,
    lunaCheck,
    safety:{networkCalls:0,openAiCalls:0,etoroCalls:0,executionCalls:0,canTrade:false,canAuthorizeLive:false,secretsLogged:false}
  };
}

function assertComposition(){
  const result=inspectComposition();
  if(!result.ok){
    const error=new Error(`PRODUCTION_AI_PREFLIGHT_FAILED:${result.failures.join(',')}`);
    error.code='PRODUCTION_AI_PREFLIGHT_FAILED';
    error.preflight={version:result.version,failures:result.failures,loaded:result.loaded};
    throw error;
  }
  console.log(`[LEO_PRODUCTION_AI_PREFLIGHT] ${JSON.stringify({component:'LEO_PRODUCTION_AI_PREFLIGHT',version:VERSION,event:'PASSED',loaded:result.loaded,optimizerCheck:result.optimizerCheck,lunaCheck:result.lunaCheck,networkCalls:0,openAiCalls:0,etoroCalls:0,executionCalls:0,canTrade:false,canAuthorizeLive:false,secretsLogged:false})}`);
  return result;
}

global.__LEO_PRODUCTION_AI_PREFLIGHT__=inspectComposition;
if(process.env.LEO_PRODUCTION_AI_PREFLIGHT_AUTORUN!=='false')assertComposition();
module.exports={VERSION,inspectComposition,assertComposition};
