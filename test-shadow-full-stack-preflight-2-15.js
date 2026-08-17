'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

process.env.SHADOW_LAB_ENABLED='false';
process.env.SHADOW_RESEARCH_ENABLED='false';
process.env.SHADOW_ALPACA_VALIDATOR_ENABLED='true';
process.env.SHADOW_QUARTR_FUNDAMENTAL_ENABLED='true';
process.env.SHADOW_EXA_CATALYST_ENABLED='true';
process.env.SHADOW_ALPACA_STATE_FILE=`/tmp/leo-full-alpaca-${process.pid}.json`;
process.env.SHADOW_QUARTR_STATE_FILE=`/tmp/leo-full-quartr-${process.pid}.json`;
process.env.SHADOW_EXA_STATE_FILE=`/tmp/leo-full-exa-${process.pid}.json`;
process.env.SHADOW_RESEARCH_STATE_FILE=`/tmp/leo-full-research-${process.pid}.json`;
process.env.SHADOW_LAB_STATE_FILE=`/tmp/leo-full-lab-${process.pid}.json`;

require('./shadow-research-layer');
require('./shadow-alpaca-validator');
require('./shadow-quartr-fundamental-agent');
require('./shadow-exa-news-catalyst-agent');
require('./shadow-foundation-runtime-guard');
require('./shadow-intelligence-lab');
require('./shadow-macro-intelligence-agent');
require('./shadow-event-risk-calendar');
require('./shadow-market-regime-engine-v2');
require('./shadow-portfolio-optimizer-v2');
require('./shadow-institutional-risk-engine');
require('./shadow-opportunity-discovery-v2');
require('./shadow-dynamic-universe-manager');
require('./shadow-profitability-cost-guard');
require('./shadow-adaptive-ai-router');
require('./shadow-ai-value-experiment');
require('./shadow-roadmap-6-15-preflight');
const full=require('./shadow-full-stack-preflight');

test('all Shadow stages 2-15 and foundation guard load in one process safely',async()=>{
  const r=await full.preflight();
  assert.equal(r.allPresent,true,JSON.stringify(r.components));
  assert.equal(r.allShadowSafe,true,JSON.stringify(r.components));
  assert.equal(r.noStateErrors,true,JSON.stringify(r.components));
  assert.equal(r.readyForFullShadowRuntime,true);
  assert.equal(r.livePromotionAllowed,false);
  assert.equal(r.safety.canTrade,false);
  assert.equal(r.safety.canAuthorizeLive,false);
  assert.equal(r.safety.networkCalls,0);
  assert.equal(r.safety.openAiCalls,0);
  assert.equal(r.safety.executionCalls,0);
  for(const c of Object.values(r.components)){
    assert.equal(c.present,true);
    assert.equal(c.safe,true);
    assert.equal(c.errorName,null);
  }
});

test('existing roadmap 6-15 preflight stays green inside full stack',()=>{
  const r=global.__LEO_ROADMAP_6_15_PREFLIGHT__();
  assert.equal(r.allPresent,true);
  assert.equal(r.allShadowSafe,true);
  assert.equal(r.readyForEmpiricalShadow,true);
  assert.equal(r.livePromotionAllowed,false);
});

test('guarded foundation ingestion survives malformed handoff inside full process',async()=>{
  const a=await global.__LEO_ALPACA_VALIDATE__(null,null,null);
  const q=await global.__LEO_QUARTR_FUNDAMENTAL_INGEST__(null,{nowMs:'bad'});
  const e=await global.__LEO_EXA_CATALYST_INGEST__([null],{nowMs:'bad'});
  assert.equal(a.ok,false);assert.deepEqual(a.evidence,[]);
  assert.equal(q.ok,false);assert.deepEqual(q.evidence,[]);
  assert.equal(e.ok,true);assert.deepEqual(e.evidence,[]);assert.deepEqual(e.reports,[]);
  const guard=global.__LEO_FOUNDATION_RUNTIME_GUARD_STATE__();
  assert.ok(guard.stats.caught>=2);
  assert.equal(guard.safety.canTrade,false);
  assert.equal(guard.safety.canAuthorizeLive,false);
});
