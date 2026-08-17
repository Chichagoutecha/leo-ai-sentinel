'use strict';

/** LEO-AI SENTINEL — Stage 14 Portfolio Optimizer 2.1 (Shadow only). */
const VERSION='v10.24.3.1-portfolio-optimizer-2-constraint-safe';
let stats={runs:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function clamp(n,min,max){return Math.max(min,Math.min(max,Number(n)));}
function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function variance(a){if(a.length<2)return 0;const m=mean(a);return a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1);}
function covariance(a,b){const n=Math.min(a.length,b.length);if(n<2)return 0;const aa=a.slice(-n),bb=b.slice(-n),ma=mean(aa),mb=mean(bb);let s=0;for(let i=0;i<n;i++)s+=(aa[i]-ma)*(bb[i]-mb);return s/(n-1);}
function normalizeWeights(obj){const positive=Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,Math.max(0,num(v))]));const s=Object.values(positive).reduce((a,b)=>a+b,0);if(!s)return positive;return Object.fromEntries(Object.entries(positive).map(([k,v])=>[k,v/s]));}
function portfolioVariance(weights,returns){const syms=Object.keys(weights);let total=0;for(const a of syms)for(const b of syms)total+=weights[a]*weights[b]*covariance(returns[a]||[],returns[b]||[]);return Math.max(0,total);}

function cappedNormalize(scores,maxWeight){
  const positive=Object.fromEntries(Object.entries(scores||{}).filter(([,v])=>num(v)>0).map(([k,v])=>[k,num(v)]));
  const symbols=Object.keys(positive);
  const requiredAssets=Math.ceil((1-1e-12)/maxWeight);
  if(symbols.length<requiredAssets){
    return {ok:false,reason:'CONSTRAINT_INFEASIBLE',requiredAssets,eligibleAssets:symbols.length,weights:{}};
  }
  const out=Object.fromEntries(symbols.map(s=>[s,0]));
  let remaining=1;
  let active=[...symbols];
  for(let pass=0;pass<symbols.length+2&&active.length;pass++){
    const denom=active.reduce((sum,s)=>sum+positive[s],0);
    if(!(denom>0)) return {ok:false,reason:'NO_POSITIVE_SCORES',requiredAssets,eligibleAssets:symbols.length,weights:{}};
    const proposed=Object.fromEntries(active.map(s=>[s,remaining*(positive[s]/denom)]));
    const capped=active.filter(s=>proposed[s]>maxWeight+1e-12);
    if(!capped.length){for(const s of active)out[s]=proposed[s];remaining=0;break;}
    for(const s of capped){out[s]=maxWeight;remaining-=maxWeight;}
    active=active.filter(s=>!capped.includes(s));
    if(remaining<-1e-9) return {ok:false,reason:'NUMERIC_CAP_FAILURE',requiredAssets,eligibleAssets:symbols.length,weights:{}};
  }
  const sum=Object.values(out).reduce((a,b)=>a+b,0);
  const maxObserved=Math.max(0,...Object.values(out));
  if(Math.abs(sum-1)>1e-8||maxObserved>maxWeight+1e-8){
    return {ok:false,reason:'CAP_ALLOCATION_FAILED',requiredAssets,eligibleAssets:symbols.length,weights:out,sum,maxObserved};
  }
  return {ok:true,reason:null,requiredAssets,eligibleAssets:symbols.length,weights:out,sum,maxObserved};
}

function optimizePortfolio(input={},options={}){
  const returns=input.returns||{};const expected=input.expectedReturns||{};const current=normalizeWeights(input.currentWeights||{});
  const symbols=[...new Set([...Object.keys(returns),...Object.keys(expected),...Object.keys(current)])].filter(Boolean);
  const maxWeight=clamp(options.maxWeight??0.25,0.05,0.6);const minObs=Math.max(5,Math.floor(options.minObservations??20));
  const scores={};const excluded=[];
  for(const s of symbols){const series=(returns[s]||[]).map(Number).filter(Number.isFinite);if(series.length<minObs){excluded.push({symbol:s,reason:'INSUFFICIENT_HISTORY'});continue;}const vol=Math.sqrt(variance(series));const er=num(expected[s],mean(series));const quality=clamp(num(input.dataQuality?.[s],1),0,1);const score=(Math.max(-0.05,er)+0.01)*quality/Math.max(vol,0.002);scores[s]=Math.max(0,score);}
  const allocation=cappedNormalize(scores,maxWeight);
  if(!allocation.ok){
    const result={version:VERSION,at:new Date(options.now||Date.now()).toISOString(),status:'INCONCLUSIVE',reason:allocation.reason,targetWeights:{},currentWeights:Object.fromEntries(symbols.map(s=>[s,current[s]||0])),turnover:null,concentrationHhi:null,currentVolProxy:null,targetVolProxy:null,marginalVariance:{},excluded,constraints:{maxWeight,minObservations:minObs,requiredAssets:allocation.requiredAssets,eligibleAssets:allocation.eligibleAssets},safety:{shadowOnly:true,canTrade:false,canGenerateOrders:false,canAuthorizeLive:false,directLiveInfluence:false,openAiCalls:0,executionCalls:0}};
    stats.runs+=1;stats.last=result;return result;
  }
  const target=allocation.weights;
  const currentAligned=Object.fromEntries(symbols.map(s=>[s,current[s]||0]));
  const turnover=0.5*symbols.reduce((sum,s)=>sum+Math.abs((target[s]||0)-(currentAligned[s]||0)),0);
  const currentVar=portfolioVariance(currentAligned,returns);const targetVar=portfolioVariance(target,returns);
  const marginal={};for(const s of Object.keys(target)){const bumped={...target,[s]:target[s]+0.01};const n=normalizeWeights(bumped);marginal[s]=Math.max(0,portfolioVariance(n,returns)-targetVar);}
  const concentration=Object.values(target).reduce((s,w)=>s+w*w,0);
  const maxObservedWeight=Math.max(0,...Object.values(target));
  stats.runs+=1;
  const result={version:VERSION,at:new Date(options.now||Date.now()).toISOString(),status:Object.keys(target).length>=2&&maxObservedWeight<=maxWeight+1e-8?'READY_FOR_SHADOW_REVIEW':'INCONCLUSIVE',targetWeights:target,currentWeights:currentAligned,turnover,concentrationHhi:concentration,currentVolProxy:Math.sqrt(currentVar),targetVolProxy:Math.sqrt(targetVar),marginalVariance:marginal,excluded,constraints:{maxWeight,minObservations:minObs,requiredAssets:allocation.requiredAssets,eligibleAssets:allocation.eligibleAssets,maxObservedWeight},safety:{shadowOnly:true,canTrade:false,canGenerateOrders:false,canAuthorizeLive:false,directLiveInfluence:false,openAiCalls:0,executionCalls:0}};
  stats.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...stats},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,directLiveInfluence:false}};}
global.__LEO_PORTFOLIO_OPTIMIZER_V2_STATE__=getState;global.__LEO_PORTFOLIO_OPTIMIZER_V2_RUN__=optimizePortfolio;
module.exports={VERSION,mean,variance,covariance,normalizeWeights,portfolioVariance,cappedNormalize,optimizePortfolio,getState};