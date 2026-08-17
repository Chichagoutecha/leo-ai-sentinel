'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {runCriticalFuzz}=require('./critical-shadow-fuzz-11-15');

test('stages 11-15 satisfy deterministic property checks across 300 varied cases',()=>{
  const result=runCriticalFuzz({seed:20260817,cases:300});
  assert.equal(result.status,'PROPERTY_VALIDATED',JSON.stringify(result.failures,null,2));
  assert.equal(result.failureCount,0);
  assert.equal(result.safety.canTrade,false);
  assert.equal(result.safety.canAuthorizeLive,false);
  assert.equal(result.safety.networkCalls,0);
  assert.equal(result.safety.openAiCalls,0);
  assert.equal(result.safety.executionCalls,0);
});

test('fuzz run is deterministic for same seed',()=>{
  const a=runCriticalFuzz({seed:42,cases:40});
  const b=runCriticalFuzz({seed:42,cases:40});
  assert.deepEqual(a.failures,b.failures);
  assert.deepEqual(a.statuses,b.statuses);
});