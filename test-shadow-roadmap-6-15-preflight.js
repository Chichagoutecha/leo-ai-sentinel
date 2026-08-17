'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

test('all roadmap 6-15 modules are present and Shadow-safe in combined preload',()=>{
  assert.equal(typeof global.__LEO_ROADMAP_6_15_PREFLIGHT__,'function');
  const r=global.__LEO_ROADMAP_6_15_PREFLIGHT__();
  assert.equal(r.allPresent,true);
  assert.equal(r.allShadowSafe,true);
  assert.equal(r.readyForEmpiricalShadow,true);
  assert.equal(r.livePromotionAllowed,false);
  assert.equal(r.safety.networkCalls,0);
  assert.equal(r.safety.openAiCalls,0);
  assert.equal(r.safety.executionCalls,0);
  assert.equal(Object.keys(r.stages).length,10);
});
