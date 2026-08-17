'use strict';

/**
 * LEO-AI SENTINEL v10.22.10.4 — current eToro unified-order contract audit.
 * Shadow-only pure functions: zero network calls, zero execution authority.
 */
const VERSION='v10.22.10.4-current-v2-order-contract';
const CURRENT_REAL_ORDER_URL='https://public-api.etoro.com/api/v2/trading/execution/orders';
const CURRENT_DEMO_ORDER_URL='https://public-api.etoro.com/api/v2/trading/execution/demo/orders';
const LEGACY_REAL_BY_AMOUNT='https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-amount';
const LEGACY_REAL_BY_UNITS='https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-units';

function finitePositive(v){const n=Number(v);return Number.isFinite(n)&&n>0?n:null;}
function finitePositiveInt(v){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
function normalizeUrl(v){try{const u=new URL(String(v));return `${u.origin}${u.pathname}`.toLowerCase();}catch{return String(v||'').split('?')[0].toLowerCase();}}
function routeClassification(url,method='POST'){
  const u=normalizeUrl(url),m=String(method).toUpperCase();
  if(m==='POST'&&u===CURRENT_REAL_ORDER_URL.toLowerCase())return{family:'CURRENT_V2_UNIFIED_ORDER',environment:'REAL',deprecated:false};
  if(m==='POST'&&u===CURRENT_DEMO_ORDER_URL.toLowerCase())return{family:'CURRENT_V2_UNIFIED_ORDER',environment:'DEMO',deprecated:false};
  if(m==='POST'&&(u===LEGACY_REAL_BY_AMOUNT.toLowerCase()||u===LEGACY_REAL_BY_UNITS.toLowerCase()))return{family:'LEGACY_V1_MARKET_OPEN',environment:'REAL',deprecated:true};
  return{family:'OTHER',environment:null,deprecated:false};
}
function buildOpenBuyByAmount({instrumentId,amount,leverage=1,orderCurrency='usd'}={}){
  const id=finitePositiveInt(instrumentId),notional=finitePositive(amount),lev=finitePositive(leverage);
  if(!id)return{ok:false,reason:'INVALID_INSTRUMENT_ID',body:null};
  if(!notional)return{ok:false,reason:'INVALID_AMOUNT',body:null};
  if(!lev)return{ok:false,reason:'INVALID_LEVERAGE',body:null};
  const currency=String(orderCurrency||'').trim().toLowerCase();
  if(currency!=='usd')return{ok:false,reason:'UNSUPPORTED_ORDER_CURRENCY',body:null};
  return{ok:true,reason:null,url:CURRENT_REAL_ORDER_URL,method:'POST',body:{action:'open',transaction:'buy',instrumentId:id,orderType:'mkt',amount:notional,orderCurrency:'usd',leverage:lev}};
}
function classifyUnifiedResponse(payload,httpStatus=200){
  const status=Number(httpStatus),p=payload&&typeof payload==='object'?payload:{};
  if(!(status>=200&&status<300))return{classification:'HTTP_ERROR',businessAcknowledged:false,ambiguous:false};
  const token=p.token??p.data?.token??null;
  const orderId=p.orderId??p.data?.orderId??null;
  const positionId=p.positionId??p.data?.positionId??null;
  const referenceId=p.referenceId??p.data?.referenceId??null;
  if(orderId!=null||positionId!=null||token!=null||referenceId!=null)return{classification:'BUSINESS_ACKNOWLEDGED',businessAcknowledged:true,ambiguous:false,token,orderId,positionId,referenceId};
  return{classification:'HTTP_2XX_WITHOUT_UNIFIED_ORDER_EVIDENCE',businessAcknowledged:false,ambiguous:true,token:null,orderId:null,positionId:null,referenceId:null};
}
function migrationReadiness(){return{version:VERSION,status:'SHADOW_CONTRACT_READY',legacyRoutesDeprecated:true,currentOrderUrl:CURRENT_REAL_ORDER_URL,safety:{shadowOnly:true,networkCalls:0,executionCalls:0,canTrade:false,canAuthorizeLive:false,livePromotionAllowed:false}};}

global.__LEO_ETORO_CURRENT_ORDER_CONTRACT__={routeClassification,buildOpenBuyByAmount,classifyUnifiedResponse,migrationReadiness};
module.exports={VERSION,CURRENT_REAL_ORDER_URL,CURRENT_DEMO_ORDER_URL,LEGACY_REAL_BY_AMOUNT,LEGACY_REAL_BY_UNITS,routeClassification,buildOpenBuyByAmount,classifyUnifiedResponse,migrationReadiness};
