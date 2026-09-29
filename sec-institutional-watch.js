'use strict';

const BLACKROCK_CIK = '0001364742';
const ENDPOINT = `https://data.sec.gov/submissions/CIK${BLACKROCK_CIK}.json`;
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

function normalizeBlackRockFilings(data) {
  if (Number(data?.cik) !== Number(BLACKROCK_CIK))
    throw new Error('SEC_WRONG_FILER');
  const recent = data?.filings?.recent;
  if (!recent || !Array.isArray(recent.form) || !Array.isArray(recent.accessionNumber) ||
      !Array.isArray(recent.filingDate) || !Array.isArray(recent.reportDate))
    throw new Error('SEC_INVALID_SUBMISSIONS');
  const filings = [];
  const seen = new Set();
  for (let i = 0; i < Math.min(recent.form.length, 1000) && filings.length < 5; i++) {
    const form = recent.form[i];
    if (form !== '13F-HR' && form !== '13F-HR/A') continue;
    const accession = recent.accessionNumber[i];
    const filingDate = recent.filingDate[i];
    const reportDate = recent.reportDate[i];
    if (!/^\d{10}-\d{2}-\d{6}$/.test(String(accession)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(filingDate)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(reportDate)) ||
        !Number.isFinite(Date.parse(filingDate)) || !Number.isFinite(Date.parse(reportDate)) ||
        reportDate > filingDate || seen.has(accession)) continue;
    seen.add(accession);
    const accepted = recent.acceptanceDateTime?.[i];
    const acceptedAt = typeof accepted === 'string' && Number.isFinite(Date.parse(accepted))
      ? new Date(accepted).toISOString() : null;
    filings.push({
      manager: 'BlackRock Inc.', cik: BLACKROCK_CIK, form, accessionNumber: accession,
      reportDate, filingDate, acceptedAt,
      availableAtPrecision: acceptedAt ? 'ACCEPTANCE_TIMESTAMP' : 'FILING_DATE_ONLY',
      sourceUrl: `https://www.sec.gov/Archives/edgar/data/1364742/${accession.replace(/-/g, '')}/${accession}-index.htm`,
      holdingsParsed: false, tradeSignal: false
    });
  }
  return filings;
}

function institutionalWatchStatus(snapshot, configured, now = Date.now()) {
  const checkedAt = snapshot?.checkedAt || null;
  const age = checkedAt ? (now - Date.parse(checkedAt)) / 60000 : NaN;
  return {
    source: 'SEC_EDGAR_BLACKROCK_13F', configured, readOnly: true,
    checkedAt, ageMinutes: Number.isFinite(age) ? Math.round(age * 10) / 10 : null,
    cacheFresh: Number.isFinite(age) && age >= 0 && age * 60000 < REFRESH_INTERVAL_MS,
    filings: Array.isArray(snapshot?.filings) ? snapshot.filings.slice(0, 5) : [],
    historyComplete: false, holdingsParsed: false, tradeSignal: false,
    note: '13F holdings are quarterly and published later. This is filing metadata, not live BlackRock trades or a buy signal.'
  };
}

module.exports = { BLACKROCK_CIK, ENDPOINT, REFRESH_INTERVAL_MS,
  normalizeBlackRockFilings, institutionalWatchStatus };
