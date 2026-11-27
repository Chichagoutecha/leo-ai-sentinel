'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const discovery = require('./analysis-candidate-discovery');

test('manual candidate configuration is bounded, deduplicated, and never authorizes a buy', () => {
  const rows = discovery.parseAnalysisCandidates(JSON.stringify([
    { symbol: ' nvda ', instrumentId: 8760, category: 'STOCK', sector: 'AI_SEMICONDUCTORS', source: 'manual', observedAt: '2026-11-27T09:00:00Z' },
    { symbol: 'NVDA', instrumentId: 8760, category: 'STOCK' },
    { symbol: 'XYZ', instrumentId: 2000, category: 'UNKNOWN', sector: 'MADE_UP' },
    { symbol: 'BAD!', instrumentId: 3000, category: 'ETF' },
    { symbol: 'MISSING_ID', category: 'ETF' }
  ]));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].identityStatus, 'CONFIGURED_UNVERIFIED');
  assert.equal(rows[0].sectorProvenance, 'USER_CONFIGURED_UNVERIFIED');
  assert.equal(rows[0].eToroAvailability, 'NOT_VERIFIED');
  assert.equal(rows[0].technicalEligibility, 'NOT_CHECKED');
  assert.equal(rows[0].riskAuthorization, 'NOT_EVALUATED');
  assert.equal(rows[0].buyAuthorization, 'NOT_AUTHORIZED');
  assert.equal(rows[1].category, 'UNCLASSIFIED');
  assert.equal(rows[1].sectorInterest, null);
});

test('exact symbol resolution rejects partial, ambiguous, malformed and unknown matches', () => {
  assert.equal(discovery.resolveSearchMatch({ items: [{ internalSymbolFull: 'NVDA.US', InstrumentID: 1 }] }, 'NVDA').status, 'NOT_FOUND');
  assert.equal(discovery.resolveSearchMatch({ items: [{ internalSymbolFull: 'NVDA', InstrumentID: 1 }, { internalSymbolFull: 'NVDA', InstrumentID: 2 }] }, 'NVDA').reason, 'AMBIGUOUS_EXACT_MATCH');
  assert.equal(discovery.resolveSearchMatch({ items: [{ internalSymbolFull: 'NVDA', InstrumentID: 0 }] }, 'NVDA').reason, 'INVALID_INSTRUMENT_ID');
  assert.equal(discovery.resolveSearchMatch({ unexpected: [] }, 'NVDA').status, 'UNVERIFIED');
  const found = discovery.resolveSearchMatch({ items: [{ internalSymbolFull: 'NVDA', InstrumentID: 8760, instrumentType: 'stock', exchange: 'NASDAQ' }] }, 'NVDA', '2026-11-27T10:00:00.000Z');
  assert.equal(found.status, 'DISCOVERED_CANDIDATE');
  assert.equal(found.candidate.instrumentId, 8760);
  assert.equal(found.candidate.category, 'UNCLASSIFIED');
  assert.equal(found.candidate.listingVenue, null);
  assert.equal(found.candidate.eToroAvailability, 'INSTRUMENT_FOUND_AVAILABILITY_UNVERIFIED');
  assert.equal(found.candidate.technicalEligibility, 'NOT_CHECKED');
  assert.equal(found.candidate.buyAuthorization, 'NOT_AUTHORIZED');
});

test('quote normalization requires the discovered instrument ID and keeps stale policy unverified', () => {
  const quote = discovery.quoteForInstrument({ rates: [
    { instrumentId: 8760, bid: 99, ask: 101, date: '2026-11-27T09:30:00Z' },
    { instrumentId: 7777, bid: 5, ask: 5, date: '2026-11-27T09:59:00Z' }
  ] }, 8760, Date.parse('2026-11-27T10:00:00Z'));
  assert.equal(quote.status, 'OBSERVED');
  assert.equal(quote.price, 100);
  assert.equal(quote.ageMinutes, 30);
  assert.equal(quote.freshness, 'TIMESTAMPED_UNVERIFIED_POLICY');
  assert.equal(discovery.quoteForInstrument({ rates: [{ instrumentId: 7777, bid: 4, ask: 5 }] }, 8760).status, 'UNAVAILABLE');
});

test('lookup uses only exact-symbol read-only GETs, caches, and never calls an order endpoint', async () => {
  const requests = [];
  const now = Date.parse('2026-11-27T10:00:00Z');
  const client = discovery.createCandidateDiscoveryClient({
    env: { ETORO_API_KEY: 'public-test', ETORO_USER_KEY: 'user-test' },
    clock: () => now,
    headersFactory: () => ({ 'x-api-key': 'public-test', 'x-user-key': 'user-test', 'x-request-id': 'request-test' }),
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), method: options.method });
      if (String(url).includes('/market-data/search')) return { ok: true, status: 200, json: async () => ({ items: [{ internalSymbolFull: 'AMD', InstrumentID: 1832 }] }) };
      if (String(url).includes('/market-data/instruments/rates')) return { ok: true, status: 200, json: async () => ({ rates: [{ instrumentId: 1832, bid: 10, ask: 12, date: '2026-11-27T09:59:00Z' }] }) };
      throw new Error('unexpected endpoint');
    }
  });
  const first = await client.lookup({ symbol: 'amd', sectorInterest: 'AI_SEMICONDUCTORS' });
  const second = await client.lookup({ symbol: 'AMD' });
  assert.equal(first.status, 'DISCOVERED_CANDIDATE');
  assert.equal(first.quote.price, 11);
  assert.equal(first.buyAuthorization, 'NOT_AUTHORIZED');
  assert.equal(first.decision, null);
  assert.equal(first.executionAttempted, false);
  assert.equal(second.cache, 'HIT');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(row => row.method === 'GET'));
  assert.ok(requests.every(row => !row.url.includes('/trading/execution/')));
  assert.ok(requests.some(row => row.url.includes('internalSymbolFull=AMD')));
});

test('invalid, unknown-sector, missing-credential and provider-error cases fail closed', async () => {
  let calls = 0;
  const client = discovery.createCandidateDiscoveryClient({
    env: { ETORO_API_KEY: 'k', ETORO_USER_KEY: 'u' },
    headersFactory: () => ({}),
    fetchImpl: async () => { calls++; return { ok: false, status: 403, body: { cancel: async () => {} } }; }
  });
  assert.equal((await client.lookup({ symbol: '../orders' })).status, 'INVALID_REQUEST');
  assert.equal((await discovery.createCandidateDiscoveryClient({ env: {} }).lookup({ symbol: 'AMD' })).status, 'NOT_TESTED');
  const denied = await client.lookup({ symbol: 'AMD', sectorInterest: 'AI_MADE_UP' });
  assert.equal(denied.status, 'UNAVAILABLE');
  assert.equal(denied.reason, 'SEARCH_HTTP_FAILURE');
  assert.equal(calls, 1);
});
