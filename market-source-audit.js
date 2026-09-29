'use strict';

function ageMinutes(value, now) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.round((now - timestamp) / 6000) / 10;
}

function marketSourceAudit(lastMarketData, fusion, health, now = Date.now(), maxAgeMinutes = 30) {
  const market = lastMarketData?.normalized;
  const marketAge = ageMinutes(market?.fetchedAt || lastMarketData?.time, now);
  const fusionAge = ageMinutes(fusion?.generatedAt, now);
  const providerHealth = health?.providers || {};
  const providers = Object.fromEntries(['eToro', 'Twelve Data', 'Alpha Vantage'].map((name) => {
    const state = providerHealth[name] || {};
    const lastSuccessAgeMinutes = ageMinutes(state.lastSuccessAt, now);
    return [name, {
      configured: state.configured === true,
      tested: state.tested === true,
      lastSuccessAt: state.lastSuccessAt || null,
      lastSuccessAgeMinutes,
      lastFailureAt: state.lastFailureAt || null,
      lastStatus: state.lastStatus ?? null,
      lastError: state.lastError || null,
      quarantined: state.quarantined === true,
      // Success at another endpoint or asset is not proof of a fresh quote.
      freshMarketQuoteProven: false
    }];
  }));
  const assets = Object.fromEntries(Object.entries(market?.ratesByAsset || {}).map(([asset, rate]) => {
    const quoteAge = ageMinutes(rate?.date, now);
    return [asset, {
      source: rate?.source || null, sourceTimestamp: rate?.date || null,
      quoteAgeMinutes: quoteAge, fetchedAt: market?.fetchedAt || lastMarketData?.time || null,
      fetchAgeMinutes: marketAge, priceStatusAtFetch: rate?.priceStatus || null,
      freshNow: rate?.priceStatus === 'FRESH' && rate?.eligibleForTrade === true &&
        quoteAge !== null && quoteAge >= 0 && quoteAge <= maxAgeMinutes &&
        marketAge !== null && marketAge >= 0 && marketAge <= maxAgeMinutes
    }];
  }));
  providers.eToro.freshMarketQuoteProven = Object.values(assets).some((entry) => entry.freshNow);
  return {
    observedAt: new Date(now).toISOString(), readOnly: true,
    marketFetchedAt: market?.fetchedAt || lastMarketData?.time || null,
    marketFetchAgeMinutes: marketAge,
    marketSnapshotFresh: marketAge !== null && marketAge >= 0 && marketAge <= maxAgeMinutes,
    fusionGeneratedAt: fusion?.generatedAt || null, fusionAgeMinutes: fusionAge,
    fusionSnapshotFresh: fusionAge !== null && fusionAge >= 0 && fusionAge <= maxAgeMinutes,
    providers, assets,
    caveat: 'A successful provider call does not prove every quote is fresh. Closed markets and missing source timestamps are not live prices.'
  };
}

function decisionMarketEvidence(asset, marketSummary, fusion, now = Date.now(), maxAgeMinutes = 30) {
  const rate = marketSummary?.ratesByAsset?.[asset] || null;
  const comparison = fusion?.comparisons?.[asset] || null;
  const quoteAge = ageMinutes(rate?.date, now);
  const fetchAge = ageMinutes(marketSummary?.fetchedAt, now);
  return {
    asset, capturedAt: new Date(now).toISOString(),
    executionReference: 'eToro', price: Number.isFinite(rate?.mid) ? rate.mid : null,
    instrumentId: rate?.instrumentId ?? null, sourceTimestamp: rate?.date || null,
    quoteAgeMinutes: quoteAge, fetchedAt: marketSummary?.fetchedAt || null,
    fetchAgeMinutes: fetchAge, priceStatusAtFetch: rate?.priceStatus || 'MISSING',
    freshAtDecision: rate?.priceStatus === 'FRESH' && rate?.eligibleForTrade === true &&
      quoteAge !== null && quoteAge >= 0 && quoteAge <= maxAgeMinutes &&
      fetchAge !== null && fetchAge >= 0 && fetchAge <= maxAgeMinutes,
    consensusStatus: comparison?.status || 'NOT_CHECKED',
    consensusGeneratedAt: fusion?.generatedAt || null,
    consensusAgeMinutes: ageMinutes(fusion?.generatedAt, now),
    consensusProviders: comparison?.consensusProviders || [],
    analysisOnly: true
  };
}

module.exports = { marketSourceAudit, decisionMarketEvidence };
