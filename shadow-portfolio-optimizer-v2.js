'use strict';

/** LEO-AI SENTINEL — Stage 14 Portfolio Optimizer 2.2 (Shadow only). */
const VERSION='v10.24.3.2-portfolio-optimizer-runtime-safe';
let stats={runs:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function clamp(n,min,max){const x=Number(n);return Number.isFinite(x)?Math.max(min,Math.min(max,x)):min;}
function safeObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
function safeDate(v){const t=v instanceof Date?v.getTime():Date.parse(v);return Number.isFinite(t)?new Date(t):new Date();}
function numericSeries(v){return Array.isArray(v)?v.map(Number).filter(Number.isFinite):[];}
function mean(a){const x=numericSeries(a);return x.length?x.reduce((p,q)=>p+q,0)/x.length:0;}
function variance(a){const x=numericSeries(a);if(x.length<2)return 0;const m=x.reduce((p,q)=>p+q,0)/x.length;return x.reduce((s,v)=>s+(v-m)**2,0)/(x.length-1);}
function covariance(a,b){const aa=Array.isArray(a)?a:[],bb=Array.isArray(b)?b:[];const n=Math.min(aa.length,bb.length);if(n<2)return 0;const pairs=[];for(let i=0;i<n;i++){const x=Number(aa[aa.length-n+i]),y=Number(bb[bb.length-n+i]);if(Number.isFinite(x)&&Number.isFinite(y))pairs.push([x,y]);}if(pairs.length<2)return 0;const ma=pairs.reduce((s,p)=>s+p[0],0)/pairs.length,mb=pairs.reduce((s,p)=>s+p[1],0)/pairs.length;let total=0;for(const [x,y] of pairs)total+=(x-ma)*(y-mb);return total/(pairs.length-1);}
function normalizeWeights(obj){const safe=safeObject(obj);const positive=Object.fromEntries(Object.entries(safe).map(([k,v])=>[k,Math.max(0,num(v))]));const s=Object.values(positive).reduce((a,b)=>a+b,0);if(!s)return positive;return Object.fromEntries(Object.entries(positive).map(([k,v])=>[k,v/s]));}
function portfolioVariance(weights,returns){const w=safeObject(weights),r=safeObject(returns);const syms=Object.keys(w).filter(s=>w[s]>0);let total=0;for(const a of syms)for(const b of syms)total+=w[a]*w[b]*covariance(r[a],r[b]);return Number.isFinite(total)?Math.max(0,total):0;}

function cappedNormalize(scores,maxWeight){
  const safe=safeObject(scores);const cap=clamp(num(maxWeight,.25),.05,.6);
  const positive=Object.fromEntries(Object.entries(safe).filter(([,v])=>num(v)>0).map(([k,v])=>[k,num(v)]));
  const symbols=Object.keys(positive);
  const requiredAssets=Math.ceil((1-1e-12)/cap);
  if(symbols.length<requiredAssets){
    return {ok:false,reason:'CONSTRAINT_INFEASIBLE',requiredAssets,eligibleAssets:symbols.length,weights:{},maxWeight:cap};
  }
  const out=Object.fromEntries(symbols.map(s=>[s,0]));
  let remaining=1;
  let active=[...symbols];
  for(let pass=0;pass<symbols.length+2&&active.length;pass++){
    const denom=active.reduce((sum,s)=>sum+positive[s],0);
    if(!(denom>0)) return {ok:false,reason:'NO_POSITIVE_SCORES',requiredAssets,eligibleAssets:symbols.length,weights:{},maxWeight:cap};
    const proposed=Object.fromEntries(active.map(s=>[s,remaining*(positive[s]/denom)]));
    const capped=active.filter(s=>proposed[s]>cap+1e-12);
    if(!capped.length){for(const s of active)out[s]=proposed[s];remaining=0;break;}
    for(const s of capped){out[s]=cap;remaining-=cap;}
    active=active.filter(s=>!capped.includes(s));
    if(remaining<-1e-9) return {ok:false,reason:'NUMERIC_CAP_FAILURE',requiredAssets,eligibleAssets:symbols.length,weights:{},maxWeight:cap};
  }
  const sum=Object.values(out).reduce((a,b)=>a+b,0);
  const maxObserved=Math.max(0,...Object.values(out));
  if(Math.abs(sum-1)>1e-8||maxObserved>cap+1e-8){
    return {ok:false,reason:'CAP_ALLOCATION_FAILED',requiredAssets,eligibleAssets:symbols.length,weights:out,sum,maxObserved,maxWeight:cap};
  }
  return {ok:true,reason:null,requiredAssets,eligibleAssets:symbols.length,weights:out,sum,maxObserved,maxWeight:cap};
}

function optimizePortfolio(input={},options={}){
  const safeInput=safeObject(input),safeOptions=safeObject(options);
  const returns=safeObject(safeInput.returns),expected=safeObject(safeInput.expectedReturns),current=normalizeWeights(safeInput.currentWeights);
  const symbols=[...new Set([...Object.keys(returns),...Object.keys(expected),...Object.keys(current)])].filter(Boolean);
  const maxWeight=clamp(num(safeOptions.maxWeight,.25),.05,.6);const minObs=Math.max(5,Math.floor(num(safeOptions.minObservations,20)));
  const scores={};const excluded=[];
  for(const s of symbols){const series=numericSeries(returns[s]);if(series.length<minObs){excluded.push({symbol:s,reason:'INSUFFICIENT_HISTORY',observations:series.length});continue;}const vol=Math.sqrt(variance(series));const er=num(expected[s],mean(series));const quality=clamp(num(safeInput.dataQuality?.[s],1),0,1);const score=(Math.max(-0.05,er)+0.01)*quality/Math.max(vol,0.002);scores[s]=Math.max(0,score);}
  const allocation=cappedNormalize(scores,maxWeight);
  const currentAligned=Object.fromEntries(symbols.map(s=>[s,current[s]||0]));
  const incompleteCurrent=Object.entries(currentAligned).filter(([,w])=>w>0).map(([symbol])=>({symbol,observations:numericSeries(returns[symbol]).length})).filter(x=>x.observations<minObs);
  if(!allocation.ok||incompleteCurrent.length){
    const reason=!allocation.ok?allocation.reason:'INCOMPLETE_CURRENT_PORTFOLIO_HISTORY';
    const result={version:VERSION,at:safeDate(safeOptions.now).toISOString(),status:'INCONCLUSIVE',reason,targetWeights:{},currentWeights:currentAligned,turnover:null,concentrationHhi:null,currentVolProxy:null,targetVolProxy:null,marginalVariance:{},excluded,incompleteCurrentHistory:incompleteCurrent,constraints:{maxWeight,minObservations:minObs,requiredAssets:allocation.requiredAssets,eligibleAssets:allocation.eligibleAssets},safety:{shadowOnly:true,canTrade:false,canGenerateOrders:false,canAuthorizeLive:false,directLiveInfluence:false,openAiCalls:0,executionCalls:0}};
    stats.runs+=1;stats.last=result;return result;
  }
  const target=allocation.weights;
  const turnover=0.5*symbols.reduce((sum,s)=>sum+Math.abs((target[s]||0)-(currentAligned[s]||0)),0);
  const currentVar=portfolioVariance(currentAligned,returns);const targetVar=portfolioVariance(target,returns);
  const marginal={};for(const s of Object.keys(target)){const bumped={...target,[s]:target[s]+0.01};const n=normalizeWeights(bumped);marginal[s]=Math.max(0,portfolioVariance(n,returns)-targetVar);}
  const concentration=Object.values(target).reduce((s,w)=>s+w*w,0);
  const maxObservedWeight=Math.max(0,...Object.values(target));
  stats.runs+=1;
  const result={version:VERSION,at:safeDate(safeOptions.now).toISOString(),status:Object.keys(target).length>=2&&maxObservedWeight<=maxWeight+1e-8?'READY_FOR_SHADOW_REVIEW':'INCONCLUSIVE',targetWeights:target,currentWeights:currentAligned,turnover,concentrationHhi:concentration,currentVolProxy:Math.sqrt(currentVar),targetVolProxy:Math.sqrt(targetVar),marginalVariance:marginal,excluded,incompleteCurrentHistory:[],constraints:{maxWeight,minObservations:minObs,requiredAssets:allocation.requiredAssets,eligibleAssets:allocation.eligibleAssets,maxObservedWeight},dataCompleteness:{currentPortfolioHistoryComplete:true},safety:{shadowOnly:true,canTrade:false,canGenerateOrders:false,canAuthorizeLive:false,directLiveInfluence:false,openAiCalls:0,executionCalls:0}};
  stats.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...stats},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,directLiveInfluence:false}};}
global.__LEO_PORTFOLIO_OPTIMIZER_V2_STATE__=getState;global.__LEO_PORTFOLIO_OPTIMIZER_V2_RUN__=optimizePortfolio;
module.exports={VERSION,numericSeries,mean,variance,covariance,normalizeWeights,portfolioVariance,cappedNormalize,optimizePortfolio,getState};