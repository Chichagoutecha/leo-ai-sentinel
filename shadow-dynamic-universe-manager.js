'use strict';

/** LEO-AI SENTINEL — Stage 7 Dynamic Universe Manager 1.1 (Shadow only). */
const VERSION='v10.24.6.1-dynamic-universe-runtime-safe';
let state={runs:0,audit:[],last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function clamp(v,min,max,fallback=min){const n=Number(v);const x=Number.isFinite(n)?n:Number(fallback);return Math.max(min,Math.min(max,x));}
function safeObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
function safeDate(v){const t=v instanceof Date?v.getTime():Date.parse(v);return Number.isFinite(t)?new Date(t):new Date();}
function safeSymbol(v){return String(v||'').trim().toUpperCase().replace(/[^A-Z0-9.\-\/]/g,'').slice(0,24);}
function eligibility(candidate,policy){
  const c=safeObject(candidate),p=safeObject(policy);
  if(num(c.dataQuality)<num(p.minDataQuality,.75))return 'LOW_DATA_QUALITY';
  if(num(c.liquidityScore)<num(p.minLiquidityScore,55))return 'LOW_LIQUIDITY';
  if(num(c.spreadBps,999)>num(p.maxSpreadBps,70))return 'WIDE_SPREAD';
  if(num(c.ageSeconds,999999)>num(p.maxAgeSeconds,900))return 'STALE';
  if(c.quarantined===true)return 'QUARANTINED';
  return null;
}
function manageUniverse(current=[],candidates=[],options={}){
  const opts=safeObject(options);
  const policy={
    minDataQuality:clamp(opts.minDataQuality,0,1,.75),
    minLiquidityScore:clamp(opts.minLiquidityScore,0,100,55),
    maxSpreadBps:clamp(opts.maxSpreadBps,1,10000,70),
    maxAgeSeconds:clamp(opts.maxAgeSeconds,1,86400,900),
    maxUniverse:Math.max(10,Math.min(300,Math.floor(num(opts.maxUniverse,120)))),
    minPersistenceRuns:Math.max(1,Math.min(100,Math.floor(num(opts.minPersistenceRuns,3))))
  };
  const currentRows=Array.isArray(current)?current:[];
  const currentMap=new Map();
  for(const raw of currentRows){const obj=typeof raw==='string'?{symbol:raw,persistenceRuns:policy.minPersistenceRuns}:safeObject(raw);const symbol=safeSymbol(obj.symbol||raw);if(!symbol)continue;currentMap.set(symbol,{...obj,symbol});}

  const candidateRows=Array.isArray(candidates)?candidates:[];
  const grouped=new Map();let duplicateCandidates=0;
  for(const raw of candidateRows){const obj=safeObject(raw);const symbol=safeSymbol(obj.symbol);if(!symbol)continue;if(!grouped.has(symbol))grouped.set(symbol,[]);else duplicateCandidates++;grouped.get(symbol).push(obj);}
  const scored=[];
  for(const [symbol,rows] of grouped){
    const reasons=rows.map(r=>eligibility(r,policy)).filter(Boolean);
    const reason=reasons.length?reasons[0]:null;
    const score=Math.max(0,...rows.map(r=>num(r.discoveryScore,0)));
    const persistenceRuns=Math.max(0,Math.floor(Math.min(...rows.map(r=>num(r.persistenceRuns,0)))));
    const removeIfIneligible=rows.some(r=>r.removeIfIneligible===true);
    scored.push({symbol,score,reason,persistenceRuns,raw:{...rows[0],removeIfIneligible},duplicateCount:rows.length});
  }
  scored.sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));
  const next=new Map(currentMap);const changes=[];
  for(const c of scored){
    if(c.reason){if(next.has(c.symbol)&&c.raw.removeIfIneligible===true){next.delete(c.symbol);changes.push({symbol:c.symbol,action:'REMOVE',reason:c.reason});}continue;}
    if(!next.has(c.symbol)&&c.persistenceRuns>=policy.minPersistenceRuns){next.set(c.symbol,{symbol:c.symbol,addedBy:'DYNAMIC_SHADOW',discoveryScore:c.score});changes.push({symbol:c.symbol,action:'ADD',reason:'ELIGIBLE_PERSISTENT_CANDIDATE'});}
  }
  if(next.size>policy.maxUniverse){const removable=[...next.values()].filter(x=>x.addedBy==='DYNAMIC_SHADOW').sort((a,b)=>num(a.discoveryScore)-num(b.discoveryScore)||String(a.symbol).localeCompare(String(b.symbol)));while(next.size>policy.maxUniverse&&removable.length){const x=removable.shift();next.delete(x.symbol);changes.push({symbol:x.symbol,action:'REMOVE',reason:'UNIVERSE_CAP'});} }
  const status=next.size>policy.maxUniverse?'UNIVERSE_CAP_UNRESOLVED':'READY_FOR_SHADOW_REVIEW';
  const at=safeDate(opts.now).toISOString();
  state.runs++;state.audit.push(...changes.map(c=>({...c,at})));state.audit=state.audit.slice(-500);
  const result={version:VERSION,at,status,universe:[...next.values()],changes,duplicatesCollapsed:duplicateCandidates,policy,unresolvedOverflow:Math.max(0,next.size-policy.maxUniverse),safety:{shadowOnly:true,canModifyLiveUniverse:false,canTrade:false,canAuthorizeLive:false,automaticLivePromotion:false,executionCalls:0,openAiCalls:0}};state.last=result;return result;
}
function getState(){return{version:VERSION,stats:{runs:state.runs,auditCount:state.audit.length,last:state.last},audit:state.audit.slice(-50),safety:{shadowOnly:true,canModifyLiveUniverse:false,canTrade:false,canAuthorizeLive:false}};}
global.__LEO_DYNAMIC_UNIVERSE_STATE__=getState;global.__LEO_DYNAMIC_UNIVERSE_RUN__=manageUniverse;
module.exports={VERSION,eligibility,manageUniverse,getState};
