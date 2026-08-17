'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateProvenance,validateRealHistoryRows,buildWalkForwardSplits,summarizeProviderCoverage}=require('./shadow-real-history-contract-11-15');

function row(i){
  const at=new Date(Date.parse('2024-01-02T16:00:00Z')+i*86400000).toISOString();
  return {at,returns:{SPY:[.001,.002,-.001,.0005]},provenance:[{provider:'TEST_PROVIDER',dataset:'daily-bars',symbol:'SPY',field:'close',observedAt:at,availableAt:at,retrievedAt:new Date(Date.parse(at)+3600000).toISOString(),sourceClass:'MARKET'}]};
}

const rows=Array.from({length:95},(_,i)=>row(i));

test('valid point-in-time provenance is accepted',()=>{assert.equal(validateProvenance(rows[0].provenance[0],rows[0].at).ok,true);});

test('future availability is rejected as lookahead',()=>{
  const r=row(0);r.provenance[0].availableAt=new Date(Date.parse(r.at)+86400000).toISOString();
  const x=validateRealHistoryRows([r,...rows.slice(1)]);assert.equal(x.ok,false);assert.equal(x.reason,'LOOKAHEAD_AVAILABILITY');
});

test('missing provenance fails closed',()=>{const x=rows.map(r=>structuredClone(r));delete x[10].provenance;const r=validateRealHistoryRows(x);assert.equal(r.ok,false);assert.equal(r.reason,'MISSING_ROW_PROVENANCE');});

test('duplicate and non-monotonic timestamps are rejected',()=>{
  const duplicate=rows.map(r=>structuredClone(r));duplicate[5].at=duplicate[4].at;assert.equal(validateRealHistoryRows(duplicate).reason,'DUPLICATE_ROW_TIMESTAMP');
  const reversed=rows.map(r=>structuredClone(r));const t=reversed[8];reversed[8]=reversed[9];reversed[9]=t;assert.equal(validateRealHistoryRows(reversed).reason,'NON_MONOTONIC_ROW_TIME');
});

test('walk-forward splits never overlap train and test in time',()=>{
  const r=buildWalkForwardSplits(rows,{trainRows:60,testRows:10,stepRows:10,expanding:true});
  assert.equal(r.status,'READY_FOR_PROVIDER_DATA');assert.equal(r.splits.length,3);
  for(const s of r.splits){assert.ok(Date.parse(s.trainLastAt)<Date.parse(s.testFirstAt));assert.equal(s.trainRows>=60,true);assert.equal(s.testRows,10);}
  assert.equal(r.safety.canTrade,false);assert.equal(r.safety.canAuthorizeLive,false);assert.equal(r.safety.livePromotionAllowed,false);
});

test('provider coverage is explicit and deterministic',()=>{const a=summarizeProviderCoverage(rows);const b=summarizeProviderCoverage(rows);assert.deepEqual(a,b);assert.equal(a[0].provider,'TEST_PROVIDER');assert.equal(a[0].records,95);});
