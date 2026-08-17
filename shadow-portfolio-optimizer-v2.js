'use strict';

/** LEO-AI SENTINEL — Stage 14 Portfolio Optimizer 2.0 (Shadow only). */
const VERSION='v10.24.3-portfolio-optimizer-2';
let stats={runs:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function clamp(n,min,max){return Math.max(min,Math.min(max,Number(n)));}
function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function variance(a){if(a.length<2)return 0;const m=mean(a);return a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1);}
function covariance(a,b){const n=Math.min(a.length,b.length);if(n<2)return 0;const aa=a.slice(-n),bb=b.slice(-n),ma=mean(aa),mb=mean(bb);let s=0;for(let i=0;i<n;i++)s+=(aa[i]-ma)*(bb[i]-mb);return s/(n-1);}
function normalizeWeights(obj){const positive=Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,Math.max(0,num(v))]));const s=Object.values(positive).reduce((a,b)=>a+b,0);if(!s)return positive;return Object.fromEntries(Object.entries(positive).map(([k,v])=>[k,v/s]));}
function portfolioVariance(weights,returns){const syms=Object.keys(weights);let total=0;for(const a of syms)for(const b of syms)total+=weights[a]*weights[b]*covariance(returns[a]||[],returns[b]||[]);return Math.max(0,total);}

function optimizePortfolio(input={},options={}){
  const returns=input.returns||{};const expected=input.expectedReturns||{};const current=normalizeWeights(input.currentWeights||{});
  const symbols=[...new Set([...Object.keys(returns),...Object.keys(expected),...Object.keys(current)])].filter(Boolean);
  const maxWeight=clamp(options.maxWeight??0.25,0.05,0.6);const minObs=Math.max(5,Math.floor(options.minObservations??20));
  const scores={};const excluded=[];
  for(const s of symbols){const series=(returns[s]||[]).map(Number).filter(Number.isFinite);if(series.length<minObs){excluded.push({symbol:s,reason:'INSUFFICIENT_HISTORY'});continue;}const vol=Math.sqrt(variance(series));const er=num(expected[s],mean(series));const quality=clamp(num(input.dataQuality?.[s],1),0,1);const score=(Math.max(-0.05,er)+0.01)*quality/Math.max(vol,0.002);scores[s]=Math.max(0,score);}
  let target=normalizeWeights(scores);
  // iterative cap + redistribute
  for(let pass=0;pass<10;pass++){let excess=0;const free=[];for(const s of Object.keys(target)){if(target[s]>maxWeight){excess+=target[s]-maxWeight;target[s]=maxWeight;}else free.push(s);}if(excess<1e-9||!free.length)break;const denom=free.reduce((a,s)=>a+target[s],0)||free.length;for(const s of free)target[s]+=excess*(denom?target[s]/denom:1/free.length);}
  target=normalizeWeights(target);
  const currentAligned=Object.fromEntries(symbols.map(s=>[s,current[s]||0]));
  const turnover=0.5*symbols.reduce((sum,s)=>sum+Math.abs((target[s]||0)-(currentAligned[s]||0)),0);
  const currentVar=portfolioVariance(currentAligned,returns);const targetVar=portfolioVariance(target,returns);
  const marginal={};for(const s of Object.keys(target)){const bumped={...target,[s]:target[s]+0.01};const n=normalizeWeights(bumped);marginal[s]=Math.max(0,portfolioVariance(n,returns)-targetVar);}
  const concentration=Object.values(target).reduce((s,w)=>s+w*w,0);
  stats.runs+=1;
  const result={version:VERSION,at:new Date(options.now||Date.now()).toISOString(),status:Object.keys(target).length>=2?'READY_FOR_SHADOW_REVIEW':'INCONCLUSIVE',targetWeights:target,currentWeights:currentAligned,turnover,concentrationHhi:concentration,currentVolProxy:Math.sqrt(currentVar),targetVolProxy:Math.sqrt(targetVar),marginalVariance:marginal,excluded,constraints:{maxWeight,minObservations:minObs},safety:{shadowOnly:true,canTrade:false,canGenerateOrders:false,canAuthorizeLive:false,directLiveInfluence:false,openAiCalls:0,executionCalls:0}};
  stats.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...stats},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,directLiveInfluence:false}};}
global.__LEO_PORTFOLIO_OPTIMIZER_V2_STATE__=getState;global.__LEO_PORTFOLIO_OPTIMIZER_V2_RUN__=optimizePortfolio;
module.exports={VERSION,mean,variance,covariance,normalizeWeights,portfolioVariance,optimizePortfolio,getState};
