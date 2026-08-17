'use strict';

/** LEO-AI SENTINEL — Stage 6 Opportunity Discovery Agent 2.0 (Shadow only). */
const VERSION='v10.24.5-opportunity-discovery-2';
let stats={runs:0,assetsSeen:0,shortlisted:0,finalists:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function clamp(n,min,max){return Math.max(min,Math.min(max,Number(n)));}
function scoreAsset(a){
  const quality=clamp(num(a.dataQuality,0),0,1);const liquidity=clamp(num(a.liquidityScore,0),0,100);const momentum=clamp(num(a.momentumScore,0),-100,100);const trend=clamp(num(a.trendScore,0),-100,100);const spread=Math.max(0,num(a.spreadBps,999));const freshness=Math.max(0,num(a.ageSeconds,999999));
  if(quality<0.7||liquidity<50||spread>80||freshness>900)return {eligible:false,score:0,reason:'QUALITY_LIQUIDITY_OR_FRESHNESS_GATE'};
  const score=clamp(quality*25+liquidity*.25+Math.max(0,momentum)*.2+Math.max(0,trend)*.2-Math.min(20,spread*.12),0,100);
  return {eligible:true,score,reason:null};
}
function discoverOpportunities(universe=[],options={}){
  const shortlistSize=Math.max(5,Math.min(50,Math.floor(options.shortlistSize??25)));const finalistSize=Math.max(1,Math.min(15,Math.floor(options.finalistSize??8)));
  const ranked=[];for(const raw of universe){const symbol=String(raw?.symbol||'').trim().toUpperCase();if(!symbol)continue;const s=scoreAsset(raw);ranked.push({symbol,...s,liquidityScore:num(raw.liquidityScore),spreadBps:num(raw.spreadBps),momentumScore:num(raw.momentumScore),trendScore:num(raw.trendScore),dataQuality:num(raw.dataQuality)});}
  ranked.sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));const eligible=ranked.filter(x=>x.eligible);const shortlist=eligible.slice(0,shortlistSize);const finalists=shortlist.filter(x=>x.score>=num(options.minimumFinalistScore,65)).slice(0,finalistSize);
  stats.runs++;stats.assetsSeen+=ranked.length;stats.shortlisted+=shortlist.length;stats.finalists+=finalists.length;
  const result={version:VERSION,at:new Date(options.now||Date.now()).toISOString(),universeSize:ranked.length,eligibleCount:eligible.length,shortlist,finalists,rejectedCount:ranked.length-eligible.length,policy:{shortlistSize,finalistSize,fullUniverseAiCalls:0,finalistAiCalls:0},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,openAiCallsOnUniverse:0,networkClientPresent:false,executionCalls:0}};stats.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...stats},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,openAiCallsOnUniverse:0}};}
global.__LEO_OPPORTUNITY_DISCOVERY_V2_STATE__=getState;global.__LEO_OPPORTUNITY_DISCOVERY_V2_RUN__=discoverOpportunities;
module.exports={VERSION,scoreAsset,discoverOpportunities,getState};
