'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {discoverOpportunities}=require('./shadow-opportunity-discovery-v2.js');

test('funnels large universe deterministically with zero full-universe AI calls',()=>{
  const universe=Array.from({length:120},(_,i)=>({symbol:`A${i}`,dataQuality:.9,liquidityScore:70+(i%20),spreadBps:10+(i%15),ageSeconds:30,momentumScore:i%100,trendScore:(i*2)%100}));
  const r=discoverOpportunities(universe,{shortlistSize:20,finalistSize:6,minimumFinalistScore:65});
  assert.equal(r.shortlist.length,20);
  assert.ok(r.finalists.length<=6);
  assert.equal(r.policy.fullUniverseAiCalls,0);
  assert.equal(r.safety.canTrade,false);
});

test('rejects stale, illiquid or low-quality assets',()=>{
  const r=discoverOpportunities([{symbol:'BAD',dataQuality:.4,liquidityScore:20,spreadBps:200,ageSeconds:5000,momentumScore:100,trendScore:100}]);
  assert.equal(r.eligibleCount,0);
  assert.equal(r.rejectedCount,1);
});

test('ranking is stable for same inputs',()=>{
  const u=[{symbol:'BBB',dataQuality:1,liquidityScore:90,spreadBps:5,ageSeconds:5,momentumScore:60,trendScore:70},{symbol:'AAA',dataQuality:1,liquidityScore:90,spreadBps:5,ageSeconds:5,momentumScore:60,trendScore:70}];
  const a=discoverOpportunities(u,{shortlistSize:5});const b=discoverOpportunities(u,{shortlistSize:5});
  assert.deepEqual(a.shortlist.map(x=>x.symbol),b.shortlist.map(x=>x.symbol));
});
