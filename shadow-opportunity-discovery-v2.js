'use strict';

/** LEO-AI SENTINEL — Stage 6 Opportunity Discovery Agent 2.1 (Shadow only). */
const VERSION='v10.24.5.2-opportunity-discovery-stage7-contract';
let stats={runs:0,assetsSeen:0,shortlisted:0,finalists:0,duplicatesRemoved:0,duplicateConflicts:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function clamp(n,min,max){const x=Number(n);return Number.isFinite(x)?Math.max(min,Math.min(max,x)):min;}
function safeObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
function safeDate(v){const t=v instanceof Date?v.getTime():Date.parse(v);return Number.isFinite(t)?new Date(t):new Date();}
function scoreAsset(asset){
  const a=safeObject(asset);
  const quality=clamp(num(a.dataQuality,0),0,1);const liquidity=clamp(num(a.liquidityScore,0),0,100);const momentum=clamp(num(a.momentumScore,0),-100,100);const trend=clamp(num(a.trendScore,0),-100,100);const spread=Math.max(0,num(a.spreadBps,999));const freshness=Math.max(0,num(a.ageSeconds,999999));
  if(quality<0.7||liquidity<50||spread>80||freshness>900)return {eligible:false,score:0,reason:'QUALITY_LIQUIDITY_OR_FRESHNESS_GATE'};
  const score=clamp(quality*25+liquidity*.25+Math.max(0,momentum)*.2+Math.max(0,trend)*.2-Math.min(20,spread*.12),0,100);
  return {eligible:true,score,reason:null};
}
function rowFor(symbol,a,s){const score=num(s.score,0);return{symbol,...s,discoveryScore:score,liquidityScore:num(a.liquidityScore),spreadBps:num(a.spreadBps),ageSeconds:Math.max(0,num(a.ageSeconds,999999)),momentumScore:num(a.momentumScore),trendScore:num(a.trendScore),dataQuality:num(a.dataQuality)};}
function discoverOpportunities(universe=[],options={}){
  const source=Array.isArray(universe)?universe:[];const opts=safeObject(options);
  const shortlistSize=Math.max(5,Math.min(50,Math.floor(num(opts.shortlistSize,25))));const finalistSize=Math.max(1,Math.min(15,Math.floor(num(opts.finalistSize,8))));const minimumFinalistScore=clamp(num(opts.minimumFinalistScore,65),0,100);
  const grouped=new Map();let duplicatesRemoved=0,duplicateConflicts=0;
  for(const raw of source){const a=safeObject(raw);const symbol=String(a.symbol||'').trim().toUpperCase();if(!symbol)continue;if(!grouped.has(symbol))grouped.set(symbol,[]);else duplicatesRemoved++;grouped.get(symbol).push(a);}
  const ranked=[];
  for(const [symbol,rows] of grouped){const scored=rows.map(a=>({a,s:scoreAsset(a)}));const eligibleStates=new Set(scored.map(x=>x.s.eligible));if(eligibleStates.size>1){duplicateConflicts++;ranked.push({symbol,eligible:false,score:0,discoveryScore:0,reason:'DUPLICATE_CONFLICT',liquidityScore:0,spreadBps:999,ageSeconds:999999,momentumScore:0,trendScore:0,dataQuality:0});continue;}const chosen=[...scored].sort((x,y)=>y.s.score-x.s.score)[0];ranked.push(rowFor(symbol,chosen.a,chosen.s));}
  ranked.sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));const eligible=ranked.filter(x=>x.eligible);const shortlist=eligible.slice(0,shortlistSize);const finalists=shortlist.filter(x=>x.score>=minimumFinalistScore).slice(0,finalistSize);
  stats.runs++;stats.assetsSeen+=ranked.length;stats.shortlisted+=shortlist.length;stats.finalists+=finalists.length;stats.duplicatesRemoved+=duplicatesRemoved;stats.duplicateConflicts+=duplicateConflicts;
  const result={version:VERSION,at:safeDate(opts.now).toISOString(),universeSize:ranked.length,rawUniverseSize:source.length,duplicatesRemoved,duplicateConflicts,eligibleCount:eligible.length,shortlist,finalists,rejectedCount:ranked.length-eligible.length,policy:{shortlistSize,finalistSize,minimumFinalistScore,fullUniverseAiCalls:0,finalistAiCalls:0},contracts:{stage7CandidateFields:['symbol','discoveryScore','dataQuality','liquidityScore','spreadBps','ageSeconds']},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,openAiCallsOnUniverse:0,networkClientPresent:false,executionCalls:0}};stats.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...stats},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,openAiCallsOnUniverse:0}};}
global.__LEO_OPPORTUNITY_DISCOVERY_V2_STATE__=getState;global.__LEO_OPPORTUNITY_DISCOVERY_V2_RUN__=discoverOpportunities;
module.exports={VERSION,scoreAsset,rowFor,discoverOpportunities,getState};
