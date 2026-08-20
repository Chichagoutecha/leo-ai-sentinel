'use strict';

/**
 * LEO eToro UCITS execution bridge.
 *
 * Purpose:
 * - Keep the strategy/research universe on the established US analysis symbols
 *   (SPY, QQQ, GLD, SHY, TLT, XLV, XLP, XLE).
 * - Prevent those mapped US ETF/ETP instrument IDs from being sent directly to
 *   eToro when the account cannot trade the CFD form.
 * - In explicitly enabled LIVE bridge mode, resolve an approved European
 *   UCITS/ETC symbol to its immutable eToro instrumentId and rewrite ONLY the
 *   already-authorized BUY request emitted by index.js.
 * - Translate the UCITS/ETC instrumentId back to the analysis instrumentId in
 *   REAL PnL reads so the existing allocation, verifier and SELL-by-positionId
 *   logic continue to see the strategy asset identity.
 *
 * Safety contract:
 * - Default mode is "guard": mapped US ETF BUY requests are blocked, not sent.
 * - Mode "live" still requires an explicit approved-symbol allowlist.
 * - Exact internalSymbolFull matching is mandatory; partial search matches fail.
 * - The execution venue must be open and the target quote fresh/tradable.
 * - This preload never creates an order on its own; it can only rewrite a BUY
 *   request that index.js already decided and attempted to send.
 * - No leverage, amount, side, action, order type or currency is modified.
 */

const { randomUUID } = require('crypto');

const VERSION = 'v10.22.12.0-etoro-ucits-execution-bridge';
const SEARCH_ENDPOINT = 'https://public-api.etoro.com/api/v1/market-data/search';
const RATES_ENDPOINT = 'https://public-api.etoro.com/api/v1/market-data/instruments/rates';
const REAL_PNL_PATH = '/api/v1/trading/info/real/pnl';
const REAL_ORDER_PATH = '/api/v2/trading/execution/orders';

const EXECUTION_MAP = Object.freeze({
  SPY: Object.freeze({ analysisInstrumentId: 3417, executionSymbol: 'CSPX.L', venue: 'LSE' }),
  QQQ: Object.freeze({ analysisInstrumentId: 3418, executionSymbol: 'CNDX.L', venue: 'LSE' }),
  GLD: Object.freeze({ analysisInstrumentId: 15634, executionSymbol: 'IGLN.L', venue: 'LSE' }),
  SHY: Object.freeze({ analysisInstrumentId: 3100, executionSymbol: 'IBTA.L', venue: 'LSE' }),
  TLT: Object.freeze({ analysisInstrumentId: 3020, executionSymbol: 'DTLA.L', venue: 'LSE' }),
  XLV: Object.freeze({ analysisInstrumentId: 3017, executionSymbol: 'ZPDH.DE', venue: 'XETRA' }),
  XLP: Object.freeze({ analysisInstrumentId: 3022, executionSymbol: 'XDWS.DE', venue: 'XETRA' }),
  XLE: Object.freeze({ analysisInstrumentId: 3008, executionSymbol: 'ZPDE.DE', venue: 'XETRA' })
});

const BY_ANALYSIS_ID = new Map(
  Object.entries(EXECUTION_MAP).map(([analysisAsset, value]) => [
    Number(value.analysisInstrumentId),
    Object.freeze({ analysisAsset, ...value })
  ])
);

function normalizedMode(value = process.env.ETORO_UCITS_EXECUTION_MODE) {
  const mode = String(value || 'guard').trim().toLowerCase();
  return ['off', 'guard', 'live'].includes(mode) ? mode : 'guard';
}

function approvedSymbols(value = process.env.ETORO_UCITS_APPROVED_SYMBOLS) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean)
  );
}

function boundedNumber(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function safeUrl(input) {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input && typeof input.url === 'string') return new URL(input.url);
  } catch {}
  return null;
}

function requestMethod(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function requestHeaders(input, init) {
  const headers = new Headers(input?.headers || undefined);
  if (init?.headers) {
    const extra = new Headers(init.headers);
    for (const [key, value] of extra.entries()) headers.set(key, value);
  }
  return headers;
}

function authHeaders(input, init) {
  const source = requestHeaders(input, init);
  const headers = new Headers();
  for (const key of ['x-api-key', 'x-user-key']) {
    const value = source.get(key);
    if (value) headers.set(key, value);
  }
  headers.set('x-request-id', randomUUID());
  return headers;
}

function bodyText(init) {
  if (!init || init.body == null) return null;
  if (typeof init.body === 'string') return init.body;
  if (Buffer.isBuffer(init.body)) return init.body.toString('utf8');
  return null;
}

function parseJsonBody(init) {
  const text = bodyText(init);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function numberField(object, names) {
  if (!object || typeof object !== 'object') return null;
  for (const name of names) {
    const value = Number(object[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function stringField(object, names) {
  if (!object || typeof object !== 'object') return null;
  for (const name of names) {
    if (object[name] != null) return String(object[name]);
  }
  return null;
}

function instrumentIdOf(object) {
  return numberField(object, ['instrumentId', 'instrumentID', 'InstrumentId', 'InstrumentID']);
}

function symbolOf(object) {
  return stringField(object, ['internalSymbolFull', 'InternalSymbolFull', 'symbol', 'Symbol']);
}

function collectObjects(value, out = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (!Array.isArray(value)) out.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (child && typeof child === 'object') collectObjects(child, out, seen);
  }
  return out;
}

function exactInstrumentMatch(data, requestedSymbol) {
  const wanted = String(requestedSymbol || '').trim().toUpperCase();
  if (!wanted) return null;
  const matches = collectObjects(data)
    .filter((item) => String(symbolOf(item) || '').trim().toUpperCase() === wanted)
    .map((item) => ({ item, instrumentId: instrumentIdOf(item) }))
    .filter((match) => Number.isFinite(match.instrumentId) && match.instrumentId > 0);
  const uniqueIds = [...new Set(matches.map((match) => match.instrumentId))];
  if (uniqueIds.length !== 1) return null;
  return { symbol: wanted, instrumentId: uniqueIds[0], item: matches[0].item };
}

function parseDate(value) {
  if (value == null) return null;
  const asDate = value instanceof Date ? value : new Date(value);
  return Number.isFinite(asDate.getTime()) ? asDate : null;
}

function quoteTimestamp(rate) {
  const raw = stringField(rate, [
    'date', 'Date', 'timestamp', 'Timestamp', 'lastUpdate', 'LastUpdate',
    'lastExecutionTime', 'LastExecutionTime', 'updatedAt', 'UpdatedAt'
  ]);
  return parseDate(raw);
}

function exactRateMatch(data, instrumentId) {
  const target = Number(instrumentId);
  const rows = collectObjects(data).filter((item) => instrumentIdOf(item) === target);
  for (const rate of rows) {
    const bid = numberField(rate, ['bid', 'Bid', 'BID']);
    const ask = numberField(rate, ['ask', 'Ask', 'ASK']);
    const last = numberField(rate, ['lastExecution', 'LastExecution', 'last', 'Last', 'price', 'Price']);
    if ((Number.isFinite(bid) && bid > 0) || (Number.isFinite(ask) && ask > 0) || (Number.isFinite(last) && last > 0)) {
      return { rate, bid, ask, last, timestamp: quoteTimestamp(rate) };
    }
  }
  return null;
}

function zonedClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: values.weekday,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function isVenueOpen(symbol, date = new Date()) {
  const safe = String(symbol || '').toUpperCase();
  const config = safe.endsWith('.L')
    ? { timeZone: 'Europe/London', open: 8 * 60 + 5, close: 16 * 60 + 20 }
    : safe.endsWith('.DE')
      ? { timeZone: 'Europe/Berlin', open: 9 * 60 + 5, close: 17 * 60 + 20 }
      : null;
  if (!config) return false;
  const clock = zonedClock(date, config.timeZone);
  if (['Sat', 'Sun'].includes(clock.weekday)) return false;
  const minuteOfDay = clock.hour * 60 + clock.minute;
  return minuteOfDay >= config.open && minuteOfDay <= config.close;
}

function bridgeError(code, message, meta = {}) {
  const error = new Error(message);
  error.name = 'LeoEtoroUcitsBridgeError';
  error.code = code;
  error.status = 409;
  error.leoEtoroUcits = meta;
  return error;
}

function log(event, details = {}, level = 'log') {
  const payload = { component: 'LEO_ETORO_UCITS_BRIDGE', version: VERSION, event, at: new Date().toISOString(), ...details };
  global.__LEO_ETORO_UCITS_EXECUTION_BRIDGE_LAST_EVENT__ = payload;
  (console[level] || console.log)(`[LEO_ETORO_UCITS_BRIDGE] ${JSON.stringify(payload)}`);
}

function responseWithJson(original, data) {
  const headers = new Headers(original.headers || undefined);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), {
    status: original.status,
    statusText: original.statusText,
    headers
  });
}

function translateInstrumentIds(value, reverseMap, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  let translated = 0;
  if (!Array.isArray(value)) {
    const current = instrumentIdOf(value);
    const mapping = reverseMap.get(current);
    if (mapping) {
      for (const key of ['instrumentId', 'instrumentID', 'InstrumentId', 'InstrumentID']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) value[key] = mapping.analysisInstrumentId;
      }
      value.leoExecutionInstrumentId = current;
      value.leoExecutionSymbol = mapping.executionSymbol;
      value.leoAnalysisAsset = mapping.analysisAsset;
      translated += 1;
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (child && typeof child === 'object') translated += translateInstrumentIds(child, reverseMap, seen);
  }
  return translated;
}

function installBridge(options = {}) {
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') {
    return { installed: false, reason: 'FETCH_UNAVAILABLE', version: VERSION };
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const mode = normalizedMode(options.mode);
  const approved = approvedSymbols(options.approvedSymbols);
  const quoteMaxAgeMinutes = boundedNumber('ETORO_UCITS_QUOTE_MAX_AGE_MINUTES', 10, 1, 120);
  const maxSpreadPct = boundedNumber('ETORO_UCITS_MAX_SPREAD_PCT', 2, 0.01, 20);
  const resolvedBySymbol = new Map();
  const reverseByExecutionId = new Map();
  const inflight = new Map();

  async function resolveExecutionSymbol(mapping, input, init) {
    const symbol = mapping.executionSymbol.toUpperCase();
    if (resolvedBySymbol.has(symbol)) return resolvedBySymbol.get(symbol);
    if (inflight.has(symbol)) return inflight.get(symbol);
    const promise = (async () => {
      const url = `${SEARCH_ENDPOINT}?internalSymbolFull=${encodeURIComponent(symbol)}`;
      const response = await fetchImpl(url, { method: 'GET', headers: authHeaders(input, init) });
      let data = null;
      try { data = await response.clone().json(); } catch {}
      if (!response.ok) {
        throw bridgeError('UCITS_SYMBOL_SEARCH_HTTP_ERROR', `Recherche eToro impossible pour ${symbol}.`, {
          analysisAsset: mapping.analysisAsset, executionSymbol: symbol, httpStatus: response.status
        });
      }
      const exact = exactInstrumentMatch(data, symbol);
      if (!exact) {
        throw bridgeError('UCITS_SYMBOL_EXACT_MATCH_REQUIRED', `Aucun instrumentId eToro exact et unique pour ${symbol}.`, {
          analysisAsset: mapping.analysisAsset, executionSymbol: symbol
        });
      }
      const resolved = Object.freeze({ ...mapping, executionInstrumentId: exact.instrumentId });
      resolvedBySymbol.set(symbol, resolved);
      reverseByExecutionId.set(exact.instrumentId, resolved);
      log('SYMBOL_RESOLVED', {
        analysisAsset: mapping.analysisAsset,
        analysisInstrumentId: mapping.analysisInstrumentId,
        executionSymbol: symbol,
        executionInstrumentId: exact.instrumentId
      });
      return resolved;
    })();
    inflight.set(symbol, promise);
    try { return await promise; } finally { inflight.delete(symbol); }
  }

  async function resolveAllBestEffort(input, init) {
    const mappings = [...BY_ANALYSIS_ID.values()];
    const results = await Promise.allSettled(mappings.map((mapping) => resolveExecutionSymbol(mapping, input, init)));
    const failures = results.filter((item) => item.status === 'rejected').length;
    if (failures > 0) log('PNL_ALIAS_RESOLUTION_PARTIAL', { resolved: mappings.length - failures, failures }, 'warn');
  }

  async function verifyTargetQuote(resolved, input, init) {
    const url = `${RATES_ENDPOINT}?instrumentIds=${encodeURIComponent(String(resolved.executionInstrumentId))}`;
    const response = await fetchImpl(url, { method: 'GET', headers: authHeaders(input, init) });
    let data = null;
    try { data = await response.clone().json(); } catch {}
    if (!response.ok) {
      throw bridgeError('UCITS_QUOTE_HTTP_ERROR', `Prix eToro indisponible pour ${resolved.executionSymbol}.`, {
        analysisAsset: resolved.analysisAsset,
        executionSymbol: resolved.executionSymbol,
        httpStatus: response.status
      });
    }
    const quote = exactRateMatch(data, resolved.executionInstrumentId);
    if (!quote) {
      throw bridgeError('UCITS_QUOTE_NOT_FOUND', `Aucun prix eToro exploitable pour ${resolved.executionSymbol}.`, {
        analysisAsset: resolved.analysisAsset,
        executionSymbol: resolved.executionSymbol
      });
    }
    if (!quote.timestamp) {
      throw bridgeError('UCITS_QUOTE_TIMESTAMP_REQUIRED', `Horodatage de prix manquant pour ${resolved.executionSymbol}.`, {
        analysisAsset: resolved.analysisAsset,
        executionSymbol: resolved.executionSymbol
      });
    }
    const ageMinutes = Math.max(0, (now().getTime() - quote.timestamp.getTime()) / 60000);
    if (ageMinutes > quoteMaxAgeMinutes) {
      throw bridgeError('UCITS_QUOTE_STALE', `Prix eToro trop ancien pour ${resolved.executionSymbol}.`, {
        analysisAsset: resolved.analysisAsset,
        executionSymbol: resolved.executionSymbol,
        ageMinutes: Math.round(ageMinutes * 100) / 100,
        maxAgeMinutes: quoteMaxAgeMinutes
      });
    }
    let spreadPct = null;
    if (Number.isFinite(quote.bid) && quote.bid > 0 && Number.isFinite(quote.ask) && quote.ask > 0) {
      const mid = (quote.bid + quote.ask) / 2;
      spreadPct = mid > 0 ? ((quote.ask - quote.bid) / mid) * 100 : null;
      if (Number.isFinite(spreadPct) && spreadPct > maxSpreadPct) {
        throw bridgeError('UCITS_SPREAD_TOO_WIDE', `Spread eToro trop large pour ${resolved.executionSymbol}.`, {
          analysisAsset: resolved.analysisAsset,
          executionSymbol: resolved.executionSymbol,
          spreadPct: Math.round(spreadPct * 10000) / 10000,
          maxSpreadPct
        });
      }
    }
    return { ageMinutes, spreadPct };
  }

  async function wrappedFetch(input, init = {}) {
    const url = safeUrl(input);
    if (!url || url.origin !== 'https://public-api.etoro.com') return fetchImpl(input, init);
    const method = requestMethod(input, init);

    if (method === 'GET' && url.pathname === REAL_PNL_PATH && mode !== 'off') {
      const response = await fetchImpl(input, init);
      if (!response.ok) return response;
      let data = null;
      try { data = await response.clone().json(); } catch { return response; }
      await resolveAllBestEffort(input, init);
      const translated = translateInstrumentIds(data, reverseByExecutionId);
      if (translated > 0) {
        log('PNL_EXECUTION_IDS_ALIASED', { translatedObjects: translated });
        return responseWithJson(response, data);
      }
      return response;
    }

    if (method === 'POST' && url.pathname === REAL_ORDER_PATH) {
      const body = parseJsonBody(init);
      if (!body || String(body.action || '').toLowerCase() !== 'open' || String(body.transaction || '').toLowerCase() !== 'buy') {
        return fetchImpl(input, init);
      }
      const analysisInstrumentId = Number(body.instrumentId ?? body.InstrumentId ?? body.instrumentID ?? body.InstrumentID);
      const mapping = BY_ANALYSIS_ID.get(analysisInstrumentId);
      if (!mapping) return fetchImpl(input, init);

      if (mode === 'off') return fetchImpl(input, init);
      if (mode !== 'live') {
        throw bridgeError('UCITS_EXECUTION_GUARD_ACTIVE', `Ordre ${mapping.analysisAsset} bloqué: bridge UCITS en mode guard.`, {
          analysisAsset: mapping.analysisAsset,
          analysisInstrumentId,
          executionSymbol: mapping.executionSymbol,
          mode
        });
      }
      if (!approved.has(mapping.executionSymbol.toUpperCase())) {
        throw bridgeError('UCITS_SYMBOL_NOT_APPROVED', `Ordre ${mapping.analysisAsset} bloqué: ${mapping.executionSymbol} non approuvé.`, {
          analysisAsset: mapping.analysisAsset,
          executionSymbol: mapping.executionSymbol
        });
      }
      const nowDate = now();
      if (!isVenueOpen(mapping.executionSymbol, nowDate)) {
        throw bridgeError('UCITS_EXECUTION_VENUE_CLOSED', `Marché d'exécution fermé pour ${mapping.executionSymbol}.`, {
          analysisAsset: mapping.analysisAsset,
          executionSymbol: mapping.executionSymbol,
          at: nowDate.toISOString()
        });
      }
      const resolved = await resolveExecutionSymbol(mapping, input, init);
      const quote = await verifyTargetQuote(resolved, input, init);
      const rewritten = { ...body, instrumentId: resolved.executionInstrumentId };
      for (const key of ['InstrumentId', 'instrumentID', 'InstrumentID']) delete rewritten[key];
      const nextHeaders = requestHeaders(input, init);
      nextHeaders.set('content-type', 'application/json');
      log('BUY_REWRITTEN_TO_UCITS', {
        analysisAsset: mapping.analysisAsset,
        analysisInstrumentId,
        executionSymbol: resolved.executionSymbol,
        executionInstrumentId: resolved.executionInstrumentId,
        amount: Number(body.amount),
        quoteAgeMinutes: Math.round(quote.ageMinutes * 100) / 100,
        spreadPct: Number.isFinite(quote.spreadPct) ? Math.round(quote.spreadPct * 10000) / 10000 : null,
        originatesOrders: false
      });
      return fetchImpl(url.toString(), { ...init, headers: nextHeaders, body: JSON.stringify(rewritten) });
    }

    return fetchImpl(input, init);
  }

  if (!options.fetch) global.fetch = wrappedFetch;
  const state = {
    version: VERSION,
    installed: true,
    mode,
    approvedSymbols: [...approved],
    mappings: Object.fromEntries(Object.entries(EXECUTION_MAP).map(([asset, value]) => [asset, { ...value }])),
    safety: {
      defaultMode: 'guard',
      exactSymbolMatchRequired: true,
      explicitApprovalRequiredForLive: true,
      venueOpenRequired: true,
      freshQuoteRequired: true,
      originatesOrders: false
    }
  };
  global.__LEO_ETORO_UCITS_EXECUTION_BRIDGE__ = state;
  log('BRIDGE_READY', {
    mode,
    approvedSymbols: [...approved],
    mappedAssets: Object.keys(EXECUTION_MAP),
    originatesOrders: false
  });
  return { ...state, fetch: wrappedFetch, resolveExecutionSymbol, reverseByExecutionId };
}

const autoInstalled = installBridge();

module.exports = {
  VERSION,
  EXECUTION_MAP,
  exactInstrumentMatch,
  exactRateMatch,
  isVenueOpen,
  translateInstrumentIds,
  normalizedMode,
  approvedSymbols,
  installBridge,
  autoInstalled
};
