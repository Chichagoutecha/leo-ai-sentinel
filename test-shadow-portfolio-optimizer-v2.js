'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {optimizePortfolio,covariance}=require('./shadow-portfolio-optimizer-v2.js');
function series(base,noise){return Array.from({length:40},(_,i)=>base+Math.sin(i/3)*noise);}

test('builds diversified capped Shadow target weights',()=>{
  const r=optimizePortfolio({
    returns:{SPY:series(.001,.004),QQQ:series(.0013,.007),GLD:series(.0005,.003),TLT:series(.0003,.002)},
    expectedReturns:{SPY:.001,QQQ:.0014,GLD:.0006,TLT:.00035},
    currentWeights:{SPY:.7,QQQ:.3},
    dataQuality:{SPY:1,QQQ:.95,GLD:.9,TLT:.9}
  },{maxWeight:.35,minObservations:20});
  const sum=Object.values(r.targetWeights).reduce((a,b)=>a+b,0);
  assert.ok(Math.abs(sum-1)<1e-9);
  assert.ok(Math.max(...Object.values(r.targetWeights))<=.3500001);
  assert.equal(r.safety.canGenerateOrders,false);
  assert.equal(r.safety.canTrade,false);
});

test('excludes insufficient history and fails closed when needed',()=>{
  const r=optimizePortfolio({returns:{SPY:[.01,.02],QQQ:[.01,.01]},currentWeights:{SPY:1}},{minObservations:20});
  assert.equal(r.status,'INCONCLUSIVE');
  assert.ok(r.excluded.length>=2);
});

test('covariance remains finite',()=>{
  assert.ok(Number.isFinite(covariance([1,2,3],[1,2,4])));
});
