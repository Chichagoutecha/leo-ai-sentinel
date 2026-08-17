'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const mod=require('./etoro-current-order-contract');

test('current real and demo unified-order routes are distinguished from deprecated v1 opens',()=>{
  assert.deepEqual(mod.routeClassification(mod.CURRENT_REAL_ORDER_URL,'POST'),{family:'CURRENT_V2_UNIFIED_ORDER',environment:'REAL',deprecated:false});
  assert.deepEqual(mod.routeClassification(mod.CURRENT_DEMO_ORDER_URL,'POST'),{family:'CURRENT_V2_UNIFIED_ORDER',environment:'DEMO',deprecated:false});
  assert.equal(mod.routeClassification(mod.LEGACY_REAL_BY_AMOUNT,'POST').deprecated,true);
  assert.equal(mod.routeClassification(mod.LEGACY_REAL_BY_UNITS,'POST').deprecated,true);
  assert.equal(mod.routeClassification(mod.LEGACY_REAL_BY_AMOUNT,'DELETE').family,'OTHER');
});

test('builder emits the documented unified market-open buy shape without legacy PascalCase fields',()=>{
  const r=mod.buildOpenBuyByAmount({instrumentId:3417,amount:523.95,leverage:1});
  assert.equal(r.ok,true);
  assert.equal(r.url,'https://public-api.etoro.com/api/v2/trading/execution/orders');
  assert.deepEqual(r.body,{action:'open',transaction:'buy',instrumentId:3417,orderType:'mkt',amount:523.95,orderCurrency:'usd',leverage:1});
  assert.equal(Object.prototype.hasOwnProperty.call(r.body,'InstrumentId'),false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.body,'IsBuy'),false);
  assert.equal(Object.prototype.hasOwnProperty.call(r.body,'Amount'),false);
});

test('invalid sizing or identity fails closed before any possible transport layer',()=>{
  assert.equal(mod.buildOpenBuyByAmount({instrumentId:null,amount:10}).reason,'INVALID_INSTRUMENT_ID');
  assert.equal(mod.buildOpenBuyByAmount({instrumentId:1,amount:0}).reason,'INVALID_AMOUNT');
  assert.equal(mod.buildOpenBuyByAmount({instrumentId:1,amount:10,leverage:0}).reason,'INVALID_LEVERAGE');
  assert.equal(mod.buildOpenBuyByAmount({instrumentId:1,amount:10,orderCurrency:'eur'}).reason,'UNSUPPORTED_ORDER_CURRENCY');
});

test('unified response classifier requires business evidence, never HTTP 2xx alone',()=>{
  assert.equal(mod.classifyUnifiedResponse({},200).classification,'HTTP_2XX_WITHOUT_UNIFIED_ORDER_EVIDENCE');
  assert.equal(mod.classifyUnifiedResponse({},200).ambiguous,true);
  assert.equal(mod.classifyUnifiedResponse({token:'t',orderId:123,referenceId:'r'},200).businessAcknowledged,true);
  assert.equal(mod.classifyUnifiedResponse({data:{positionId:456}},200).businessAcknowledged,true);
  assert.equal(mod.classifyUnifiedResponse({message:'bad'},400).classification,'HTTP_ERROR');
});

test('contract has no provider or LIVE authority',()=>{
  const r=mod.migrationReadiness();
  assert.equal(r.status,'SHADOW_CONTRACT_READY');
  assert.equal(r.legacyRoutesDeprecated,true);
  assert.equal(r.safety.networkCalls,0);
  assert.equal(r.safety.executionCalls,0);
  assert.equal(r.safety.canTrade,false);
  assert.equal(r.safety.canAuthorizeLive,false);
  assert.equal(r.safety.livePromotionAllowed,false);
});
