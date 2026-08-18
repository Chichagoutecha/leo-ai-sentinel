'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
process.env.LEO_PRODUCTION_AI_PREFLIGHT_AUTORUN='false';
const {inspectComposition}=require('./production-ai-preflight');

test('preflight fails closed when required AI preloads are absent',()=>{
  const r=inspectComposition();
  assert.equal(r.ok,false);
  assert.ok(r.failures.includes('AI_COST_OPTIMIZER_NOT_PRELOADED'));
  assert.ok(r.failures.includes('LUNA_COMPAT_NOT_PRELOADED'));
  assert.equal(r.safety.canTrade,false);
  assert.equal(r.safety.canAuthorizeLive,false);
  assert.equal(r.safety.networkCalls,0);
  assert.equal(r.safety.openAiCalls,0);
  assert.equal(r.safety.etoroCalls,0);
});

test('preflight explicitly rejects legacy eToro diagnostic composition',()=>{
  const r=inspectComposition({legacyDiagnosticLoaded:true});
  assert.equal(r.ok,false);
  assert.ok(r.failures.includes('LEGACY_ETORO_DIAGNOSTIC_PRELOADED'));
});

test('preflight never logs or exposes runtime secrets in its result schema',()=>{
  process.env.OPENAI_API_KEY='unit-test-placeholder';
  process.env.ETORO_API_KEY='unit-test-placeholder';
  const text=JSON.stringify(inspectComposition());
  assert.equal(text.includes('unit-test-placeholder'),false);
});
