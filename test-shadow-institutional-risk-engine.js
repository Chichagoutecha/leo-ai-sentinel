'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assessInstitutionalRisk,maxDrawdown}=require('./shadow-institutional-risk-engine.js');
function s(base,noise,n=100){return Array.from({length:n},(_,i)=>base+Math.sin(i/4)*noise);}

test('computes VaR/CVaR, drawdown, concentration and risk budget without LIVE authority',()=>{
  const r=assessInstitutionalRisk({weights:{SPY:.5,GLD:.25,TLT:.25},returns:{SPY:s(.0005,.008),GLD:s(.0002,.004),TLT:s(.0001,.003)},stressScenarios:{CRASH:{SPY:-.25,GLD:.04,TLT:.08},RATE_SHOCK:{SPY:-.08,GLD:-.05,TLT:-.12}}},{minObservations:60});
  assert.ok(['NORMAL','WATCH','DEFENSIVE','CRITICAL'].includes(r.status));
  assert.ok(r.metrics.historicalCVaR95>=r.metrics.historicalVaR95);
  assert.ok(r.metrics.maxDrawdown>=0);
  assert.equal(r.safety.canTrade,false);
  assert.equal(r.safety.canBlockLive,false);
});

test('fails closed on insufficient history',()=>{
  const r=assessInstitutionalRisk({weights:{SPY:1},returns:{SPY:[.01,-.01,.02]}},{minObservations:60});
  assert.equal(r.status,'INCONCLUSIVE');
  assert.equal(r.safety.canAuthorizeLive,false);
});

test('drawdown detects cumulative peak-to-trough loss',()=>{
  assert.ok(maxDrawdown([.1,-.2,-.1,.05])>.2);
});

test('concentrated stressed portfolio escalates risk status',()=>{
  const bad=Array.from({length:100},(_,i)=>i%5===0?-.06:.005);
  const r=assessInstitutionalRisk({weights:{COIN:.9,SPY:.1},returns:{COIN:bad,SPY:s(.0003,.01)},stressScenarios:{CRYPTO_CRASH:{COIN:-.5,SPY:-.12}}},{minObservations:60});
  assert.ok(['DEFENSIVE','CRITICAL'].includes(r.status));
  assert.ok(r.shadowRiskMultiplier<=.6);
});
