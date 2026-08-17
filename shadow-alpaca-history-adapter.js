'use strict';

/**
 * LEO-AI SENTINEL — Alpaca real-history adapter (Shadow only)
 * Converts already-retrieved daily bars into conservative point-in-time rows.
 * No provider client, no OpenAI, no eToro, no LIVE authority.
 */
const {validateRealHistoryRows}=require('./shadow-real-history-contract-11-15');

const VERSION='v10.25.8-alpaca-real-history-adapter';
const DEFAULT_SYMBOLS=Object.freeze(['SPY','QQQ','GLD','TLT','XLV','XLE']);

function safeObject(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}
function finite(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function iso(v){const t=Date.parse(v);return Number.isFinite(t)?new Date(t).toISOString():null;}
function clamp(n,min,max){return Math.max(min,Math.min(max,Number(n)));}
function mean(a){return a.length?a.reduce((p,q)=>p+q,0)/a.length:0;}
function stdev(a){if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));}

function normalizeSeries(raw,symbol){
  if(!Array.isArray(raw))return{ok:false,reason:'MISSING_SYMBOL_BARS',symbol,bars:[]};
  const bars=[];let previous=-Infinity;const seen=new Set();
  for(let i=0;i<raw.length;i++){
    const ts=iso(raw[i]?.timestamp);const close=finite(raw[i]?.close);
    if(!ts||close==null||close<=0)return{ok:false,reason:'INVALID_BAR',symbol,index:i,bars:[]};
    const ms=Date.parse(ts);if(seen.has(ms))return{ok:false,reason:'DUPLICATE_BAR_TIMESTAMP',symbol,index:i,bars:[]};
    if(ms<=previous)return{ok:false,reason:'NON_MONOTONIC_BAR_TIME',symbol,index:i,bars:[]};
    seen.add(ms);previous=ms;bars.push({timestamp:ts,close});
  }
  return{ok:true,reason:null,symbol,bars};
}

function commonTimeline(seriesBySymbol,symbols){
  const sets=symbols.map(s=>new Set(seriesBySymbol[s].map(b=>b.timestamp)));
  return seriesBySymbol[symbols[0]].map(b=>b.timestamp).filter(ts=>sets.every(set=>set.has(ts))).sort((a,b)=>Date.parse(a)-Date.parse(b));
}

function returnsThrough(seriesBySymbol,symbols,timeline,endExclusive,lookbackBars){
  const start=Math.max(1,endExclusive-lookbackBars);const result={};
  for(const symbol of symbols){
    const byTs=new Map(seriesBySymbol[symbol].map(b=>[b.timestamp,b.close]));const arr=[];
    for(let i=start;i<endExclusive;i++){
      const prev=byTs.get(timeline[i-1]),cur=byTs.get(timeline[i]);
      if(!Number.isFinite(prev)||!Number.isFinite(cur)||prev<=0)throw new Error(`MISSING_ALIGNED_CLOSE:${symbol}:${timeline[i]}`);
      arr.push(cur/prev-1);
    }
    result[symbol]=arr;
  }
  return result;
}

function marketFeatures(returns){
  const latest=Object.values(returns).map(a=>a[a.length-1]).filter(Number.isFinite);
  const breadthPct=latest.length?100*latest.filter(x=>x>0).length/latest.length:50;
  const spy=Array.isArray(returns.SPY)?returns.SPY:[];
  const cumulative=spy.slice(-20).reduce((p,r)=>p*(1+r),1)-1;
  const realizedVolPct=stdev(spy.slice(-20))*Math.sqrt(252)*100;
  const xle=Array.isArray(returns.XLE)?returns.XLE:[];
  const oilProxy=xle.slice(-10).reduce((p,r)=>p*(1+r),1)-1;
  return{breadthPct:Math.round(breadthPct*100)/100,trendScore:clamp(cumulative*500,-100,100),realizedVolPct:Math.max(0,realizedVolPct),oilTrendPct:oilProxy*100,provenanceNote:'PRICE_DERIVED_ONLY_NO_VIX_CREDIT_OR_MACRO_INFERENCE'};
}

function buildProvenance(symbol,observedAt,availableAt,retrievedAt,feed){
  return{provider:'ALPACA',dataset:`STOCK_BARS_1DAY_${String(feed||'IEX').toUpperCase()}`,symbol,field:'close',observedAt,availableAt,retrievedAt,sourceClass:'MARKET_DATA',revision:String(feed||'iex').toUpperCase()};
}

function safety(){return{shadowOnly:true,networkCalls:0,openAiCalls:0,executionCalls:0,canTrade:false,canAuthorizeLive:false,livePromotionAllowed:false};}

function adaptAlpacaDailyBars(payload={},options={}){
  const p=safeObject(payload),o=safeObject(options),barsRaw=safeObject(p.bars||p);
  const symbols=(Array.isArray(o.symbols)&&o.symbols.length?o.symbols:DEFAULT_SYMBOLS).map(s=>String(s).toUpperCase());
  const lookbackBars=Math.max(20,Math.floor(finite(o.lookbackBars)??90));
  const retrievedAt=iso(o.retrievedAt||p.retrievedAt||new Date());
  if(!retrievedAt)return{version:VERSION,status:'INCONCLUSIVE',reason:'INVALID_RETRIEVED_AT',rows:[],safety:safety()};
  const normalized={};
  for(const symbol of symbols){const n=normalizeSeries(barsRaw[symbol],symbol);if(!n.ok)return{version:VERSION,status:'INCONCLUSIVE',reason:n.reason,detail:n,rows:[],safety:safety()};normalized[symbol]=n.bars;}
  const timeline=commonTimeline(normalized,symbols);
  if(timeline.length<lookbackBars+26)return{version:VERSION,status:'INCONCLUSIVE',reason:'INSUFFICIENT_COMMON_BARS',commonBars:timeline.length,requiredBars:lookbackBars+26,rows:[],safety:safety()};
  const rows=[];
  // Conservative availability: previous daily bar becomes usable only at the next common session timestamp.
  for(let i=lookbackBars+1;i<timeline.length;i++){
    const at=timeline[i],observedAt=timeline[i-1];
    if(Date.parse(retrievedAt)<Date.parse(at))return{version:VERSION,status:'INCONCLUSIVE',reason:'RETRIEVED_BEFORE_REPLAY_ROW',rowAt:at,retrievedAt,rows:[],safety:safety()};
    const returns=returnsThrough(normalized,symbols,timeline,i,lookbackBars);
    rows.push({at,market:marketFeatures(returns),macro:{},events:[],returns,provenance:symbols.map(symbol=>buildProvenance(symbol,observedAt,at,retrievedAt,o.feed||p.feed||'iex')),sourceMeta:{provider:'ALPACA',feed:String(o.feed||p.feed||'iex').toUpperCase(),barTimeframe:'1Day',availabilityPolicy:'PREVIOUS_BAR_AVAILABLE_AT_NEXT_COMMON_SESSION'}});
  }
  const contract=validateRealHistoryRows(rows);
  return{version:VERSION,status:contract.ok?'READY_FOR_MACRO_ENRICHMENT':'INCONCLUSIVE',reason:contract.ok?null:contract.reason,commonBars:timeline.length,rows,contract,safety:safety()};
}

global.__LEO_ALPACA_REAL_HISTORY_ADAPTER__=adaptAlpacaDailyBars;
module.exports={VERSION,DEFAULT_SYMBOLS,normalizeSeries,commonTimeline,returnsThrough,marketFeatures,adaptAlpacaDailyBars};
