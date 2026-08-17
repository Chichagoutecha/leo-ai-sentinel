'use strict';

/** LEO-AI SENTINEL — Stage 11 Market Regime Engine 2.0 (Shadow only). */
const VERSION = 'v10.24.2.1-market-regime-runtime-safe';
const REGIMES = ['RISK_ON','NEUTRAL','RISK_OFF','INFLATION','RATE_SHOCK','CREDIT_STRESS'];
let state = { evaluations: 0, last: null, transitions: 0 };

function clamp(n,min,max){ const x=Number(n); return Number.isFinite(x)?Math.max(min,Math.min(max,x)):min; }
function num(v,f=0){ const n=Number(v); return Number.isFinite(n)?n:f; }
function safeObject(value){ return value&&typeof value==='object'&&!Array.isArray(value)?value:{}; }
function safeDate(value){ const t=value instanceof Date?value.getTime():Date.parse(value); return Number.isFinite(t)?new Date(t):new Date(); }
function softmax(scores){ const safe=safeObject(scores); const vals=REGIMES.map(r=>num(safe[r],0)); const m=Math.max(...vals); const ex=vals.map(v=>Math.exp((v-m)/18)); const s=ex.reduce((a,b)=>a+b,0)||1; return Object.fromEntries(REGIMES.map((r,i)=>[r,Math.round(ex[i]/s*10000)/10000])); }

function buildRawScores(input={}){
  const safe=safeObject(input); const macro=safeObject(safe.macro); const market=safeObject(safe.market); const event=safeObject(safe.eventRisk);
  const growth=num(macro.growthScore); const infl=num(macro.inflationPressureScore); const cond=num(macro.financialConditionsScore);
  const breadth=clamp(num(market.breadthPct,50),0,100); const trend=clamp(num(market.trendScore,0),-100,100);
  const vol=clamp(num(market.realizedVolPct,20),0,150); const vix=clamp(num(market.vix,20),0,100);
  const credit=clamp(num(market.creditStressScore,0),-100,100); const rateShock=clamp(num(market.rateShockScore,0),-100,100);
  const eventPenalty=event.severity==='BLOCK_NEW_BUY'?20:event.severity==='REDUCE_SIZE'?10:0;
  return {
    RISK_ON: growth*.35+cond*.35+(breadth-50)*.8+trend*.25-(vol-18)*.5-eventPenalty,
    NEUTRAL: 20-Math.abs(growth)*.15-Math.abs(cond)*.15-Math.abs(infl)*.08+Math.max(0,20-Math.abs(breadth-50)),
    RISK_OFF: -growth*.25-cond*.35+(50-breadth)*.8-trend*.2+(vol-18)*.7+(vix-20)*.8+eventPenalty,
    INFLATION: infl*.55+(num(market.oilTrendPct,0))*1.2-cond*.12,
    RATE_SHOCK: rateShock*.7+infl*.2+(num(market.yield2yChangeBps,0))*.25,
    CREDIT_STRESS: credit*.75-cond*.25+(num(market.creditSpreadChangeBps,0))*.35+(vix-20)*.5
  };
}

function evaluateRegime(input={}, options={}){
  const safeOptions=safeObject(options);
  const raw=buildRawScores(input); const probs=softmax(raw);
  const sorted=Object.entries(probs).sort((a,b)=>b[1]-a[1]);
  const candidate=sorted[0][0]; const candidateP=sorted[0][1];
  const requestedPrevious=String(safeOptions.previousRegime||state.last?.regime||'NEUTRAL');
  const previous=REGIMES.includes(requestedPrevious)?requestedPrevious:'NEUTRAL';
  const prevP=probs[previous]||0;
  const hysteresis=clamp(num(safeOptions.hysteresisMargin,.08),0,.3);
  const stableRegime=(candidate!==previous && candidateP-prevP<hysteresis)?previous:candidate;
  if (state.last && stableRegime!==state.last.regime) state.transitions+=1;
  const confidence=probs[stableRegime]||candidateP;
  let riskMultiplier=1;
  if (stableRegime==='RISK_ON') riskMultiplier=1.05;
  else if (stableRegime==='NEUTRAL') riskMultiplier=0.9;
  else if (stableRegime==='RISK_OFF') riskMultiplier=0.7;
  else if (stableRegime==='INFLATION') riskMultiplier=0.75;
  else if (stableRegime==='RATE_SHOCK') riskMultiplier=0.65;
  else if (stableRegime==='CREDIT_STRESS') riskMultiplier=0.55;
  riskMultiplier=clamp(riskMultiplier,0.5,1.1);
  state.evaluations+=1;
  const result={ version:VERSION, at:safeDate(safeOptions.now).toISOString(), regime:stableRegime, confidence, probabilities:probs, rawScores:raw, candidateRegime:candidate, previousRegime:previous, hysteresisMargin:hysteresis, riskMultiplier,
    safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,directLiveInfluence:false,networkClientPresent:false,openAiCalls:0,executionCalls:0} };
  state.last=result; return result;
}
function getState(){ return {version:VERSION,stats:{evaluations:state.evaluations,transitions:state.transitions,last:state.last},safety:{shadowOnly:true,canTrade:false,canAuthorizeLive:false,directLiveInfluence:false}}; }
global.__LEO_MARKET_REGIME_V2_STATE__=getState;
global.__LEO_MARKET_REGIME_V2_EVALUATE__=evaluateRegime;
module.exports={VERSION,REGIMES,safeDate,buildRawScores,softmax,evaluateRegime,getState};