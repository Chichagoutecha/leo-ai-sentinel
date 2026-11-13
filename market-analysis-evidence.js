'use strict';

// Pure descriptive analytics. Reads supplied snapshots only; no provider, store or order client.
const { normalizeOwnedPortfolio, pendingExposure } = require('./trader-exposure-link');
const VERSION = 1;
const MAX_ASSETS = 64;
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const positive = value => num(value) !== null && value > 0;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const currencyOf = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
const symbolOf = value => typeof value === 'string' && /^[A-Z0-9][A-Z0-9.:-]{0,31}$/.test(value) ? value : null;
const round = value => num(value) === null ? null : Math.round(value * 1e6) / 1e6;
const reportedNumber = value => value === null || value === undefined || (typeof value === 'string' && !value.trim()) || typeof value === 'boolean'
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const age = (value, now) => time(value) === null ? null : now - time(value);
const periods = { OneMinute: 60000, FiveMinutes: 300000, FifteenMinutes: 900000,
  ThirtyMinutes: 1800000, OneHour: 3600000, FourHours: 14400000, OneDay: 86400000 };
const unknown = reason => ({ status: 'UNAVAILABLE', value: null, reason });
const standardDeviation = values => {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
};

function quoteEvidence(rate, fetchedAt, now, maxAgeMs) {
  const sourceAgeMs = age(rate?.date, now), fetchAgeMs = age(fetchedAt, now);
  const fresh = positive(rate?.mid) && rate.priceStatus === 'FRESH' &&
    sourceAgeMs !== null && sourceAgeMs >= 0 && sourceAgeMs <= maxAgeMs &&
    fetchAgeMs !== null && fetchAgeMs >= 0 && fetchAgeMs <= maxAgeMs;
  return { status: !rate ? 'UNAVAILABLE' : fresh ? 'AVAILABLE' : 'STALE_OR_UNVERIFIED',
    price: positive(rate?.mid) ? rate.mid : null, currency: currencyOf(rate?.currency), source: rate?.source || null,
    sourceAsOf: time(rate?.date) === null ? null : rate.date,
    fetchedAt: time(fetchedAt) === null ? null : fetchedAt, sourceAgeMs, fetchAgeMs,
    reason: fresh ? null : 'PRICE_OR_SOURCE_FRESHNESS_NOT_ESTABLISHED', executionReference: false };
}

/** Select the provider actually selected by the existing technical path, without fetching. */
function selectCachedSeries(asset, interval, provider, caches = []) {
  if (!provider || !periods[interval]) return null;
  return caches.flatMap(cache => Object.values(cache || {}))
    .filter(entry => entry && entry.asset === asset && entry.interval === interval && entry.provider === provider &&
      Array.isArray(entry.candles) && time(entry.fetchedAt) !== null)
    .sort((a, b) => time(b.fetchedAt) - time(a.fetchedAt) || b.candles.length - a.candles.length)[0] || null;
}

function analyzeSeries(entry, { now = Date.now(), maxAgeMs = 2700000 } = {}) {
  if (!entry || !Array.isArray(entry.candles) || !periods[entry.interval]) return {
    status: 'UNAVAILABLE', reason: 'CACHED_SELECTED_SERIES_UNAVAILABLE', bars: [],
    summary: { status: 'UNAVAILABLE', reason: 'CACHED_SELECTED_SERIES_UNAVAILABLE', observations: 0 } };
  const intervalMs = periods[entry.interval], issues = new Set(), groups = new Map();
  let rejected = 0, incompleteBars = 0;
  const currencies = new Set();
  const declaredCurrency = currencyOf(entry.currency);
  if (declaredCurrency) currencies.add(declaredCurrency);
  for (const candle of entry.candles.slice(-1000)) {
    const timestamp = time(candle?.date);
    const explicitCurrency = currencyOf(candle?.currency);
    if (timestamp === null || !positive(candle?.close) || timestamp > now) { rejected++; continue; }
    // Conservative closed-bar rule: UTC bar start + nominal interval. No unfinished bar/look-ahead.
    if (timestamp + intervalMs > now) { incompleteBars++; continue; }
    if (explicitCurrency) currencies.add(explicitCurrency);
    const bar = { timestamp, close: candle.close, volume: num(candle.volume),
      currency: explicitCurrency || declaredCurrency, source: candle.source || entry.source || null };
    if (bar.volume !== null && bar.volume < 0) bar.volume = null;
    if (!groups.has(timestamp)) groups.set(timestamp, []);
    groups.get(timestamp).push(bar);
  }
  const bars = [];
  for (const versions of groups.values()) {
    if (new Set(versions.map(row => JSON.stringify(row))).size !== 1) { rejected += versions.length; issues.add('CONFLICTING_DUPLICATE_TIMESTAMP'); }
    else bars.push(versions[0]);
  }
  bars.sort((a, b) => a.timestamp - b.timestamp);
  const currency = currencies.size === 1 ? [...currencies][0] : null;
  if (!currency) issues.add(currencies.size > 1 ? 'MIXED_CURRENCIES' : 'HISTORY_CURRENCY_UNKNOWN');
  if (currencies.size > 1) bars.length = 0;
  if (rejected) issues.add('INVALID_OR_CONFLICTING_BARS_EXCLUDED');
  if (incompleteBars) issues.add('UNFINISHED_BARS_EXCLUDED');
  if (entry.candles.length > 1000) issues.add('LOCAL_BAR_LIMIT');
  const fetchAgeMs = age(entry.fetchedAt, now);
  const fresh = fetchAgeMs !== null && fetchAgeMs >= 0 && fetchAgeMs <= maxAgeMs && entry.staleCache !== true;
  if (!fresh) issues.add('CACHE_STALE_OR_UNDATED');
  const last = bars.at(-1), lastAgeMs = last ? now - (last.timestamp + intervalMs) : null;
  // Allow an explicitly labelled weekend/holiday gap for daily samples, never call the quote live.
  if (lastAgeMs === null || lastAgeMs > (entry.interval === 'OneDay' ? 4 * intervalMs : 2 * intervalMs)) issues.add('LATEST_CLOSED_BAR_OLD_OR_ABSENT');
  const maxGapMs = bars.length < 2 ? null : bars.slice(1).reduce((max, row, i) => Math.max(max, row.timestamp - bars[i].timestamp), 0);
  if (maxGapMs > (entry.interval === 'OneDay' ? 4 * intervalMs : 1.5 * intervalMs)) issues.add('IRREGULAR_OR_INCOMPLETE_OBSERVATION_GRID');
  const requested = num(entry.candlesCountRequested);
  if (requested !== null && bars.length < requested - incompleteBars) issues.add('REQUESTED_HISTORY_INCOMPLETE');
  const horizons = Object.fromEntries([1, 5, 20, 60].map(count => {
    const first = bars.at(-1 - count);
    return [count + 'Bars', { status: first && last ? 'AVAILABLE' : 'UNAVAILABLE',
      returnPct: first && last ? round((last.close / first.close - 1) * 100) : null,
      observations: first ? count + 1 : bars.length, from: first ? new Date(first.timestamp).toISOString() : null,
      to: last ? new Date(last.timestamp).toISOString() : null }];
  }));
  const recent = bars.slice(-61);
  const returns = recent.slice(1).map((row, i) => (row.close / recent[i].close - 1) * 100);
  let high = null, drawdown = null;
  for (const row of recent) { high = high === null ? row.close : Math.max(high, row.close); drawdown = Math.max(drawdown ?? 0, (1 - row.close / high) * 100); }
  const volumeWindow = bars.slice(-21), latestVolume = num(last?.volume);
  const priorVolumes = volumeWindow.slice(0, -1).map(row => row.volume);
  const volumeComplete = priorVolumes.length === 20 && priorVolumes.every(v => v !== null) && latestVolume !== null;
  const average = volumeComplete ? priorVolumes.reduce((a, b) => a + b, 0) / 20 : null;
  const volume = { status: volumeComplete ? 'AVAILABLE' : 'UNAVAILABLE', latestVolume,
    averagePrior20: round(average), ratioPrior20: average > 0 ? round(latestVolume / average) : null,
    missingObservations: volumeWindow.filter(row => row.volume === null).length,
    basis: 'REPORTED_PROVIDER_ACTIVITY_UNITS_NOT_ASSUMED_EXCHANGE_VOLUME' };
  if (!volumeComplete) issues.add('VOLUME_OR_ACTIVITY_NOT_FULLY_REPORTED');
  const status = bars.length < 2 ? 'UNAVAILABLE' : !fresh || issues.has('LATEST_CLOSED_BAR_OLD_OR_ABSENT') ? 'STALE' : issues.size ? 'PARTIAL' : 'AVAILABLE';
  const summary = { status, source: entry.source || null, provider: entry.provider || null, currency,
    fetchedAt: time(entry.fetchedAt) === null ? null : entry.fetchedAt, fetchAgeMs, sourceAsOf: last ? new Date(last.timestamp).toISOString() : null,
    lastClosedBarAgeMs: lastAgeMs, interval: entry.interval, observations: bars.length, requestedObservations: requested,
    rejectedObservations: rejected, unfinishedObservations: incompleteBars, maxGapMs, horizons,
    volatilityPctPerBar: round(standardDeviation(returns.slice(-20))), volatilityObservations: Math.min(returns.length, 20),
    maxDrawdownPct: recent.length >= 2 ? round(drawdown) : null, drawdownObservations: recent.length,
    volume, issues: [...issues].sort(),
    basis: 'OBSERVED_CLOSED_BARS_NOT_CALENDAR_HORIZONS; SAMPLE_STDDEV; NO_ANNUALIZATION; NO_RETURN_FORECAST' };
  return { status, currency, provider:entry.provider || null, priceBasis:entry.priceBasis || null, interval: entry.interval, bars, summary };
}

function comparable(a, b) {
  if (!a || !b || a.bars.length < 2 || b.bars.length < 2) return 'HISTORY_UNAVAILABLE';
  if (a.status === 'STALE' || b.status === 'STALE') return 'HISTORY_STALE';
  if (!a.currency || !b.currency) return 'COMPARISON_CURRENCY_UNKNOWN';
  if (a.currency !== b.currency) return 'COMPARISON_CURRENCY_MISMATCH_NO_FX_CONVERSION';
  if (a.provider !== b.provider && (!a.priceBasis || a.priceBasis !== b.priceBasis)) return 'PRICE_BASIS_NOT_ESTABLISHED_ACROSS_PROVIDERS';
  if (a.interval !== b.interval) return 'INTERVAL_MISMATCH';
  return null;
}
function compareBenchmark(a, b) {
  const reason = comparable(a, b);
  if (reason) return { ...unknown(reason), assetReturnPct: null, benchmarkReturnPct: null, relativeReturnPp: null, observations: 0 };
  const other = new Map(b.bars.map(row => [row.timestamp, row]));
  const common = a.bars.filter(row => other.has(row.timestamp)).slice(-61);
  if (common.length < 2) return { ...unknown('NO_SHARED_BENCHMARK_WINDOW'), assetReturnPct: null, benchmarkReturnPct: null, relativeReturnPp: null, observations: common.length };
  const first = common[0], last = common.at(-1), assetReturn = (last.close / first.close - 1) * 100;
  const benchmarkReturn = (other.get(last.timestamp).close / other.get(first.timestamp).close - 1) * 100;
  return { status: 'AVAILABLE_SHARED_WINDOW_ONLY', assetReturnPct: round(assetReturn), benchmarkReturnPct: round(benchmarkReturn),
    relativeReturnPp: round(assetReturn - benchmarkReturn), observations: common.length,
    from: new Date(first.timestamp).toISOString(), to: new Date(last.timestamp).toISOString(), currency: a.currency,
    basis: 'PRICE_RETURN_NOT_TOTAL_RETURN_OR_RISK_ADJUSTED_ALPHA; NO_FX_CONVERSION' };
}
function correlate(a, b) {
  const reason = comparable(a, b);
  if (reason) return { ...unknown(reason), pairedReturns: 0 };
  const pairs = rows => new Map(rows.slice(1).map((row, i) => [rows[i].timestamp + ':' + row.timestamp, row.close / rows[i].close - 1]));
  const left = pairs(a.bars), right = pairs(b.bars);
  const common = [...left].filter(([key]) => right.has(key)).slice(-60);
  if (common.length < 20) return { ...unknown('FEWER_THAN_20_IDENTICAL_RETURN_INTERVALS'), pairedReturns: common.length };
  const xs = common.map(([, x]) => x), ys = common.map(([key]) => right.get(key));
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const mx = mean(xs), my = mean(ys);
  const xx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0), yy = ys.reduce((sum, y) => sum + (y - my) ** 2, 0);
  if (xx < 1e-20 || yy < 1e-20) return { ...unknown('ZERO_RETURN_VARIANCE'), pairedReturns: common.length };
  const xy = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0);
  return { status: 'AVAILABLE_SAMPLE_ONLY', value: round(Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy)))), pairedReturns: common.length,
    basis: 'PEARSON_ON_IDENTICAL_START_END_TIMESTAMPS_NOT_PRICE_LEVELS; NOT_INDEPENDENCE_OR_FORECAST' };
}

function portfolioEvidence(portfolioResponse, identity, universe, intents, now) {
  const owned = normalizeOwnedPortfolio(portfolioResponse, { universe, now });
  const pending = pendingExposure(portfolioResponse?.data?.clientPortfolio, intents);
  const declaredCurrency = portfolioResponse?.currency ?? portfolioResponse?.data?.clientPortfolio?.valuationCurrency ?? portfolioResponse?.data?.clientPortfolio?.currency;
  const bound = identity?.ok === true && identity.status === 'CONFIRMED' &&
    identity.current?.contextKind === 'AGENT_PORTFOLIO' && identity.current?.environment === 'REAL' &&
    typeof identity.current?.portfolioId === 'string' && identity.current.portfolioId.length > 0 && owned.fresh &&
    portfolioResponse?.ok === true && owned.environment === 'REAL' && portfolioResponse?.data?.clientPortfolio?.paperMode !== true &&
    (declaredCurrency === undefined || declaredCurrency === 'USD');
  const knownRows = owned.rows.filter(row => row.estimatedValueUsd !== null);
  const knownSubtotalUsd = knownRows.reduce((sum, row) => sum + row.estimatedValueUsd, 0);
  const values = owned.knownValuesByInstrument;
  return { bound, owned, pending, summary: {
    status: !bound ? 'UNAVAILABLE' : owned.coverage === 'COMPLETE' ? 'AVAILABLE' : 'PARTIAL',
    reason: bound ? null : declaredCurrency !== undefined && declaredCurrency !== 'USD' ? 'PORTFOLIO_VALUATION_CURRENCY_MISMATCH' : 'EXISTING_AGENT_CONTEXT_NOT_CONFIRMED_OR_READ_STALE',
    scope: 'EXISTING_API_PORTFOLIO_CONFIG_BINDING_NOT_SEPARATE_COPIER_ACCOUNT_PROOF',
    identityProof: 'EXISTING_CONFIGURATION_CONFIRMATION_NOT_NEW_OWNER_OR_AGENT_IDENTITY_VERIFICATION',
    sourceEffectiveAt: null, freshnessBasis: 'COLLECTION_TIME_ONLY_BROKER_SOURCE_ASOF_UNVERIFIED',
    environment: owned.environment, fetchedAt: owned.fetchedAt,
    currency: bound ? 'USD' : currencyOf(declaredCurrency), currencyBasis: 'EXISTING_PNL_USD_CAPITAL_VALUE_CONVENTION_NOT_ECONOMIC_FX_EXPOSURE',
    coverage: owned.coverage, valuationBasis: owned.valuationBasis,
    unknownPositions: owned.unknownPositions.length + owned.rows.filter(row => row.estimatedValueUsd === null).length,
    knownSubtotalUsd: bound && knownRows.length ? round(knownSubtotalUsd) : null,
    concentration: bound ? Object.entries(values).slice(0, MAX_ASSETS).map(([id, value]) => ({ instrumentId: Number(id),
      knownValueUsd: value, knownSubtotalWeightPct: knownSubtotalUsd > 0 ? round(value / knownSubtotalUsd * 100) : null,
      totalPortfolioWeightPct: owned.coverage === 'COMPLETE' && owned.nativeCopies.containers.length===0 && num(owned.creditUsd) !== null && owned.creditUsd>=0 && knownSubtotalUsd + owned.creditUsd > 0
        ? round(value / (knownSubtotalUsd + owned.creditUsd) * 100) : null })) : [],
    pendingStatus: pending.status, pendingBuyUpperBoundsUsd: bound ? pending.knownBuyUpperBoundByInstrument : null,
    pendingBuyUpperBounds: bound ? Object.entries(pending.knownBuyUpperBoundByInstrument).slice(0,MAX_ASSETS)
      .map(([instrumentId,amountUsd])=>({instrumentId:Number(instrumentId),amountUsd})) : null,
    pendingBasis: pending.quantityBasis, pendingIsHeld: false, pendingIssues: pending.issues,
    unreconstructedRisk: owned.unreconstructedRisk.length, problems: owned.problems,
    lookThrough: 'UNKNOWN_WITHOUT_VERIFIED_CONSTITUENTS; NO_INDEPENDENCE_INFERRED' } };
}

function buildMarketAnalysisEvidence({ marketSummary, technicalAnalysisAgent, trendSummary, technicalCache = {}, historicalCache = {},
  portfolioResponse, portfolioIdentity, universe = [], intents = [], benchmarkByAsset = {}, now = Date.now(),
  quoteMaxAgeMs = 1800000, historyMaxAgeMs = 2700000 } = {}) {
  const assets = {}, selected = {}, portfolio = portfolioEvidence(portfolioResponse, portfolioIdentity, universe, intents, now);
  const ids = new Map(universe.map(row => [row.instrumentId, row.symbol]));
  const inputSymbols = [...new Set([...Object.keys(technicalAnalysisAgent?.assets || {}),
    ...Object.keys(marketSummary?.ratesByAsset || {}), ...portfolio.owned.rows.map(row => ids.get(row.instrumentId))])]
    .filter(symbolOf);
  const symbols=inputSymbols.slice(0,MAX_ASSETS);
  for (const asset of symbols) {
    try {
      const technical = technicalAnalysisAgent?.assets?.[asset];
      selected[asset] = {};
      for (const label of ['intraday', 'daily']) {
        const entry = selectCachedSeries(asset, technical?.intervals?.[label], technical?.selectedProviders?.[label], [technicalCache, historicalCache]);
        selected[asset][label] = analyzeSeries(entry ? { ...entry, staleCache: entry.staleCache === true || technical?.sourceStatus?.[label]?.staleCache === true } : null, { now, maxAgeMs: historyMaxAgeMs });
      }
      const quote = quoteEvidence(marketSummary?.ratesByAsset?.[asset], marketSummary?.fetchedAt, now, quoteMaxAgeMs);
      assets[asset] = { asset, instrumentId: universe.find(row => row.symbol === asset)?.instrumentId ?? null, quote,
        intraday: selected[asset].intraday.summary, daily: selected[asset].daily.summary,
        existingAnalysis: { technicalScore: num(technical?.technicalScore), signal: technical?.signal || null,
          generatedAt: technical?.generatedAt || null, trendSignal: trendSummary?.assets?.[asset]?.trendSignal || null,
          sourceStatus:['intraday','daily'].map(interval=>({interval,provider:technical?.selectedProviders?.[interval] || null,
            status:technical?.sourceStatus?.[interval]?.ok===true?'AVAILABLE':technical?.sourceStatus?.[interval]?.ok===false?'UNAVAILABLE':'UNKNOWN'})),
          source: 'EXISTING_ANALYSES_NOT_RECOMPUTED_OR_OVERRIDDEN' },
        status: quote.status === 'AVAILABLE' && selected[asset].daily.status === 'AVAILABLE' ? 'AVAILABLE' : 'PARTIAL' };
    } catch {
      assets[asset] = { asset, status: 'UNAVAILABLE', reason: 'ISOLATED_SOURCE_OR_SERIES_FAILURE' };
    }
  }
  const heldIds = new Set(portfolio.owned.rows.map(row => row.instrumentId).filter(id=>Number.isSafeInteger(id)&&id>0));
  const pendingIds = new Set(portfolio.pending.orders.map(row => row.instrumentId).filter(Number.isSafeInteger));
  for (const asset of symbols) {
    const row = assets[asset], series = selected[asset]?.daily;
    const benchmark = symbolOf(benchmarkByAsset[asset]);
    row.benchmark = { asset: benchmark, assetReturnPct: null, benchmarkReturnPct: null, relativeReturnPp: null,
      ...(benchmark && benchmark !== asset ? compareBenchmark(series, selected[benchmark]?.daily) :
      unknown(benchmark === asset ? 'SELF_BENCHMARK_NOT_COMPARISON' : 'RELEVANT_BENCHMARK_NOT_ESTABLISHED')) };
    const linkIds = [...new Set([...heldIds, ...pendingIds])].sort((a,b)=>
      (portfolio.owned.knownValuesByInstrument[b] ?? -1) - (portfolio.owned.knownValuesByInstrument[a] ?? -1));
    row.portfolioLinksOmitted = Math.max(0,linkIds.length-12);
    row.portfolioLinks = linkIds.slice(0,12).map(id => {
      const other = ids.get(id);
      return { instrumentId: id, asset: other || null, held: portfolio.bound ? heldIds.has(id) : null, pending: portfolio.bound ? pendingIds.has(id) : null,
        correlation: !portfolio.bound ? unknown('EXISTING_AGENT_CONTEXT_NOT_CONFIRMED_OR_READ_STALE') : other === asset
          ? unknown('SAME_INSTRUMENT_DIRECT_OVERLAP_NOT_DIVERSIFICATION') : correlate(series, selected[other]?.daily) };
    });
  }
  return { version: VERSION, generatedAt: new Date(now).toISOString(), status: symbols.length ? 'PARTIAL_DESCRIPTIVE_ANALYSIS' : 'UNAVAILABLE',
    governance: { analysisOnly: true, canPlaceOrder: false, canOverrideRiskController: false, providerCalls: 0,
      changesAllowlist: false, newAgentPortfolio: false },
    assetLimit: MAX_ASSETS, inputAssetsOmitted:Math.max(0,inputSymbols.length-MAX_ASSETS), assets, portfolio: portfolio.summary,
    caveat: 'Price trends, volumes, popularity and sample correlations are descriptive, not forecasts. Missing inputs remain null. Optional source failure never erases available analyses.' };
}

function compactMarketAnalysisEvidence(report, focusAsset = null) {
  if (report?.version !== VERSION || report?.governance?.analysisOnly !== true || !report.assets) return null;
  const held = new Set((report.portfolio?.concentration || []).map(row=>row.instrumentId));
  const ordered = Object.keys(report.assets).filter(symbolOf).sort((a,b)=>
    Number(b===focusAsset)-Number(a===focusAsset) || Number(held.has(report.assets[b]?.instrumentId))-Number(held.has(report.assets[a]?.instrumentId)));
  const selected = ordered.slice(0,8);
  const compactSeries = series => !series ? null : {
    status:series.status,source:series.source,provider:series.provider,currency:series.currency,
    sourceAsOf:series.sourceAsOf,fetchedAt:series.fetchedAt,interval:series.interval,observations:series.observations,
    horizons:Object.fromEntries(Object.entries(series.horizons || {}).map(([key,value])=>[key,{status:value.status,returnPct:value.returnPct}])),
    volatilityPctPerBar:series.volatilityPctPerBar,maxDrawdownPct:series.maxDrawdownPct,
    volume:series.volume,issues:series.issues,
  };
  return { ...report, assets: Object.fromEntries(selected.map(asset=>{
    const row=report.assets[asset];
    return [asset,{...row,intraday:compactSeries(row.intraday),daily:compactSeries(row.daily),
      portfolioLinks:(row.portfolioLinks || []).slice(0,3),
      portfolioLinksOmitted:(row.portfolioLinksOmitted || 0)+Math.max(0,(row.portfolioLinks?.length || 0)-3)}];
  })),
    omittedAssets: (report.omittedAssets || 0)+Math.max(0,ordered.length-selected.length),
    metricBasis:'CLOSED_UTC_START_PLUS_INTERVAL_BARS_NOT_CALENDAR_DAYS; SAMPLE_STDDEV_NOT_ANNUALIZED; REPORTED_ACTIVITY_NOT_ASSUMED_EXCHANGE_VOLUME',
    portfolio: { ...report.portfolio, pendingBuyUpperBounds: report.portfolio?.pendingBuyUpperBounds?.slice(0,12) ?? null,
      pendingUpperBoundsOmitted: (report.portfolio?.pendingUpperBoundsOmitted || 0)+Math.max(0,(report.portfolio?.pendingBuyUpperBounds?.length ?? 0)-12),
      concentration: (report.portfolio?.concentration || []).slice(0,12),
      concentrationOmitted: (report.portfolio?.concentrationOmitted || 0)+Math.max(0,(report.portfolio?.concentration || []).length-12) } };
}

function marketAnalysisSnapshotView(report, now = Date.now(), maxAgeMs = 1800000, historyMaxAgeMs = 2700000) {
  if (report?.version !== VERSION || !report.assets) return null;
  const snapshotAgeMs = age(report.generatedAt,now), stale = snapshotAgeMs === null || snapshotAgeMs < 0 || snapshotAgeMs > maxAgeMs;
  const portfolioAgeMs = age(report.portfolio?.fetchedAt,now);
  const portfolioStale = portfolioAgeMs === null || portfolioAgeMs < 0 || portfolioAgeMs > 300000;
  return { ...report, snapshotAgeMs, snapshotOnly:true, status:stale?'STALE_SNAPSHOT':report.status,
    portfolio:{...report.portfolio,status:portfolioStale?'STALE':report.portfolio?.status},
    assets:Object.fromEntries(Object.entries(report.assets).map(([asset,row])=>{
      const quote=quoteEvidence(row.quote?{mid:row.quote.price,date:row.quote.sourceAsOf,currency:row.quote.currency,
        source:row.quote.source,priceStatus:row.quote.status==='AVAILABLE'?'FRESH':'UNVERIFIED'}:null,row.quote?.fetchedAt,now,maxAgeMs);
      const viewSeries=series=>{
        if(!series||series.status==='UNAVAILABLE')return series;
        const ms=age(series.fetchedAt,now);
        return {...series,status:ms===null||ms<0||ms>historyMaxAgeMs?'STALE':series.status};
      };
      return [asset,{...row,status:quote.status==='AVAILABLE'?row.status:'PARTIAL',quote,
        intraday:viewSeries(row.intraday),daily:viewSeries(row.daily),
        benchmark:stale?{...row.benchmark,status:'STALE_SNAPSHOT',reason:'HISTORICAL_WINDOW_ONLY_NOT_CURRENT_COMPARISON'}:row.benchmark,
        portfolioLinks:(row.portfolioLinks || []).map(link=>portfolioStale?{...link,held:null,pending:null,correlation:unknown('AGENT_SNAPSHOT_STALE')}:link),
      }];
    })) };
}

module.exports = { buildMarketAnalysisEvidence, compactMarketAnalysisEvidence, marketAnalysisSnapshotView, analyzeSeries, selectCachedSeries, quoteEvidence, compareBenchmark, correlate, reportedNumber };
