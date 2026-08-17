'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildHistoricalStyleFixture,replayStages11to15,runHistoricalStyleValidation}=require('./shadow-historical-replay-11-15');

test('historical-style replay is technically ready for real-history calibration',()=>{
  const r=runHistoricalStyleValidation();
  assert.equal(r.status,'TECHNICALLY_READY_FOR_REAL_HISTORY');
  assert.equal(r.dataClass,'HISTORICAL_STYLE_SYNTHETIC');
  assert.equal(r.metrics.rows,36);
  assert.equal(r.failures.length,0);
  assert.ok(Object.values(r.checks).every(Boolean));
  assert.equal(r.safety.canTrade,false);
  assert.equal(r.safety.canAuthorizeLive,false);
  assert.equal(r.safety.livePromotionAllowed,false);
  assert.equal(r.safety.networkCalls,0);
  assert.equal(r.safety.openAiCalls,0);
  assert.equal(r.safety.executionCalls,0);
});

test('stress phases tighten regime risk and recovery improves it',()=>{
  const r=runHistoricalStyleValidation();
  const p=r.metrics.phaseMetrics;
  assert.ok(p.INFLATION_SHOCK.avgRegimeRiskMultiplier<=p.CALM.avgRegimeRiskMultiplier);
  assert.ok(p.CREDIT_STRESS.avgRegimeRiskMultiplier<=p.CALM.avgRegimeRiskMultiplier);
  assert.ok(p.RECOVERY.avgRegimeRiskMultiplier>=p.CREDIT_STRESS.avgRegimeRiskMultiplier);
  assert.ok(r.metrics.transitionRate<=.5);
});

test('replay preserves optimizer and institutional-risk invariants on every ready row',()=>{
  const r=runHistoricalStyleValidation();
  for(const row of r.results){
    assert.equal(row.eventRisk.safety.canSell,false);
    assert.equal(row.regime.safety.canTrade,false);
    if(row.optimizer.status==='READY_FOR_SHADOW_REVIEW'){
      const weights=Object.values(row.optimizer.targetWeights);
      assert.ok(Math.abs(weights.reduce((a,b)=>a+b,0)-1)<1e-8);
      assert.ok(weights.every(w=>Number.isFinite(w)&&w<=.25000001));
    }
    if(row.risk.status!=='INCONCLUSIVE'){
      assert.ok(Number.isFinite(row.risk.score));
      assert.ok(Number.isFinite(row.risk.shadowRiskMultiplier));
      assert.ok(Number.isFinite(row.risk.worstStressReturn));
    }
  }
});

test('point-in-time contract rejects duplicate, non-monotonic and missing inputs',()=>{
  const rows=buildHistoricalStyleFixture();
  const duplicate=rows.map(x=>({...x}));duplicate[2].at=duplicate[1].at;
  assert.equal(replayStages11to15(duplicate).reason,'DUPLICATE_TIMESTAMP');
  const reversed=rows.map(x=>({...x}));[reversed[1],reversed[2]]=[reversed[2],reversed[1]];
  assert.equal(replayStages11to15(reversed).reason,'NON_MONOTONIC_TIME');
  const missing=rows.map(x=>({...x}));missing[0].returns={};
  assert.equal(replayStages11to15(missing).reason,'MISSING_RISK_INPUT');
});

test('incomplete weighted history fails calibration instead of being treated as safe',()=>{
  const rows=buildHistoricalStyleFixture().map(x=>({...x,returns:{...x.returns}}));
  rows.forEach(row=>{row.returns.SPY=row.returns.SPY.slice(0,10);});
  const r=replayStages11to15(rows,{dataClass:'CORRUPTED_FIXTURE',minObservations:60,maxWeight:.25});
  assert.equal(r.status,'FAILED');
  assert.equal(r.checks.riskCoverage,false);
  assert.ok(r.results.some(x=>x.risk.status==='INCONCLUSIVE'));
  assert.equal(r.safety.canTrade,false);
});

test('same replay input is deterministic at the calibration-output level',()=>{
  const a=runHistoricalStyleValidation();
  const b=runHistoricalStyleValidation();
  assert.deepEqual(a.checks,b.checks);
  assert.deepEqual(a.metrics,b.metrics);
  assert.deepEqual(a.results.map(x=>[x.at,x.regime.regime,x.optimizer.status,x.risk.status]),b.results.map(x=>[x.at,x.regime.regime,x.optimizer.status,x.risk.status]));
});
