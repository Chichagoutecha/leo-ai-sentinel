'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {manageUniverse}=require('./shadow-dynamic-universe-manager.js');

test('adds only persistent eligible candidates to Shadow universe',()=>{
  const r=manageUniverse([{symbol:'SPY'}],[
    {symbol:'NVDA',dataQuality:.95,liquidityScore:95,spreadBps:5,ageSeconds:20,discoveryScore:90,persistenceRuns:3},
    {symbol:'BAD',dataQuality:.3,liquidityScore:10,spreadBps:200,ageSeconds:20,discoveryScore:100,persistenceRuns:10}
  ],{minPersistenceRuns:3});
  assert.ok(r.universe.some(x=>x.symbol==='NVDA'));
  assert.ok(!r.universe.some(x=>x.symbol==='BAD'));
  assert.equal(r.safety.canModifyLiveUniverse,false);
});

test('does not add a one-run transient candidate',()=>{
  const r=manageUniverse([], [{symbol:'RKLB',dataQuality:.9,liquidityScore:80,spreadBps:20,ageSeconds:30,discoveryScore:85,persistenceRuns:1}], {minPersistenceRuns:3});
  assert.equal(r.universe.length,0);
});

test('removes quarantined dynamic asset only when explicitly marked for removal',()=>{
  const r=manageUniverse([{symbol:'COIN',addedBy:'DYNAMIC_SHADOW'}],[{symbol:'COIN',quarantined:true,removeIfIneligible:true,dataQuality:.9,liquidityScore:90,spreadBps:10,ageSeconds:20}],{});
  assert.equal(r.universe.length,0);
  assert.equal(r.changes[0].action,'REMOVE');
});
