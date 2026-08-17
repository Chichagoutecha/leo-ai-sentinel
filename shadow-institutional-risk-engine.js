'use strict';

/** LEO-AI SENTINEL — Stage 15 Institutional Risk Engine (Shadow only). */
const VERSION='v10.24.4-institutional-risk-engine';
let stats={runs:0,last:null};
function num(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function variance(a){if(a.length<2)return 0;const m=mean(a);return a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1);}
function quantile(arr,q){if(!arr.length)return null;const a=[...arr].sort((x,y)=>x-y);const pos=(a.length-1)*q,lo=Math.floor(pos),hi=Math.ceil(pos);if(lo===hi)return a[lo];return a[lo]+(a[hi]-a[lo])*(pos-lo);}
function maxDrawdown(returns){let equity=1,peak=1,max=0;for(const r of returns){equity*=1+num(r);peak=Math.max(peak,equity);max=Math.max(max,(peak-equity)/peak);}return max;}
function covariance(a,b){const n=Math.min(a.length,b.length);if(n<2)return 0;const aa=a.slice(-n),bb=b.slice(-n),ma=mean(aa),mb=mean(bb);let s=0;for(let i=0;i<n;i++)s+=(aa[i]-ma)*(bb[i]-mb);return s/(n-1);}
function normalizeWeights(w){const obj=Object.fromEntries(Object.entries(w||{}).map(([k,v])=>[k,Math.max(0,num(v))]));const s=Object.values(obj).reduce((a,b)=>a+b,0);return s?Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,v/s])):obj;}
function portfolioSeries(weights,returns){const syms=Object.keys(weights);const n=Math.min(...syms.map(s=>(returns[s]||[]).length).filter(x=>x>0));if(!Number.isFinite(n)||n<=0)return[];const out=[];for(let i=0;i<n;i++){let r=0;for(const s of syms){const series=returns[s]||[];r+=weights[s]*num(series[series.length-n+i]);}out.push(r);}return out;}
function stressLoss(weights,scenarios){const results={};for(const [name,moves] of Object.entries(scenarios||{})){let r=0;for(const [s,w] of Object.entries(weights))r+=w*num(moves[s],0);results[name]=r;}return results;}
function riskContributions(weights,returns){const syms=Object.keys(weights);let pv=0;for(const a of syms)for(const b of syms)pv+=weights[a]*weights[b]*covariance(returns[a]||[],returns[b]||[]);if(pv<=0)return Object.fromEntries(syms.map(s=>[s,0]));const out={};for(const a of syms){let m=0;for(const b of syms)m+=weights[b]*covariance(returns[a]||[],returns[b]||[]);out[a]=Math.max(0,weights[a]*m/pv);}const sum=Object.values(out).reduce((a,b)=>a+b,0)||1;for(const s of syms)out[s]/=sum;return out;}

function assessInstitutionalRisk(input={},options={}){
  const weights=normalizeWeights(input.weights||{});const returns=input.returns||{};const series=portfolioSeries(weights,returns);
  const minObs=Math.max(20,Math.floor(options.minObservations??60));
  if(series.length<minObs){const r={version:VERSION,status:'INCONCLUSIVE',reason:'INSUFFICIENT_HISTORY',observations:series.length,safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,directLiveInfluence:false}};stats.runs++;stats.last=r;return r;}
  const q05=quantile(series,.05);const tail=series.filter(x=>x<=q05);const var95=Math.max(0,-q05);const cvar95=Math.max(0,-mean(tail));
  const annVol=Math.sqrt(variance(series))*Math.sqrt(252);const mdd=maxDrawdown(series);
  const hhi=Object.values(weights).reduce((s,w)=>s+w*w,0);const maxWeight=Math.max(0,...Object.values(weights));
  const contributions=riskContributions(weights,returns);const maxRiskContribution=Math.max(0,...Object.values(contributions));
  const stresses=stressLoss(weights,input.stressScenarios||{});const worstStress=Math.min(0,...Object.values(stresses));
  let points=0;if(annVol>.25)points+=2;else if(annVol>.18)points+=1;if(cvar95>.03)points+=2;else if(cvar95>.02)points+=1;if(mdd>.15)points+=2;else if(mdd>.08)points+=1;if(maxWeight>.35||maxRiskContribution>.45)points+=2;else if(maxWeight>.25||maxRiskContribution>.35)points+=1;if(worstStress<-.15)points+=2;else if(worstStress<-.08)points+=1;
  const status=points>=7?'CRITICAL':points>=5?'DEFENSIVE':points>=3?'WATCH':'NORMAL';
  const riskMultiplier=status==='CRITICAL'?.45:status==='DEFENSIVE'?.6:status==='WATCH'?.8:1;
  const result={version:VERSION,at:new Date(options.now||Date.now()).toISOString(),status,score:points,observations:series.length,metrics:{historicalVaR95:var95,historicalCVaR95:cvar95,annualizedVolatility:annVol,maxDrawdown:mdd,concentrationHhi:hhi,maxWeight,maxRiskContribution},riskContributions:contributions,stressResults:stresses,worstStressReturn:worstStress,shadowRiskMultiplier:riskMultiplier,thresholds:{minObservations:minObs},safety:{shadowOnly:true,canTrade:false,canBlockLive:false,canAuthorizeLive:false,directLiveInfluence:false,openAiCalls:0,executionCalls:0}};
  stats.runs++;stats.last=result;return result;
}
function getState(){return{version:VERSION,stats:{...stats},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,directLiveInfluence:false}};}
global.__LEO_INSTITUTIONAL_RISK_STATE__=getState;global.__LEO_INSTITUTIONAL_RISK_ASSESS__=assessInstitutionalRisk;
module.exports={VERSION,mean,variance,quantile,maxDrawdown,portfolioSeries,stressLoss,riskContributions,assessInstitutionalRisk,getState};
