'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluateRegime}=require('./shadow-market-regime-engine-v2.js');

test('produces normalized probabilities and no LIVE capability',()=>{
  const r=evaluateRegime({macro:{growthScore:45,inflationPressureScore:5,financialConditionsScore:50},market:{breadthPct:72,trendScore:55,realizedVolPct:14,vix:15}}, {previousRegime:'NEUTRAL'});
  const sum=Object.values(r.probabilities).reduce((a,b)=>a+b,0);
  assert.ok(Math.abs(sum-1)<0.001);
  assert.ok(['RISK_ON','NEUTRAL'].includes(r.regime));
  assert.equal(r.safety.canTrade,false);
  assert.equal(r.safety.directLiveInfluence,false);
});

test('detects credit stress',()=>{
  const r=evaluateRegime({macro:{growthScore:-30,inflationPressureScore:10,financialConditionsScore:-70},market:{breadthPct:25,trendScore:-60,realizedVolPct:38,vix:40,creditStressScore:90,creditSpreadChangeBps:80}}, {previousRegime:'CREDIT_STRESS',hysteresisMargin:0});
  assert.equal(r.regime,'CREDIT_STRESS');
  assert.ok(r.riskMultiplier<=0.55);
});

test('hysteresis prevents weak regime flips',()=>{
  const base={macro:{growthScore:5,inflationPressureScore:0,financialConditionsScore:5},market:{breadthPct:52,trendScore:5,realizedVolPct:18,vix:19}};
  const r=evaluateRegime(base,{previousRegime:'NEUTRAL',hysteresisMargin:0.25});
  assert.equal(r.regime,'NEUTRAL');
});

test('event risk penalizes risk-on state',()=>{
  const noEvent=evaluateRegime({macro:{growthScore:35,inflationPressureScore:5,financialConditionsScore:35},market:{breadthPct:65,trendScore:45,realizedVolPct:15,vix:16},eventRisk:{severity:'CLEAR'}},{previousRegime:'RISK_ON',hysteresisMargin:0});
  const event=evaluateRegime({macro:{growthScore:35,inflationPressureScore:5,financialConditionsScore:35},market:{breadthPct:65,trendScore:45,realizedVolPct:15,vix:16},eventRisk:{severity:'BLOCK_NEW_BUY'}},{previousRegime:'RISK_ON',hysteresisMargin:0});
  assert.ok(event.probabilities.RISK_ON<=noEvent.probabilities.RISK_ON);
});
