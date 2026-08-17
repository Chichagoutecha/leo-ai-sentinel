'use strict';

/**
 * LEO-AI SENTINEL v10.25.3 — Shadow Foundation Runtime Guard.
 *
 * Fail-closed compatibility boundary for Stage 3 Alpaca, Stage 4 Quartr and
 * Stage 5 Exa public/adaptor surfaces. It catches malformed-adapter runtime
 * exceptions without changing trading, LIVE, strategy, model or network policy.
 */
const VERSION='v10.25.3-foundation-runtime-guard';
const alpaca=require('./shadow-alpaca-validator');
const quartr=require('./shadow-quartr-fundamental-agent');
const exa=require('./shadow-exa-news-catalyst-agent');

const stats={caught:0,byComponent:{ALPACA:0,QUARTR:0,EXA:0},last:null};
function safeObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
function symbolFrom(v){const x=safeObject(v);return String(x.symbol||x.ticker||x.asset||'').trim().toUpperCase()||null;}
function record(component,operation,error){stats.caught++;stats.byComponent[component]=(stats.byComponent[component]||0)+1;stats.last={component,operation,errorName:String(error?.name||'Error').slice(0,80),at:new Date().toISOString()};}
function failReport(component,operation,input){return{version:VERSION,status:'INCONCLUSIVE',reason:`${component}_${operation}_RUNTIME_GUARD`,symbol:symbolFrom(input),canTrade:false,canAuthorizeLive:false,researchOnly:true,runtimeGuarded:true};}
function syncGuard(component,operation,fn,fallback){return(...args)=>{try{return fn(...args);}catch(error){record(component,operation,error);return fallback(error,args);}};}
function asyncGuard(component,operation,fn,fallback){return async(...args)=>{try{return await fn(...args);}catch(error){record(component,operation,error);return fallback(error,args);}};}

const raw={
  alpacaCompare:alpaca.compareMarketObservations,
  alpacaNormalizeEtoro:alpaca.normalizeEtoroObservation,
  alpacaNormalizeSnapshot:alpaca.normalizeAlpacaSnapshot,
  alpacaEvidence:alpaca.evidenceFromValidation,
  alpacaIngest:alpaca.ingestValidation,
  quartrNormalizeBundle:quartr.normalizeFundamentalBundle,
  quartrScore:quartr.scoreFundamentalBundle,
  quartrEvidence:quartr.evidenceFromFundamentalReport,
  quartrIngest:quartr.ingestFundamentalBundle,
  exaNormalize:exa.normalizeObservation,
  exaAnalyzeEvent:exa.analyzeEventGroup,
  exaAnalyzeBatch:exa.analyzeBatch,
  exaEvidence:exa.evidenceFromEventReport,
  exaIngest:exa.ingestBatch
};

alpaca.normalizeEtoroObservation=syncGuard('ALPACA','NORMALIZE_ETORO',raw.alpacaNormalizeEtoro,()=>null);
alpaca.normalizeAlpacaSnapshot=syncGuard('ALPACA','NORMALIZE_SNAPSHOT',raw.alpacaNormalizeSnapshot,()=>null);
alpaca.compareMarketObservations=syncGuard('ALPACA','COMPARE',raw.alpacaCompare,(_e,args)=>failReport('ALPACA','COMPARE',args[0]));
alpaca.evidenceFromValidation=syncGuard('ALPACA','EVIDENCE',raw.alpacaEvidence,()=>[]);
alpaca.ingestValidation=asyncGuard('ALPACA','INGEST',raw.alpacaIngest,(_e,args)=>({ok:false,reason:'ALPACA_INGEST_RUNTIME_GUARD',report:failReport('ALPACA','INGEST',args[0]),evidence:[],evidenceResults:[]}));

quartr.normalizeFundamentalBundle=syncGuard('QUARTR','NORMALIZE_BUNDLE',raw.quartrNormalizeBundle,()=>null);
quartr.scoreFundamentalBundle=syncGuard('QUARTR','SCORE',raw.quartrScore,(_e,args)=>failReport('QUARTR','SCORE',args[0]));
quartr.evidenceFromFundamentalReport=syncGuard('QUARTR','EVIDENCE',raw.quartrEvidence,()=>[]);
quartr.ingestFundamentalBundle=asyncGuard('QUARTR','INGEST',raw.quartrIngest,(_e,args)=>({ok:false,reason:'QUARTR_INGEST_RUNTIME_GUARD',report:failReport('QUARTR','INGEST',args[0]),evidence:[],evidenceResults:[]}));

exa.normalizeObservation=syncGuard('EXA','NORMALIZE',raw.exaNormalize,()=>null);
exa.analyzeEventGroup=syncGuard('EXA','ANALYZE_EVENT',raw.exaAnalyzeEvent,(_e,args)=>failReport('EXA','ANALYZE_EVENT',Array.isArray(args[0])?args[0][0]:args[0]));
exa.analyzeBatch=syncGuard('EXA','ANALYZE_BATCH',raw.exaAnalyzeBatch,()=>[]);
exa.evidenceFromEventReport=syncGuard('EXA','EVIDENCE',raw.exaEvidence,()=>[]);
exa.ingestBatch=asyncGuard('EXA','INGEST',raw.exaIngest,()=>({ok:false,reason:'EXA_INGEST_RUNTIME_GUARD',reports:[],evidence:[],evidenceResults:[]}));

// Replace the runtime adapter globals with guarded public boundaries.
global.__LEO_ALPACA_VALIDATE__=alpaca.ingestValidation;
global.__LEO_QUARTR_FUNDAMENTAL_INGEST__=quartr.ingestFundamentalBundle;
global.__LEO_EXA_CATALYST_INGEST__=exa.ingestBatch;
global.__LEO_FOUNDATION_RUNTIME_GUARD_STATE__=()=>({version:VERSION,stats:{caught:stats.caught,byComponent:{...stats.byComponent},last:stats.last},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,networkCalls:0,openAiCalls:0,executionCalls:0,livePromotionAllowed:false}});

console.log(`[LEO_FOUNDATION_RUNTIME_GUARD] ${JSON.stringify({component:'LEO_FOUNDATION_RUNTIME_GUARD',version:VERSION,event:'STARTED',canTrade:false,canAuthorizeLive:false,networkCalls:0,openAiCalls:0,executionCalls:0,secretsLogged:false})}`);

module.exports={VERSION,alpaca,quartr,exa,failReport,getState:global.__LEO_FOUNDATION_RUNTIME_GUARD_STATE__};
