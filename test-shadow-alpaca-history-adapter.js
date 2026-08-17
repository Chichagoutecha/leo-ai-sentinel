'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DEFAULT_SYMBOLS,adaptAlpacaDailyBars}=require('./shadow-alpaca-history-adapter');
const {buildWalkForwardSplits}=require('./shadow-real-history-contract-11-15');

function makeBars(days=130){
  const bars={};
  for(let si=0;si<DEFAULT_SYMBOLS.length;si++){
    const symbol=DEFAULT_SYMBOLS[si];let price=100+si*7;bars[symbol]=[];
    for(let i=0;i<days;i++){
      const ts=new Date(Date.UTC(2022,0,3+i)).toISOString();
      const r=0.0003+Math.sin((i+si*2)*0.27)*0.006+(symbol==='XLE'?Math.sin(i*.13)*.002:0);
      price*=1+r;bars[symbol].push({symbol,timestamp:ts,close:price});
    }
  }
  return bars;
}

test('adapter creates point-in-time rows with conservative next-session availability',()=>{
  const result=adaptAlpacaDailyBars({bars:makeBars(140),feed:'iex'},{lookbackBars:90,retrievedAt:'2026-08-17T15:30:00.000Z'});
  assert.equal(result.status,'READY_FOR_MACRO_ENRICHMENT');
  assert.equal(result.contract.ok,true);
  assert.ok(result.rows.length>=25);
  for(const row of result.rows){
    assert.equal(row.provenance.length,DEFAULT_SYMBOLS.length);
    for(const p of row.provenance){
      assert.equal(p.provider,'ALPACA');
      assert.equal(p.availableAt,row.at);
      assert.ok(Date.parse(p.observedAt)<Date.parse(p.availableAt));
      assert.ok(Date.parse(p.retrievedAt)>=Date.parse(p.availableAt));
    }
    assert.equal(row.market.provenanceNote,'PRICE_DERIVED_ONLY_NO_VIX_CREDIT_OR_MACRO_INFERENCE');
  }
  assert.equal(result.safety.canTrade,false);assert.equal(result.safety.canAuthorizeLive,false);assert.equal(result.safety.livePromotionAllowed,false);
});

test('adapted rows can enter the existing walk-forward contract',()=>{
  const adapted=adaptAlpacaDailyBars({bars:makeBars(155)},{lookbackBars:90,retrievedAt:'2026-08-17T15:30:00.000Z'});
  const wf=buildWalkForwardSplits(adapted.rows,{trainRows:30,testRows:10,stepRows:10,expanding:true});
  assert.equal(wf.status,'READY_FOR_PROVIDER_DATA');
  assert.ok(wf.splits.length>=2);
  for(const s of wf.splits)assert.ok(Date.parse(s.trainLastAt)<Date.parse(s.testFirstAt));
});

test('missing, malformed or duplicate provider bars fail closed',()=>{
  const missing=makeBars(140);delete missing.XLE;
  assert.equal(adaptAlpacaDailyBars({bars:missing},{retrievedAt:'2026-08-17T15:30:00Z'}).reason,'MISSING_SYMBOL_BARS');
  const bad=makeBars(140);bad.SPY[20].close=NaN;
  assert.equal(adaptAlpacaDailyBars({bars:bad},{retrievedAt:'2026-08-17T15:30:00Z'}).reason,'INVALID_BAR');
  const dup=makeBars(140);dup.SPY[21].timestamp=dup.SPY[20].timestamp;
  assert.equal(adaptAlpacaDailyBars({bars:dup},{retrievedAt:'2026-08-17T15:30:00Z'}).reason,'DUPLICATE_BAR_TIMESTAMP');
});

test('adapter refuses to pretend provider data was retrieved before replay rows',()=>{
  const result=adaptAlpacaDailyBars({bars:makeBars(140)},{lookbackBars:90,retrievedAt:'2022-01-10T00:00:00Z'});
  assert.equal(result.status,'INCONCLUSIVE');
  assert.equal(result.reason,'RETRIEVED_BEFORE_REPLAY_ROW');
});
