'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeExposure } = require('./portfolio-exposure-view');
const now = Date.parse('2026-10-30T12:00:00Z');
const positions = [
  { asset: 'FUND', positionId: 1, category: 'ETF', estimatedValue: 100 },
  { asset: 'NVDA', positionId: 2, category: 'STOCK', estimatedValue: 10 }
];
// Synthetic API contract fixture; no constituent endpoint is configured in production.
const composition = { symbol: 'FUND', sourceType: 'OFFICIAL_ETORO_API', sourceUrl: 'fixture://official-response', documentationUrl: 'fixture://documented-schema', asOf: '2026-10-29T12:00:00Z', capturedAt: '2026-10-29T13:00:00Z', complete: true, valuationCurrency: 'USD', holdings: [
  { symbol: 'NVDA', weightPct: 50, exposureMetadata: { sector: 'Technology', currency: 'USD' } },
  { symbol: 'OTHER', weightPct: 50 }
] };
const run = (overrides = {}) => analyzeExposure({ now, positions, compositions: [composition], valuationCurrency: 'USD', ...overrides });
test('complete compositions decompose held value without double-counting the fund', () => {
  const result = run();
  assert.deepEqual(result.combined, { NVDA: 60, OTHER: 50 });
  assert.equal(result.combined.FUND, undefined);
  assert.equal(result.overlaps[0].instrument, 'NVDA');
  assert.equal(result.dimensions.sector.status, 'INCOMPLETE');
  assert.equal(result.dimensions.issuer.status, 'UNAVAILABLE');
});
test('duplicate positions are deduplicated; contradictory duplicates are unavailable', () => {
  assert.deepEqual(run({ positions: [...positions, positions[0]] }).combined, run().combined);
  const conflict = run({ positions: [...positions, { ...positions[0], estimatedValue: 200 }] });
  assert.equal(conflict.combined, null);
  assert.ok(conflict.unavailable.some(row => row.reason === 'CONFLICTING_POSITION_DUPLICATES'));
});
test('stale, partial, duplicate and conflicting constituent snapshots cannot produce totals', () => {
  for (const bad of [
    { ...composition, asOf: '2026-01-01T00:00:00Z' },
    { ...composition, complete: false },
    { ...composition, holdings: [composition.holdings[0]] },
    { ...composition, holdings: [composition.holdings[0], composition.holdings[0]] },
    { ...composition, sourceType: 'SCRAPE' },
    { ...composition, valuationCurrency: 'EUR' }
  ]) assert.equal(run({ compositions: [bad] }).combined, null);
  assert.equal(run({ compositions: [{ ...composition, asOf: '2026-01-01T00:00:00Z' }] }).baskets.ETF[0].status, 'STALE');
  assert.equal(run({ compositions: [composition, { ...composition, complete: false }] }).combined, null);
});
test('unknown compositions, missing values and unknown instruments do not become zero exposure', () => {
  const result = run({ compositions: [] });
  assert.equal(result.indirect, null);
  assert.equal(result.combined, null);
  assert.equal(result.baskets.ETF[0].status, 'UNAVAILABLE');
  assert.equal(run({ positions: [{ asset: 'NVDA', estimatedValue: null }] }).coverage, 'INCOMPLETE');
  const unknown = run({ positions: [{ asset: 'UNKNOWN', instrumentId: 999, estimatedValue: 10 }], compositions: [] });
  assert.equal(unknown.direct['INSTRUMENT:999'], 10);
  assert.equal(unknown.combined, null);
});
test('calculations are reproducible under reordered inputs', () => {
  const forward = run();
  const backward = run({ positions: [...positions].reverse(), compositions: [{ ...composition, holdings: [...composition.holdings].reverse() }] });
  assert.deepEqual(forward.combined, backward.combined);
  assert.deepEqual(forward.dimensions, backward.dimensions);
  assert.equal(forward.executionAttempted, false);
});
test('Smart Portfolios stay read-only and cash is separate from security exposure', () => {
  const result = run({ positions: [{ ...positions[0], category: 'SMART_PORTFOLIO' }], cash: 25 });
  assert.equal(result.readOnly, true);
  assert.equal(result.executionAttempted, false);
  assert.equal(result.baskets.SMART_PORTFOLIO[0].status, 'COMPLETE');
  assert.deepEqual(result.combined, { NVDA: 50, OTHER: 50 });
  assert.deepEqual(result.cash, { value: 25, currency: 'USD', status: 'AVAILABLE' });
  assert.equal(run({ valuationCurrency: null }).combined, null);
  assert.equal(run({ compositions: [{ ...composition, sourceUrl: null }] }).combined, null);
});
