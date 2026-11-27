'use strict';

const { randomUUID } = require('node:crypto');

const SEARCH_ENDPOINT = 'https://public-api.etoro.com/api/v1/market-data/search';
const RATES_ENDPOINT = 'https://public-api.etoro.com/api/v1/market-data/instruments/rates';
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.:-]{0,31}$/;
const CANDIDATE_CATEGORIES = new Set(['ETF', 'STOCK', 'CRYPTO']);
const SECTOR_INTERESTS = new Set([
  'AI_SEMICONDUCTORS', 'CYBERSECURITY', 'ROBOTICS_AUTOMATION',
  'HEALTHCARE_MEDTECH', 'ENERGY_ELECTRIFICATION', 'OTHER'
]);

function normalizeSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  return SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

function parseAnalysisCandidates(raw) {
  let values;
  try {
    values = Array.isArray(raw) ? raw : JSON.parse(String(raw || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(values)) return [];
  const byIdentity = new Map();
  for (const value of values.slice(0, 250)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const symbol = normalizeSymbol(value.symbol);
    const instrumentId = Number(value.instrumentId ?? value.InstrumentID);
    if (!symbol || !Number.isSafeInteger(instrumentId) || instrumentId <= 0) continue;
    const categoryValue = String(value.category || '').trim().toUpperCase();
    const category = CANDIDATE_CATEGORIES.has(categoryValue) ? categoryValue : 'UNCLASSIFIED';
    const sector = String(value.sectorInterest || value.sector || '').trim().toUpperCase();
    const knownSector = SECTOR_INTERESTS.has(sector) ? sector : null;
    const row = {
      symbol, instrumentId, category,
      sectorInterest: knownSector,
      sectorProvenance: knownSector ? 'USER_CONFIGURED_UNVERIFIED' : 'UNKNOWN',
      source: String(value.source || 'MANUAL_CONFIGURATION').slice(0, 120),
      observedAt: typeof value.observedAt === 'string' ? value.observedAt.slice(0, 64) : null,
      identityStatus: 'CONFIGURED_UNVERIFIED',
      eToroAvailability: 'NOT_VERIFIED',
      technicalEligibility: 'NOT_CHECKED',
      riskAuthorization: 'NOT_EVALUATED',
      buyAuthorization: 'NOT_AUTHORIZED'
    };
    const key = String(instrumentId);
    if (!byIdentity.has(key) && ![...byIdentity.values()].some(item => item.symbol === symbol)) byIdentity.set(key, row);
  }
  return [...byIdentity.values()];
}

function extractSearchRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  for (const key of ['items', 'Items', 'results', 'Results', 'instruments', 'Instruments']) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (('internalSymbolFull' in data || 'InternalSymbolFull' in data) &&
      ('InstrumentID' in data || 'instrumentId' in data || 'instrumentID' in data)) return [data];
  return null;
}

function readSymbol(row) {
  return String(row?.internalSymbolFull ?? row?.InternalSymbolFull ?? '').trim().toUpperCase();
}

function readInstrumentId(row) {
  const value = Number(row?.instrumentId ?? row?.InstrumentID ?? row?.instrumentID);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function resolveSearchMatch(data, symbol, now = new Date().toISOString(), sectorInterest = null) {
  const rows = extractSearchRows(data);
  if (!rows) return { status: 'UNVERIFIED', reason: 'UNEXPECTED_SEARCH_SCHEMA' };
  const exact = rows.filter(row => readSymbol(row) === symbol);
  if (!exact.length) return { status: 'NOT_FOUND', reason: 'NO_EXACT_SYMBOL_MATCH' };
  if (exact.length !== 1) return { status: 'UNVERIFIED', reason: 'AMBIGUOUS_EXACT_MATCH' };
  const instrumentId = readInstrumentId(exact[0]);
  if (!instrumentId) return { status: 'UNVERIFIED', reason: 'INVALID_INSTRUMENT_ID' };
  return {
    status: 'DISCOVERED_CANDIDATE',
    candidate: {
      symbol, instrumentId, category: 'UNCLASSIFIED',
      sectorInterest: sectorInterest || null,
      sectorProvenance: sectorInterest ? 'USER_CONFIGURED_UNVERIFIED' : 'UNKNOWN',
      listingVenue: null,
      identityStatus: 'EXACT_ETORO_SYMBOL_MATCH',
      eToroAvailability: 'INSTRUMENT_FOUND_AVAILABILITY_UNVERIFIED',
      technicalEligibility: 'NOT_CHECKED',
      riskAuthorization: 'NOT_EVALUATED',
      buyAuthorization: 'NOT_AUTHORIZED',
      source: SEARCH_ENDPOINT,
      observedAt: now
    }
  };
}

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['rates', 'Rates', 'items', 'Items', 'data', 'Data']) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

function quoteForInstrument(data, instrumentId, now = Date.now()) {
  const rows = extractRows(data).filter(row => readInstrumentId(row) === instrumentId);
  if (rows.length !== 1) return { status: rows.length ? 'UNVERIFIED' : 'UNAVAILABLE', reason: rows.length ? 'AMBIGUOUS_RATE_IDENTITY' : 'NO_RATE_FOR_INSTRUMENT' };
  const row = rows[0];
  const bid = Number(row.bid ?? row.Bid ?? row.BID);
  const ask = Number(row.ask ?? row.Ask ?? row.ASK);
  const last = Number(row.lastExecution ?? row.LastExecution ?? row.last ?? row.Last ?? row.price ?? row.Price);
  const price = Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0
    ? (bid + ask) / 2
    : Number.isFinite(last) && last > 0 ? last : null;
  const rawTime = row.date ?? row.Date ?? row.time ?? row.Time ?? row.timestamp ?? row.Timestamp ??
    row.lastExecutionTime ?? row.LastExecutionTime ?? row.lastUpdate ?? row.LastUpdate ?? row.lastUpdated ?? row.LastUpdated;
  const timestamp = typeof rawTime === 'number' ? rawTime : Date.parse(String(rawTime || ''));
  return {
    status: price ? 'OBSERVED' : 'UNAVAILABLE',
    reason: price ? null : 'NO_VALID_PRICE',
    price,
    bid: Number.isFinite(bid) && bid > 0 ? bid : null,
    ask: Number.isFinite(ask) && ask > 0 ? ask : null,
    observedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    ageMinutes: Number.isFinite(timestamp) ? Math.max(0, Math.round((now - timestamp) / 60000)) : null,
    freshness: Number.isFinite(timestamp) && timestamp <= now ? 'TIMESTAMPED_UNVERIFIED_POLICY' : 'UNVERIFIED'
  };
}

function normalizeSector(value) {
  const sector = String(value || '').trim().toUpperCase();
  return SECTOR_INTERESTS.has(sector) ? sector : null;
}

function createCandidateDiscoveryClient({
  env = process.env,
  fetchImpl = global.fetch,
  headersFactory = () => ({ 'x-api-key': env.ETORO_API_KEY, 'x-user-key': env.ETORO_USER_KEY, 'x-request-id': randomUUID() }),
  clock = Date.now,
  timeoutMs = 8000,
  cacheMs = 5 * 60 * 1000,
  maxLookupsPerMinute = 10
} = {}) {
  const cache = new Map();
  const calls = [];
  async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(10, Math.min(Number(timeoutMs) || 8000, 10000)));
    try {
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...headersFactory() }
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, status: response.status, data: null };
      }
      return { ok: true, status: response.status, data: await response.json() };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async lookup({ symbol: rawSymbol, sectorInterest } = {}) {
      const symbol = normalizeSymbol(rawSymbol);
      const sector = normalizeSector(sectorInterest);
      const now = clock();
      if (!symbol) return { status: 'INVALID_REQUEST', reason: 'INVALID_SYMBOL', executionAttempted: false };
      if (!env.ETORO_API_KEY || !env.ETORO_USER_KEY) return { status: 'NOT_TESTED', reason: 'CREDENTIALS_ABSENT', executionAttempted: false };
      const cached = cache.get(symbol);
      if (cached && now - cached.at < cacheMs) return { ...cached.value, cache: 'HIT' };
      while (calls.length && now - calls[0] >= 60000) calls.shift();
      if (calls.length >= maxLookupsPerMinute) return { status: 'RATE_LIMITED', reason: 'LOCAL_QUOTA', executionAttempted: false };
      calls.push(now);
      try {
        const searchUrl = new URL(SEARCH_ENDPOINT);
        searchUrl.searchParams.set('internalSymbolFull', symbol);
        const search = await getJson(searchUrl.toString());
        if (!search.ok) return { status: search.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE', reason: 'SEARCH_HTTP_FAILURE', httpStatus: search.status, executionAttempted: false };
        const found = resolveSearchMatch(search.data, symbol, new Date(now).toISOString(), sector);
        if (found.status !== 'DISCOVERED_CANDIDATE') return { ...found, source: SEARCH_ENDPOINT, executionAttempted: false };
        const quoteUrl = new URL(RATES_ENDPOINT);
        quoteUrl.searchParams.set('instrumentIds', String(found.candidate.instrumentId));
        const rates = await getJson(quoteUrl.toString());
        const quote = rates.ok
          ? quoteForInstrument(rates.data, found.candidate.instrumentId, now)
          : { status: rates.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE', reason: 'RATE_HTTP_FAILURE' };
        const value = {
          status: 'DISCOVERED_CANDIDATE', candidate: found.candidate,
          quote: { ...quote, source: RATES_ENDPOINT, executionAttempted: false },
          technicalEligibility: 'NOT_CHECKED', riskAuthorization: 'NOT_EVALUATED',
          buyAuthorization: 'NOT_AUTHORIZED', decision: null,
          source: SEARCH_ENDPOINT, observedAt: new Date(now).toISOString(), executionAttempted: false
        };
        cache.set(symbol, { at: now, value });
        return { ...value, cache: 'MISS' };
      } catch {
        return { status: 'UNAVAILABLE', reason: 'READ_ONLY_LOOKUP_FAILED', executionAttempted: false };
      }
    }
  };
}

module.exports = {
  SEARCH_ENDPOINT, RATES_ENDPOINT, normalizeSymbol, normalizeSector,
  parseAnalysisCandidates, resolveSearchMatch, quoteForInstrument,
  createCandidateDiscoveryClient
};
