'use strict';

/** LEO-AI SENTINEL — Stage 15 Institutional Risk Engine 1.2 (Shadow only). */
const VERSION='v10.24.4.2-institutional-risk-runtime-safe';
let stats={runs:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function safeObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
function safeDate(v){const t=v instanceof Date?v.getTime():Date.parse(v);return Number.isFinite(t)?new Date(t):new Date();}
function numericSeries(v){return Array.isArray(v)?v.map(Number).filter(Number.isFinite):[];}
function mean(a){const x=numericSeries(a);return x.length?x.reduce((p,q)=>p+q,0)/x.length:0;}
function variance(a){const x=numericSeries(a);if(x.length<2)return 0;const m=x.reduce((p,q)=>p+q,0)/x.length;return x.reduce((s,v)=>s+(v-m)**2,0)/(x.length-1);}
function quantile(arr,q){const a=numericSeries(arr).sort((x,y)=>x-y);if(!a.length)return null;const qq=Math.max(0,Math.min(1,num(q,.5)));const pos=(a.length-1)*qq,lo=Math.floor(pos),hi=Math.ceil(pos);if(lo===hi)return a[lo];return a[lo]+(a[hi]-a[lo])*(pos-lo);}
function maxDrawdown(returns){let equity=1,peak=1,max=0;for(const r of numericSeries(returns)){equity*=1+r;peak=Math.max(peak,equity);max=Math.max(max,(peak-equity)/peak);}return max;}
function covariance(a,b){const aa=Array.isArray(a)?a:[],bb=Array.isArray(b)?b:[];const n=Math.min(aa.length,bb.length);if(n<2)return 0;const pairs=[];for(let i=0;i<n;i++){const x=Number(aa[aa.length-n+i]),y=Number(bb[bb.length-n+i]);if(Number.isFinite(x)&&Number.isFinite(y))pairs.push([x,y]);}if(pairs.length<2)return 0;const ma=pairs.reduce((s,p)=>s+p[0],0)/pairs.length,mb=pairs.reduce((s,p)=>s+p[1],0)/pairs.length;let total=0;for(const [x,y] of pairs)total+=(x-ma)*(y-mb);return total/(pairs.length-1);}
function normalizeWeights(w){const safe=safeObject(w);const obj=Object.fromEntries(Object.entries(safe).map(([k,v])=>[k,Math.max(0,num(v))]));const s=Object.values(obj).reduce((a,b)=>a+b,0);return s?Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,v/s])):obj;}
function positiveSymbols(weights){return Object.entries(safeObject(weights)).filter(([,w])=>num(w)>0).map(([s])=>s);}
function portfolioSeries(weights,returns){const w=safeObject(weights),r=safeObject(returns),syms=positiveSymbols(w);if(!syms.length)return[];const arrays=syms.map(s=>Array.isArray(r[s])?r[s]:[]);if(arrays.some(a=>!a.length))return[];const n=Math.min(...arrays.map(a=>a.length));if(!Number.isFinite(n)||n<=0)return[];const out=[];for(let i=0;i<n;i++){let value=0,valid=true;for(const s of syms){const series=r[s],x=Number(series[series.length-n+i]);if(!Number.isFinite(x)){valid=false;break;}value+=w[s]*x;}if(valid)out.push(value);}return out;}
function stressLoss(weights,scenarios){const w=safeObject(weights),sc=safeObject(scenarios),results={};for(const [name,movesRaw] of Object.entries(sc)){const moves=safeObject(movesRaw);let r=0;for(const [s,weight] of Object.entries(w))if(weight>0)r+=weight*num(moves[s],0);results[name]=r;}return results;}
function riskContributions(weights,returns){const w=safeObject(weights),r=safeObject(returns),syms=positiveSymbols(w);let pv=0;for(const a of syms)for(const b of syms)pv+=w[a]*w[b]*covariance(r[a],r[b]);if(!(pv>0)&&pv!==0)return Object.fromEntries(syms.map(s=>[s,0]));if(pv<=0)return Object.fromEntries(syms.map(s=>[s,0]));const out={};for(const a of syms){let m=0;for(const b of syms)m+=w[b]*covariance(r[a],r[b]);out[a]=Math.max(0,w[a]*m/pv);}const sum=Object.values(out).reduce((a,b)=>a+b,0)||1;for(const s of syms)out[s]/=sum;return out;}
function historyCoverage(weights,returns,minObs){const r=safeObject(returns);return positiveSymbols(weights).map(symbol=>({symbol,observations:numericSeries(r[symbol]).length})).filter(x=>x.observations<minObs);}
function stressCoverage(weights,scenarios){const syms=positiveSymbols(weights),missing=[];for(const [scenario,movesRaw] of Object.entries(safeObject(scenarios))){const moves=safeObject(movesRaw);const absent=syms.filter(s=>!Object.prototype.hasOwnProperty.call(moves,s)||!Number.isFinite(Number(moves[s])));if(absent.length)missing.push({scenario,missingSymbols:absent});}return missing;}
function inconclusive(reason,details={}){const r={version:VERSION,status:'INCONCLUSIVE',reason,...details,safety:{shadowOnly:true,canTrade:false,canBlockLive:false,canAuthorizeLive:false,directLiveInfluence:false,openAiCalls:0,executionCalls:0}};stats.runs++;stats.last=r;return r;}

function assessInstitutionalRisk(input={},options={}){
  const safeInput=safeObject(input),safeOptions=safeObject(options);
  const weights=normalizeWeights(safeInput.weights),returns=safeObject(safeInput.returns);
  const minObs=Math.max(20,Math.floor(num(safeOptions.minObservations,60)));
  if(!positiveSymbols(weights).length)return inconclusive('NO_POSITIVE_WEIGHTS',{observations:0,thresholds:{minObservations:minObs}});
  const insufficient=historyCoverage(weights,returns,minObs);
  if(insufficient.length)return inconclusive('INCOMPLETE_WEIGHTED_HISTORY',{observations:0,insufficientHistory:insufficient,thresholds:{minObservations:minObs}});
  const scenarios=safeObject(safeInput.stressScenarios);
  if(!Object.keys(scenarios).length)return inconclusive('NO_STRESS_SCENARIOS',{observations:0,thresholds:{minObservations:minObs}});
  const missingStress=stressCoverage(weights,scenarios);
  if(missingStress.length)return inconclusive('INCOMPLETE_STRESS_COVERAGE',{observations:0,incompleteStressScenarios:missingStress,thresholds:{minObservations:minObs}});
  const series=portfolioSeries(weights,returns);
  if(series.length<minObs)return inconclusive('INSUFFICIENT_SYNCHRONIZED_HISTORY',{observations:series.length,thresholds:{minObservations:minObs}});
  const q05=quantile(series,.05);const tail=series.filter(x=>x<=q05);const var95=Math.max(0,-q05);const cvar95=Math.max(0,-mean(tail));
  const annVol=Math.sqrt(variance(series))*Math.sqrt(252);const mdd=maxDrawdown(series);
  const hhi=Object.values(weights).reduce((s,w)=>s+w*w,0);const maxWeight=Math.max(0,...Object.values(weights));
  const contributions=riskContributions(weights,returns);const maxRiskContribution=Math.max(0,...Object.values(contributions));
  const stresses=stressLoss(weights,scenarios);const worstStress=Math.min(0,...Object.values(stresses));
  const finiteMetrics=[var95,cvar95,annVol,mdd,hhi,maxWeight,maxRiskContribution,worstStress].every(Number.isFinite);
  if(!finiteMetrics)return inconclusive('NON_FINITE_RISK_METRIC',{observations:series.length,thresholds:{minObservations:minObs}});
  let points=0;if(annVol>.25)points+=2;else if(annVol>.18)points+=1;if(cvar95>.03)points+=2;else if(cvar95>.02)points+=1;if(mdd>.15)points+=2;else if(mdd>.08)points+=1;if(maxWeight>.35||maxRiskContribution>.45)points+=2;else if(maxWeight>.25||maxRiskContribution>.35)points+=1;if(worstStress<-.15)points+=2;else if(worstStress<-.08)points+=1;
  const status=points>=7?'CRITICAL':points>=5?'DEFENSIVE':points>=3?'WATCH':'NORMAL';
  const riskMultiplier=status==='CRITICAL'?.45:status==='DEFENSIVE'?.6:status==='WATCH'?.8:1;
  const result={version:VERSION,at:safeDate(safeOptions.now).toISOString(),status,score:points,observations:series.length,metrics:{historicalVaR95:var95,historicalCVaR95:cvar95,annualizedVolatility:annVol,maxDrawdown:mdd,concentrationHhi:hhi,maxWeight,maxRiskContribution},riskContributions:contributions,stressResults:stresses,worstStressReturn:worstStress,shadowRiskMultiplier:riskMultiplier,thresholds:{minObservations:minObs},dataCompleteness:{weightedHistoryComplete:true,synchronizedHistoryComplete:true,stressCoverageComplete:true,stressScenarioCount:Object.keys(scenarios).length},safety:{shadowOnly:true,canTrade:false,canBlockLive:false,canAuthorizeLive:false,directLiveInfluence:false,openAiCalls:0,executionCalls:0}};
  stats.runs++;stats.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...stats},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,directLiveInfluence:false}};}
global.__LEO_INSTITUTIONAL_RISK_STATE__=getState;global.__LEO_INSTITUTIONAL_RISK_ASSESS__=assessInstitutionalRisk;
module.exports={VERSION,numericSeries,mean,variance,quantile,maxDrawdown,covariance,portfolioSeries,stressLoss,riskContributions,normalizeWeights,historyCoverage,stressCoverage,assessInstitutionalRisk,getState};