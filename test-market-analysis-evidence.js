'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSeries, compareBenchmark, correlate, buildMarketAnalysisEvidence,
  compactMarketAnalysisEvidence, marketAnalysisSnapshotView, quoteEvidence, reportedNumber } = require('./market-analysis-evidence');

const now = Date.parse('2026-11-13T12:00:00Z'), DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const universe = [{ symbol: 'AAA', instrumentId: 1, category: 'STOCK' },
  { symbol: 'SPY', instrumentId: 2, category: 'ETF' }, { symbol: 'BBB', instrumentId: 3, category: 'STOCK' }];
function series(asset = 'AAA', changes = {}) {
  let price = 100;
  const candles = Array.from({ length: 65 }, (_, i) => {
    price *= 1 + (i % 3 === 0 ? -0.008 : 0.012);
    return { date: iso(Date.parse('2026-09-09T00:00:00Z') + i * DAY), close: price, volume: 100 + i,
      currency: 'USD', source: 'SYNTHETIC_OFFLINE_FIXTURE' };
  });
  return { asset, provider: 'eToro', interval: 'OneDay', source: 'SYNTHETIC_OFFLINE_FIXTURE', currency: 'USD',
    fetchedAt: iso(now), candlesCountRequested: 65, candles, ...changes };
}
function technical(asset) {
  return { asset, intervals: { daily: 'OneDay', intraday: 'OneHour' },
    selectedProviders: { daily: 'eToro', intraday: 'eToro' }, technicalScore: 51, signal: 'NEUTRAL',
    sourceStatus: { daily: { ok: true }, intraday: { ok: false } }, generatedAt: iso(now) };
}
const identity = { ok: true, status: 'CONFIRMED', current: { contextKind: 'AGENT_PORTFOLIO',
  environment: 'REAL', portfolioId: 'existing-agent-offline-fixture' } };
function portfolio(changes = {}) {
  return { ok: true, accountEnvironment: 'REAL', fetchedAt: iso(now), data: { clientPortfolio: {
    positions: [{ positionId: 1, instrumentId: 1, amount: 200, unrealizedPnL: { pnL: 0 }, currency: 'USD',
      leverage: 1, isBuy: true, settlementType: 'Underlying', mirrorId: 0 }],
    mirrors: [], credit: 100, ordersForOpen: [], orders: [], ordersForClose: [{ instrumentId: 1, amount: 200 }], ...changes } } };
}
function input(changes = {}) {
  return { now, universe, marketSummary: { fetchedAt: iso(now), ratesByAsset: {
    AAA: { mid: 120, date: iso(now - 60000), priceStatus: 'FRESH', currency: 'USD', source: 'FIXTURE' },
    SPY: { mid: 120, date: iso(now - 60000), priceStatus: 'FRESH', currency: 'USD', source: 'FIXTURE' } } },
    technicalAnalysisAgent: { assets: { AAA: technical('AAA'), SPY: technical('SPY') } },
    technicalCache: { AAA: series(), SPY: series('SPY') }, benchmarkByAsset: { AAA: 'SPY' },
    portfolioResponse: portfolio(), portfolioIdentity: identity, ...changes };
}

test('multi-horizon returns, sample volatility, drawdown and reported activity have explicit windows', () => {
  const entry = series(), result = analyzeSeries(entry, { now });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.summary.observations, 65);
  for (const horizon of [1, 5, 20, 60]) {
    const expected = (entry.candles.at(-1).close / entry.candles.at(-1 - horizon).close - 1) * 100;
    assert.ok(Math.abs(result.summary.horizons[horizon + 'Bars'].returnPct - expected) < 0.000001);
  }
  assert.ok(result.summary.volatilityPctPerBar > 0);
  assert.ok(result.summary.maxDrawdownPct > 0);
  assert.equal(result.summary.volume.averagePrior20, 153.5);
  assert.match(result.summary.basis, /NO_RETURN_FORECAST/);
});

test('short or gapped histories never become complete calendar horizons', () => {
  const entry = series(), short = analyzeSeries({ ...entry, candles: entry.candles.slice(-10) }, { now });
  assert.equal(short.status, 'PARTIAL');
  assert.equal(short.summary.horizons['60Bars'].returnPct, null);
  assert.ok(short.summary.issues.includes('REQUESTED_HISTORY_INCOMPLETE'));
  const gap = analyzeSeries({ ...entry, candles: entry.candles.filter((_, i) => i < 20 || i > 40) }, { now });
  assert.ok(gap.summary.issues.includes('IRREGULAR_OR_INCOMPLETE_OBSERVATION_GRID'));
});

test('absent, blank and invalid volumes stay missing; a reported zero remains a real zero', () => {
  for (const value of [null, undefined, '', ' ', false, NaN]) assert.equal(reportedNumber(value), null);
  assert.equal(reportedNumber('0'), 0);
  const entry = series();
  entry.candles.at(-1).volume = null;
  let result = analyzeSeries(entry, { now }).summary.volume;
  assert.equal(result.latestVolume, null); assert.equal(result.averagePrior20, null); assert.equal(result.ratioPrior20, null);
  entry.candles.at(-1).volume = 0;
  result = analyzeSeries(entry, { now }).summary.volume;
  assert.equal(result.latestVolume, 0); assert.equal(result.ratioPrior20, 0);
  entry.candles.at(-2).volume = null;
  assert.equal(analyzeSeries(entry, { now }).summary.volume.averagePrior20, null);
});

test('stale quotes are recomputed from source and retrieval times, not a cached FRESH flag', () => {
  const rate = input().marketSummary.ratesByAsset.AAA;
  assert.equal(quoteEvidence(rate, iso(now), now, 1800000).status, 'AVAILABLE');
  for (const changed of [{ ...rate, date: iso(now - 7200000) }, { ...rate, date: null }, { ...rate, date: iso(now + 1) }])
    assert.equal(quoteEvidence(changed, iso(now), now, 1800000).status, 'STALE_OR_UNVERIFIED');
  assert.equal(quoteEvidence(rate, iso(now - 7200000), now, 1800000).status, 'STALE_OR_UNVERIFIED');
  const stale = analyzeSeries(series('AAA', { fetchedAt: iso(now - DAY) }), { now });
  assert.equal(stale.status, 'STALE'); assert.notEqual(stale.summary.horizons['20Bars'].returnPct, null);
  assert.equal(compareBenchmark(stale, analyzeSeries(series('SPY'), { now })).relativeReturnPp, null);
});

test('incompatible and unknown currencies prevent benchmark and correlation comparisons without FX guesses', () => {
  const a = analyzeSeries(series(), { now });
  const different = series('SPY', { currency: 'EUR' }); different.candles = different.candles.map(row=>({ ...row, currency: 'EUR' }));
  const b = analyzeSeries(different, { now });
  assert.equal(compareBenchmark(a, b).relativeReturnPp, null);
  assert.match(correlate(a, b).reason, /CURRENCY_MISMATCH/);
  const noCurrency = series('SPY', { currency: null }); noCurrency.candles = noCurrency.candles.map(row=>({ ...row, currency: null }));
  assert.match(correlate(a, analyzeSeries(noCurrency, { now })).reason, /CURRENCY_UNKNOWN/);
});

test('correlations use identical return endpoints, preserve unknowns and reject constant samples', () => {
  const a = analyzeSeries(series(), { now }), same = series('SPY');
  same.candles = same.candles.map(row=>({ ...row, close: row.close * 3 }));
  const b = analyzeSeries(same, { now });
  assert.equal(correlate(a, b).value, 1);
  same.candles = same.candles.map(row=>({ ...row, date: iso(Date.parse(row.date) + 3600000) }));
  assert.equal(correlate(a, analyzeSeries(same, { now })).value, null);
  const constant = series('SPY'); constant.candles = constant.candles.map(row=>({ ...row, close: 100 }));
  assert.equal(correlate(a, analyzeSeries(constant, { now })).reason, 'ZERO_RETURN_VARIANCE');
});

test('benchmark absence and isolated intraday/source failure preserve independent daily analysis', () => {
  const report = buildMarketAnalysisEvidence(input({ technicalCache: { AAA: series() } }));
  assert.equal(report.assets.AAA.daily.status, 'AVAILABLE');
  assert.equal(report.assets.AAA.intraday.status, 'UNAVAILABLE');
  assert.equal(report.assets.AAA.benchmark.value, null);
  assert.notEqual(report.assets.AAA.daily.horizons['20Bars'].returnPct, null);
  assert.equal(report.governance.providerCalls, 0);
  assert.equal(report.governance.canPlaceOrder, false);
});

test('source explicitly marked stale by the technical path cannot be freshened by another cache entry', () => {
  const args = input(); args.technicalAnalysisAgent.assets.AAA.sourceStatus.daily.staleCache = true;
  const report = buildMarketAnalysisEvidence(args);
  assert.equal(report.assets.AAA.daily.status, 'STALE');
  assert.equal(report.assets.AAA.benchmark.relativeReturnPp, null);
});

test('different providers need an established comparable price basis, not just matching currencies', () => {
  const a=analyzeSeries(series(),{now});
  const b=analyzeSeries(series('SPY',{provider:'Twelve Data'}),{now});
  assert.equal(correlate(a,b).value,null);
  assert.equal(compareBenchmark(a,b).reason,'PRICE_BASIS_NOT_ESTABLISHED_ACROSS_PROVIDERS');
});

test('unfinished/future/conflicting bars are excluded without look-ahead or input mutation', () => {
  const entry = series(), before = JSON.stringify(entry);
  const end = entry.candles.at(-1);
  const bad = { ...entry, candles: [...entry.candles, { ...end }, { ...end, close: 900 },
    { ...end, date: iso(now + DAY), currency: 'EUR' }, { ...end, date: iso(now - 3600000), close: 99999 }] };
  const report = analyzeSeries(bad, { now });
  assert.equal(report.summary.observations, 64);
  assert.ok(report.summary.issues.includes('CONFLICTING_DUPLICATE_TIMESTAMP'));
  assert.ok(report.summary.issues.includes('UNFINISHED_BARS_EXCLUDED'));
  assert.equal(JSON.stringify(entry), before);
});

test('agent holdings and pending orders stay distinct, deduplicated and tied to the existing context', () => {
  const order = { orderId: 'pending-one', instrumentId: 3, amount: 50, isBuy: true, leverage: 1, currency: 'USD' };
  const args = input({ portfolioResponse: portfolio({ orders: [order], ordersForOpen: [order] }) });
  const before = JSON.stringify(args), report = buildMarketAnalysisEvidence(args);
  assert.equal(report.portfolio.status, 'AVAILABLE');
  assert.equal(report.portfolio.knownSubtotalUsd, 200);
  assert.equal(report.portfolio.concentration[0].totalPortfolioWeightPct, 66.666667);
  assert.equal(report.portfolio.pendingBuyUpperBoundsUsd[3], 50);
  assert.equal(report.portfolio.pendingIsHeld, false);
  assert.equal(report.assets.AAA.portfolioLinks.find(row=>row.instrumentId===3).held, false);
  assert.equal(report.assets.AAA.portfolioLinks.find(row=>row.instrumentId===1).correlation.value, null);
  assert.equal(JSON.stringify(args), before);
});

test('unknown values, costs, pending SELLs, or stale/unverified/shadow account evidence are never invented as zeros', () => {
  const missing = portfolio(); delete missing.data.clientPortfolio.positions[0].unrealizedPnL;
  let report = buildMarketAnalysisEvidence(input({ portfolioResponse: missing }));
  assert.equal(report.portfolio.knownSubtotalUsd, null);
  assert.equal(report.portfolio.status, 'PARTIAL');
  const sell = { orderId: 'sell', instrumentId: 1, amount: 10, isBuy: false, leverage: 1, currency: 'USD' };
  report = buildMarketAnalysisEvidence(input({ portfolioResponse: portfolio({ orders: [sell] }) }));
  assert.equal(report.portfolio.pendingStatus, 'INCOMPLETE'); assert.equal(report.portfolio.knownSubtotalUsd, 200);
  for (const changes of [{ portfolioIdentity: null }, { portfolioResponse: { ...portfolio(), fetchedAt: iso(now - DAY) } },
    { portfolioResponse: portfolio({ paperMode: true }) }, { portfolioResponse: { ...portfolio(), accountEnvironment: 'DEMO' } }]) {
    report = buildMarketAnalysisEvidence(input(changes));
    assert.equal(report.portfolio.status, 'UNAVAILABLE'); assert.equal(report.portfolio.knownSubtotalUsd, null);
    assert.equal(report.assets.AAA.daily.status, 'AVAILABLE');
  }
});

test('bounded decision view discloses omitted assets rather than pretending complete coverage', () => {
  const report = buildMarketAnalysisEvidence(input());
  for (let i=0;i<30;i++) report.assets['ASSET'+i] = { asset:'ASSET'+i,status:'UNAVAILABLE' };
  const compact = compactMarketAnalysisEvidence(report,'ASSET29');
  assert.equal(Object.keys(compact.assets).length,8); assert.ok(compact.assets.ASSET29);
  assert.ok(compact.omittedAssets>0); assert.ok(JSON.stringify(compact).length<40000);
  assert.equal(compactMarketAnalysisEvidence(compact).omittedAssets,compact.omittedAssets,'Repeated persistence compaction must preserve omitted coverage counts');
});

test('existing context optimizers preserve measured values, nulls, currencies and comparison limitations', () => {
  const report = compactMarketAnalysisEvidence(buildMarketAnalysisEvidence(input({ technicalCache: { AAA: series() } })));
  const v1 = require('./ai-context-optimizer'), v2 = require('./ai-context-optimizer-v2');
  const payload = { trading_mode: 'PAPER', portfolio_summary: {}, market_data_summary: {}, foundation_agents: { marketAnalysisEvidence: report }, instruction: 'Analyse descriptive uniquement.' };
  for (const projected of [v1.safetyProjection(payload), v2.decisionProjection(payload)]) {
    const asset = projected.foundation_agents.marketAnalysisEvidence.assets.AAA;
    assert.equal(asset.daily.horizons['20Bars'].returnPct, report.assets.AAA.daily.horizons['20Bars'].returnPct);
    assert.equal(asset.benchmark.value ?? null, null);
    assert.equal(asset.daily.currency,'USD');
    assert.equal(asset.daily.volatilityPctPerBar,report.assets.AAA.daily.volatilityPctPerBar);
    assert.equal(projected.foundation_agents.marketAnalysisEvidence.governance.canPlaceOrder,false);
  }
});

test('runtime assembly uses cached inputs and the REAL context without touching the paper book, client or allowlist', () => {
  const originalFetch = global.fetch;
  let calls=0; global.fetch=async()=>{calls++;throw Error('NO_PROVIDER_ACCESS_IN_OFFLINE_TEST');};
  try {
    const leo = require('./index');
    const saved = { technicalCache: leo.runtimeState.technicalCache, historicalCache: leo.runtimeState.historicalCache,
      lastMarketAnalysisEvidence: leo.runtimeState.lastMarketAnalysisEvidence };
    const paper = JSON.stringify(leo.runtimeState.paperPortfolio), rules=JSON.stringify(leo.ASSET_RULES), watchlist=JSON.stringify(leo.WATCHLIST);
    try {
      leo.runtimeState.technicalCache={ SPY: series('SPY') }; leo.runtimeState.historicalCache={};
      const report=leo.buildCachedMarketAnalysis({ realPortfolio: portfolio(), realSummary:{ livePortfolioIdentity:identity },
        marketSummary:{ fetchedAt:iso(now),ratesByAsset:{ SPY: input().marketSummary.ratesByAsset.SPY } },
        technicalAnalysisAgent:{ assets:{ SPY:technical('SPY') } },trendSummary:{} },now);
      assert.equal(report.assets.SPY.daily.status,'AVAILABLE');
      assert.equal(leo.runtimeState.lastMarketAnalysisEvidence.governance.providerCalls,0);
      assert.equal(calls,0); assert.equal(JSON.stringify(leo.runtimeState.paperPortfolio),paper);
      assert.equal(JSON.stringify(leo.ASSET_RULES),rules); assert.equal(JSON.stringify(leo.WATCHLIST),watchlist);
      const parsed=leo.normalizeTwelveDataCandles({meta:{currency:'EUR'},values:[{datetime:'2026-11-12',open:1,high:2,low:1,close:2,volume:null}]},'SPY','OneDay');
      assert.equal(parsed[0].volume,null); assert.equal(parsed[0].currency,'EUR');
    } finally { Object.assign(leo.runtimeState,saved); }
  } finally { global.fetch=originalFetch; }
});


test('persisted evidence ages on read; stale broker observations never keep a FRESH label', () => {
  const report=buildMarketAnalysisEvidence(input());
  const before=JSON.stringify(report), old=marketAnalysisSnapshotView(report,now+86400000);
  assert.equal(old.status,'STALE_SNAPSHOT');
  assert.equal(old.assets.AAA.quote.status,'STALE_OR_UNVERIFIED');
  assert.equal(old.portfolio.status,'STALE');
  assert.equal(old.assets.AAA.portfolioLinks[0].held,null);
  assert.equal(JSON.stringify(report),before);
});

test('portfolio valuation currency mismatch cannot be treated as USD capital or converted silently', () => {
  const report=buildMarketAnalysisEvidence(input({portfolioResponse:{...portfolio(),currency:'EUR'}}));
  assert.equal(report.portfolio.status,'UNAVAILABLE');
  assert.equal(report.portfolio.currency,'EUR');
  assert.equal(report.portfolio.knownSubtotalUsd,null);
  assert.equal(report.portfolio.reason,'PORTFOLIO_VALUATION_CURRENCY_MISMATCH');
  assert.equal(report.assets.AAA.daily.status,'AVAILABLE');
});

test('sample statistics are not annualized and a measured zero correlation is distinct from unknown', () => {
  const base=series(), a={...base,candles:base.candles.slice(-61)}, b={...base,asset:'SPY',candles:base.candles.slice(-61)};
  let x=100,y=100;
  a.candles=a.candles.map((row,i)=>{if(i)x*=1+Math.sin(i*Math.PI/2)/100;return {...row,close:x};});
  b.candles=b.candles.map((row,i)=>{if(i)y*=1+Math.cos(i*Math.PI/2)/100;return {...row,close:y};});
  assert.equal(Math.abs(correlate(analyzeSeries(a,{now}),analyzeSeries(b,{now})).value),0);
  const curve={...base,candles:base.candles.slice(-4).map((row,i)=>({...row,close:[100,110,99,108.9][i]}))};
  const result=analyzeSeries(curve,{now});
  assert.equal(result.summary.volatilityPctPerBar,11.547005);
  assert.equal(result.summary.maxDrawdownPct,10);
});
