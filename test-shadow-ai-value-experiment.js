'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {runAIValueExperiment}=require('./shadow-ai-value-experiment.js');
function rows(n){const out=[];for(let i=0;i<n;i++){for(const arm of ['QUANT_ONLY','QUANT_AI','COUNCIL'])out.push({opportunityId:`O${i}`,arm,signedReturnPct:arm==='QUANT_ONLY'?.2:arm==='QUANT_AI'?.25:.3,aiCostUsd:arm==='QUANT_ONLY'?0:.001,notionalUsd:100});}return out;}

test('requires matched same-opportunity arms',()=>{
  const r=runAIValueExperiment(rows(30),{minMatchedOpportunities:30});
  assert.equal(r.matchedOpportunities,30);
  assert.equal(r.sampleReady,true);
  assert.ok(r.deltas.QUANT_AI_vs_QUANT_ONLY.meanReturnDeltaPct>0);
  assert.equal(r.safety.performsAiCalls,false);
  assert.equal(r.protocol.livePromotionAllowed,false);
});

test('does not declare value with insufficient matched sample',()=>{
  const r=runAIValueExperiment(rows(5),{minMatchedOpportunities:30});
  assert.equal(r.verdict,'INSUFFICIENT_SAMPLE');
  assert.equal(r.sampleReady,false);
});

test('unmatched records cannot bias the matched experiment',()=>{
  const data=rows(10);data.push({opportunityId:'ONLY_AI',arm:'QUANT_AI',signedReturnPct:99,aiCostUsd:0});
  const r=runAIValueExperiment(data,{minMatchedOpportunities:10});
  assert.equal(r.matchedOpportunities,10);
  assert.equal(r.unmatchedOpportunities,1);
});
