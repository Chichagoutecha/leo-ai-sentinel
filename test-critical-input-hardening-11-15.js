'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

const {analyzeMacro}=require('./shadow-macro-intelligence-agent');
const {evaluateEventRisk}=require('./shadow-event-risk-calendar');
const {evaluateRegime}=require('./shadow-market-regime-engine-v2');
const {optimizePortfolio,covariance:optimizerCovariance}=require('./shadow-portfolio-optimizer-v2');
const {assessInstitutionalRisk,covariance:riskCovariance}=require('./shadow-institutional-risk-engine');

function returns(n=80,base=.0004,noise=.006){
  return Array.from({length:n},(_,i)=>base+Math.sin(i/5)*noise);
}

test('Stages 11-15 never throw on null or malformed top-level inputs',()=>{
  assert.doesNotThrow(()=>analyzeMacro(null,null));
  assert.doesNotThrow(()=>evaluateEventRisk({not:'an array'},null));
  assert.doesNotThrow(()=>evaluateRegime(null,null));
  assert.doesNotThrow(()=>optimizePortfolio(null,null));
  assert.doesNotThrow(()=>assessInstitutionalRisk(null,null));
});

test('invalid timestamps fall back safely instead of crashing toISOString',()=>{
  const macro=analyzeMacro({}, {now:'definitely-not-a-date'});
  const event=evaluateEventRisk([], {now:'definitely-not-a-date'});
  const regime=evaluateRegime({}, {now:'definitely-not-a-date',previousRegime:'NOT_A_REGIME'});
  const opt=optimizePortfolio({}, {now:'definitely-not-a-date'});
  const risk=assessInstitutionalRisk({}, {now:'definitely-not-a-date'});
  for(const r of [macro,event,regime,opt]) assert.ok(Number.isFinite(Date.parse(r.at)));
  assert.equal(risk.status,'INCONCLUSIVE');
  assert.equal(regime.previousRegime,'NEUTRAL');
});

test('malformed event collections fail safe to CLEAR and never gain trade authority',()=>{
  const r=evaluateEventRisk({type:'FOMC'}, {symbol:'SPY'});
  assert.equal(r.severity,'CLEAR');
  assert.equal(r.blockNewBuy,false);
  assert.equal(r.safety.canTrade,false);
  assert.equal(r.safety.canSell,false);
});

test('invalid numeric optimizer options use safe defaults instead of disabling gates',()=>{
  const r=returns(40);
  const result=optimizePortfolio({
    returns:{A:r,B:r,C:r,D:r},
    expectedReturns:{A:.001,B:.0009,C:.0008,D:.0007},
    currentWeights:{A:.25,B:.25,C:.25,D:.25}
  },{maxWeight:'not-a-number',minObservations:'not-a-number',now:'bad'});
  assert.equal(result.status,'READY_FOR_SHADOW_REVIEW');
  assert.equal(result.constraints.maxWeight,.25);
  assert.equal(result.constraints.minObservations,20);
  assert.ok(Math.max(...Object.values(result.targetWeights))<=.25000001);
});

test('optimizer does not crash or emit NaN when return arrays contain non-finite values',()=>{
  const a=returns(50),b=returns(50,.0003,.004),c=returns(50,.0002,.003),d=returns(50,.0001,.002);
  a[4]=NaN;b[9]=Infinity;c[12]='bad';d[20]=undefined;
  const result=optimizePortfolio({returns:{A:a,B:b,C:c,D:d},currentWeights:{A:.25,B:.25,C:.25,D:.25}},{maxWeight:.4,minObservations:20});
  assert.equal(result.status,'READY_FOR_SHADOW_REVIEW');
  assert.ok(Number.isFinite(result.currentVolProxy));
  assert.ok(Number.isFinite(result.targetVolProxy));
  assert.ok(Object.values(result.marginalVariance).every(Number.isFinite));
  assert.ok(Number.isFinite(optimizerCovariance(a,b)));
});

test('optimizer fails closed when a currently held asset lacks sufficient usable history',()=>{
  const good=returns(50);
  const result=optimizePortfolio({
    returns:{A:good,B:good,C:good,D:good,HELD:[.01,'bad']},
    expectedReturns:{A:.001,B:.001,C:.001,D:.001},
    currentWeights:{HELD:1}
  },{maxWeight:.25,minObservations:20});
  assert.equal(result.status,'INCONCLUSIVE');
  assert.equal(result.reason,'INCOMPLETE_CURRENT_PORTFOLIO_HISTORY');
  assert.equal(result.safety.canTrade,false);
});

test('institutional risk requires explicit complete stress scenarios',()=>{
  const r=returns(80);
  const noStress=assessInstitutionalRisk({weights:{SPY:1},returns:{SPY:r}},{minObservations:60});
  assert.equal(noStress.status,'INCONCLUSIVE');
  assert.equal(noStress.reason,'NO_STRESS_SCENARIOS');

  const missing=assessInstitutionalRisk({weights:{SPY:.5,GLD:.5},returns:{SPY:r,GLD:r},stressScenarios:{CRASH:{SPY:-.2}}},{minObservations:60});
  assert.equal(missing.status,'INCONCLUSIVE');
  assert.equal(missing.reason,'INCOMPLETE_STRESS_COVERAGE');
});

test('institutional risk drops unsynchronized invalid rows and fails closed if usable overlap is too short',()=>{
  const a=returns(80),b=returns(80,.0002,.004);
  for(let i=0;i<30;i++) b[i]='bad';
  const result=assessInstitutionalRisk({
    weights:{A:.5,B:.5},returns:{A:a,B:b},stressScenarios:{CRASH:{A:-.2,B:-.15}}
  },{minObservations:60});
  assert.equal(result.status,'INCONCLUSIVE');
  assert.equal(result.reason,'INCOMPLETE_WEIGHTED_HISTORY');
});

test('institutional risk remains finite with isolated invalid rows when enough synchronized history remains',()=>{
  const a=returns(90),b=returns(90,.0002,.004);
  a[2]=NaN;b[4]=Infinity;a[9]='bad';
  const result=assessInstitutionalRisk({
    weights:{A:.5,B:.5},returns:{A:a,B:b},stressScenarios:{CRASH:{A:-.2,B:-.15},RATE:{A:-.08,B:-.05}}
  },{minObservations:60,now:'bad-date'});
  assert.ok(['NORMAL','WATCH','DEFENSIVE','CRITICAL'].includes(result.status));
  assert.ok(Number.isFinite(result.metrics.historicalVaR95));
  assert.ok(Number.isFinite(result.metrics.historicalCVaR95));
  assert.ok(Number.isFinite(result.metrics.annualizedVolatility));
  assert.ok(Number.isFinite(riskCovariance(a,b)));
  assert.ok(Number.isFinite(Date.parse(result.at)));
  assert.equal(result.safety.canTrade,false);
});
