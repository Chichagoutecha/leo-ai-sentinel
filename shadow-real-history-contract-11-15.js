'use strict';

/**
 * LEO-AI SENTINEL — Real-history contract for stages 11-15 (Shadow only)
 * Validates provenance, point-in-time availability and deterministic walk-forward splits.
 * No provider client, no OpenAI, no eToro, no LIVE authority.
 */
const VERSION='v10.25.7-real-history-contract-11-15';
const MIN_TRAIN_ROWS=20;
const MIN_TEST_ROWS=5;

function safeObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
function iso(v){const t=Date.parse(v);return Number.isFinite(t)?new Date(t).toISOString():null;}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function clean(v,max=180){return String(v??'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);}

function normalizeProvenance(raw){
  const p=safeObject(raw);
  return {
    provider:clean(p.provider,80),
    dataset:clean(p.dataset,120),
    symbol:clean(p.symbol,32).toUpperCase(),
    field:clean(p.field,80),
    observedAt:iso(p.observedAt),
    availableAt:iso(p.availableAt),
    retrievedAt:iso(p.retrievedAt),
    sourceClass:clean(p.sourceClass||'UNKNOWN',40).toUpperCase(),
    revision:clean(p.revision||'UNSPECIFIED',80)
  };
}

function validateProvenance(raw,rowAt){
  const p=normalizeProvenance(raw); const at=iso(rowAt);
  if(!p.provider||!p.dataset||!p.field)return{ok:false,reason:'MISSING_PROVENANCE_IDENTITY',provenance:p};
  if(!p.observedAt||!p.availableAt||!p.retrievedAt||!at)return{ok:false,reason:'INVALID_PROVENANCE_TIME',provenance:p};
  if(Date.parse(p.availableAt)>Date.parse(at))return{ok:false,reason:'LOOKAHEAD_AVAILABILITY',provenance:p,rowAt:at};
  if(Date.parse(p.observedAt)>Date.parse(p.availableAt))return{ok:false,reason:'OBSERVED_AFTER_AVAILABLE',provenance:p};
  if(Date.parse(p.retrievedAt)<Date.parse(p.availableAt))return{ok:false,reason:'RETRIEVED_BEFORE_AVAILABLE',provenance:p};
  return{ok:true,reason:null,provenance:p};
}

function validateRealHistoryRows(rows){
  if(!Array.isArray(rows)||rows.length<MIN_TRAIN_ROWS+MIN_TEST_ROWS)return{ok:false,reason:'INSUFFICIENT_REAL_HISTORY_ROWS',rows:Array.isArray(rows)?rows.length:0};
  let previous=-Infinity; const seen=new Set();
  for(let i=0;i<rows.length;i++){
    const row=safeObject(rows[i]); const at=iso(row.at); if(!at)return{ok:false,reason:'INVALID_ROW_TIMESTAMP',index:i};
    const ms=Date.parse(at); if(seen.has(ms))return{ok:false,reason:'DUPLICATE_ROW_TIMESTAMP',index:i};
    if(ms<=previous)return{ok:false,reason:'NON_MONOTONIC_ROW_TIME',index:i}; seen.add(ms); previous=ms;
    const provenance=Array.isArray(row.provenance)?row.provenance:[];
    if(!provenance.length)return{ok:false,reason:'MISSING_ROW_PROVENANCE',index:i};
    for(let j=0;j<provenance.length;j++){
      const check=validateProvenance(provenance[j],at); if(!check.ok)return{ok:false,reason:check.reason,index:i,provenanceIndex:j,detail:check};
    }
    for(const [symbol,series] of Object.entries(safeObject(row.returns))){
      if(!Array.isArray(series)||!series.length||series.some(v=>finite(v)==null))return{ok:false,reason:'INVALID_RETURN_SERIES',index:i,symbol};
    }
  }
  return{ok:true,reason:null,rows:rows.length};
}

function buildWalkForwardSplits(rows,options={}){
  const check=validateRealHistoryRows(rows); if(!check.ok)return{status:'INCONCLUSIVE',reason:check.reason,validation:check,splits:[]};
  const o=safeObject(options); const train=Math.max(MIN_TRAIN_ROWS,Math.floor(finite(o.trainRows)??60));
  const test=Math.max(MIN_TEST_ROWS,Math.floor(finite(o.testRows)??10));
  const step=Math.max(1,Math.floor(finite(o.stepRows)??test));
  const expanding=o.expanding!==false; const splits=[];
  for(let testStart=train;testStart+test<=rows.length;testStart+=step){
    const trainStart=expanding?0:Math.max(0,testStart-train);
    const trainEnd=testStart;
    const testEnd=testStart+test;
    const trainRows=rows.slice(trainStart,trainEnd); const testRows=rows.slice(testStart,testEnd);
    if(Date.parse(trainRows[trainRows.length-1].at)>=Date.parse(testRows[0].at))return{status:'INCONCLUSIVE',reason:'SPLIT_TIME_OVERLAP',validation:check,splits:[]};
    splits.push({id:`wf-${splits.length+1}`,trainStart,trainEndExclusive:trainEnd,testStart,testEndExclusive:testEnd,trainRows:trainRows.length,testRows:testRows.length,trainLastAt:iso(trainRows[trainRows.length-1].at),testFirstAt:iso(testRows[0].at),testLastAt:iso(testRows[testRows.length-1].at)});
  }
  if(!splits.length)return{status:'INCONCLUSIVE',reason:'NO_WALK_FORWARD_SPLITS',validation:check,splits:[]};
  return{version:VERSION,status:'READY_FOR_PROVIDER_DATA',reason:null,validation:check,config:{trainRows:train,testRows:test,stepRows:step,expanding},splits,safety:{shadowOnly:true,networkCalls:0,openAiCalls:0,executionCalls:0,canTrade:false,canAuthorizeLive:false,livePromotionAllowed:false}};
}

function summarizeProviderCoverage(rows){
  const providers=new Map();
  for(const row of Array.isArray(rows)?rows:[])for(const raw of Array.isArray(row?.provenance)?row.provenance:[]){const p=normalizeProvenance(raw);if(!p.provider)continue;const x=providers.get(p.provider)||{provider:p.provider,records:0,datasets:new Set(),fields:new Set(),symbols:new Set()};x.records++;if(p.dataset)x.datasets.add(p.dataset);if(p.field)x.fields.add(p.field);if(p.symbol)x.symbols.add(p.symbol);providers.set(p.provider,x);}
  return [...providers.values()].map(x=>({provider:x.provider,records:x.records,datasets:[...x.datasets].sort(),fields:[...x.fields].sort(),symbols:[...x.symbols].sort()})).sort((a,b)=>a.provider.localeCompare(b.provider));
}

global.__LEO_REAL_HISTORY_CONTRACT_11_15__={validateRealHistoryRows,buildWalkForwardSplits,summarizeProviderCoverage};
module.exports={VERSION,MIN_TRAIN_ROWS,MIN_TEST_ROWS,normalizeProvenance,validateProvenance,validateRealHistoryRows,buildWalkForwardSplits,summarizeProviderCoverage};
