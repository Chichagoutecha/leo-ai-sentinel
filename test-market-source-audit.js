'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { marketSourceAudit, decisionMarketEvidence } = require('./market-source-audit');
process.env.EXECUTION_QUALITY_AUTO_INSTALL = 'false';
const observer = require('./execution-quality-shadow-agent');
const now = Date.parse('2026-09-29T12:00:00Z');

test('a persisted successful market report becomes stale as time advances', () => {
  const market = { time: '2026-09-29T11:00:00Z', normalized: {
    fetchedAt: '2026-09-29T11:00:00Z', freshCount: 1,
    ratesByAsset: { BTC: { source: 'ETORO_PUBLIC_API', date: '2026-09-29T11:00:00Z',
      priceStatus: 'FRESH', eligibleForTrade: true } }
  } };
  const health = { providers: { eToro: { configured: true, tested: true,
    lastSuccessAt: '2026-09-29T11:00:00Z' } } };
  const audit = marketSourceAudit(market, { generatedAt: '2026-09-29T11:00:00Z' }, health, now);
  assert.equal(audit.marketSnapshotFresh, false);
  assert.equal(audit.fusionSnapshotFresh, false);
  assert.equal(audit.assets.BTC.freshNow, false);
  assert.equal(audit.providers.eToro.freshMarketQuoteProven, false);
});

test('missing timestamps and secondary provider success cannot certify live execution', () => {
  const audit = marketSourceAudit({ normalized: { fetchedAt: '2026-09-29T11:59:00Z',
    freshCount: 0, ratesByAsset: { BTC: { priceStatus: 'FRESH', eligibleForTrade: true } } } }, null,
  { providers: { 'Twelve Data': { configured: true, tested: true,
    lastSuccessAt: '2026-09-29T11:59:00Z' } } }, now);
  assert.equal(audit.assets.BTC.freshNow, false);
  assert.equal(audit.providers['Twelve Data'].freshMarketQuoteProven, false);
  assert.equal(audit.fusionSnapshotFresh, false);
});

test('decision evidence retains eToro price provenance without treating consensus as execution price', () => {
  const evidence = decisionMarketEvidence('BTC', { fetchedAt: '2026-09-29T11:59:00Z',
    ratesByAsset: { BTC: { mid: 70000, instrumentId: 100109,
      date: '2026-09-29T11:58:00Z', priceStatus: 'FRESH', eligibleForTrade: true } } },
  { generatedAt: '2026-09-29T11:59:00Z', comparisons: {
    BTC: { status: 'CONSENSUS', consensusProviders: ['eToro', 'Twelve Data'], consensusPrice: 70100 }
  } }, now);
  assert.equal(evidence.price, 70000);
  assert.equal(evidence.freshAtDecision, true);
  assert.equal(evidence.consensusStatus, 'CONSENSUS');
  assert.equal(evidence.executionReference, 'eToro');
  const trace = observer.runWithDecision({ action: 'BUY', asset: 'BTC',
    marketEvidence: evidence }, () => observer._test.makeBuyObservation({ instrumentId: 100109, amount: 10 }));
  assert.equal(trace.decisionTrace.marketEvidence.price, 70000);
  assert.equal(trace.decisionTrace.marketEvidence.sourceTimestamp, '2026-09-29T11:58:00Z');
});
