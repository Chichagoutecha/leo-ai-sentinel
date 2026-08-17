'use strict';

/** LEO-AI SENTINEL — Stage 7 Dynamic Universe Manager (Shadow only). */
const VERSION='v10.24.6-dynamic-universe-manager';
let state={runs:0,audit:[],last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function safeSymbol(v){return String(v||'').trim().toUpperCase().replace(/[^A-Z0-9.\-\/]/g,'').slice(0,24);}
function eligibility(c,policy){
  if(num(c.dataQuality)<policy.minDataQuality)return 'LOW_DATA_QUALITY';
  if(num(c.liquidityScore)<policy.minLiquidityScore)return 'LOW_LIQUIDITY';
  if(num(c.spreadBps,999)>policy.maxSpreadBps)return 'WIDE_SPREAD';
  if(num(c.ageSeconds,999999)>policy.maxAgeSeconds)return 'STALE';
  if(c.quarantined===true)return 'QUARANTINED';
  return null;
}
function manageUniverse(current=[],candidates=[],options={}){
  const policy={minDataQuality:num(options.minDataQuality,.75),minLiquidityScore:num(options.minLiquidityScore,55),maxSpreadBps:num(options.maxSpreadBps,70),maxAgeSeconds:num(options.maxAgeSeconds,900),maxUniverse:Math.max(10,Math.min(300,Math.floor(options.maxUniverse??120))),minPersistenceRuns:Math.max(1,Math.floor(options.minPersistenceRuns??3))};
  const currentMap=new Map(current.map(x=>[safeSymbol(x.symbol||x),typeof x==='object'?{...x,symbol:safeSymbol(x.symbol)}:{symbol:safeSymbol(x),persistenceRuns:policy.minPersistenceRuns}]).filter(([s])=>s));
  const scored=[];for(const raw of candidates){const symbol=safeSymbol(raw?.symbol);if(!symbol)continue;const reason=eligibility(raw,policy);const score=Math.max(0,num(raw.discoveryScore,0));scored.push({symbol,score,reason,persistenceRuns:Math.max(0,Math.floor(num(raw.persistenceRuns,0))),raw});}
  scored.sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));
  const next=new Map(currentMap);const changes=[];
  for(const c of scored){if(c.reason){if(next.has(c.symbol)&&c.raw.removeIfIneligible===true){next.delete(c.symbol);changes.push({symbol:c.symbol,action:'REMOVE',reason:c.reason});}continue;}if(!next.has(c.symbol)&&c.persistenceRuns>=policy.minPersistenceRuns){next.set(c.symbol,{symbol:c.symbol,addedBy:'DYNAMIC_SHADOW',discoveryScore:c.score});changes.push({symbol:c.symbol,action:'ADD',reason:'ELIGIBLE_PERSISTENT_CANDIDATE'});} }
  if(next.size>policy.maxUniverse){const removable=[...next.values()].filter(x=>x.addedBy==='DYNAMIC_SHADOW').sort((a,b)=>num(a.discoveryScore)-num(b.discoveryScore));while(next.size>policy.maxUniverse&&removable.length){const x=removable.shift();next.delete(x.symbol);changes.push({symbol:x.symbol,action:'REMOVE',reason:'UNIVERSE_CAP'});} }
  state.runs++;state.audit.push(...changes.map(c=>({...c,at:new Date(options.now||Date.now()).toISOString()})));state.audit=state.audit.slice(-500);
  const result={version:VERSION,at:new Date(options.now||Date.now()).toISOString(),universe:[...next.values()],changes,policy,safety:{shadowOnly:true,canModifyLiveUniverse:false,canTrade:false,canAuthorizeLive:false,automaticLivePromotion:false,executionCalls:0,openAiCalls:0}};state.last=result;return result;
}
function getState(){return{version:VERSION,stats:{runs:state.runs,auditCount:state.audit.length,last:state.last},audit:state.audit.slice(-50),safety:{shadowOnly:true,canModifyLiveUniverse:false,canTrade:false,canAuthorizeLive:false}};}
global.__LEO_DYNAMIC_UNIVERSE_STATE__=getState;global.__LEO_DYNAMIC_UNIVERSE_RUN__=manageUniverse;
module.exports={VERSION,eligibility,manageUniverse,getState};
