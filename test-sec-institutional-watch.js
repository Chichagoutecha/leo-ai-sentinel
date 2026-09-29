'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBlackRockFilings, institutionalWatchStatus, REFRESH_INTERVAL_MS } = require('./sec-institutional-watch');

test('BlackRock 13F metadata retains quarter date separately from public acceptance', () => {
  const rows = normalizeBlackRockFilings({ cik: 1364742, filings: { recent: {
    form: ['8-K', '13F-HR', '13F-HR/A'],
    accessionNumber: ['0001086364-26-000001', '0001086364-26-000002', '0001086364-26-000003'],
    filingDate: ['2026-08-10', '2026-08-15', '2026-08-17'],
    reportDate: ['2026-06-30', '2026-06-30', '2026-06-30'],
    acceptanceDateTime: [null, '2026-08-15T18:00:00Z', null]
  } } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reportDate, '2026-06-30');
  assert.equal(rows[0].acceptedAt, '2026-08-15T18:00:00.000Z');
  assert.equal(rows[1].availableAtPrecision, 'FILING_DATE_ONLY');
  assert.equal(rows[0].holdingsParsed, false);
  assert.equal(rows[0].tradeSignal, false);
});

test('malformed SEC response fails closed and status does not claim full or live holdings', () => {
  assert.throws(() => normalizeBlackRockFilings({ cik: 1364742, filings: { recent: { form: ['13F-HR'] } } }),
    /SEC_INVALID_SUBMISSIONS/);
  assert.throws(() => normalizeBlackRockFilings({ cik: 42 }), /SEC_WRONG_FILER/);
  const now = Date.parse('2026-09-29T12:00:00Z');
  const stale = institutionalWatchStatus({ checkedAt: new Date(now - REFRESH_INTERVAL_MS).toISOString(), filings: [] }, true, now);
  assert.equal(stale.cacheFresh, false);
  assert.equal(stale.historyComplete, false);
  assert.equal(stale.tradeSignal, false);
  assert.equal(institutionalWatchStatus(null, false, now).cacheFresh, false);
});
