'use strict';
const { randomUUID } = require('node:crypto');
const ENDPOINT = 'https://public-api.etoro.com/api/v2/trading/info/eligibility';
const SOURCE = 'https://api-portal.etoro.com/api-reference/trading--real/check-instrument-trading-eligibility';
const validId = v => Number.isInteger(v) && v > 0 && v <= 2147483647;
const validSymbol = v => typeof v === 'string' && /^[A-Z0-9][A-Z0-9.:-]{0,31}$/.test(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['instrumentIds', 'symbols', 'currency'].includes(k))) throw Error('INVALID_ELIGIBILITY_REQUEST');
  const ids = input.instrumentIds ?? [], symbols = input.symbols ?? [];
  if (!Array.isArray(ids) || !Array.isArray(symbols) || !ids.every(validId) || !symbols.every(validSymbol) || ids.length + symbols.length < 1 || ids.length + symbols.length > 100 || (input.currency !== undefined && input.currency !== 'USD')) throw Error('INVALID_ELIGIBILITY_REQUEST');
  return { instrumentIds: [...new Set(ids)].sort((a, b) => a - b), symbols: [...new Set(symbols)].sort(), currency: 'USD' };
}
const BOOL = ['allowOpenPosition', 'allowClosePosition', 'allowPartialClosePosition', 'allowMitOrders', 'allowEntryOrders', 'allowExitOrders', 'allowTrailingStopLoss', 'requiresW8Ben'];
const NUM = ['minPositionExposure', 'maxUnitsPerOrder', 'initialMarginInAssetCurrency', 'stopLossMarginInAssetCurrency', 'additionalBufferPercent'];
const STR = ['unitsQuantityType', 'orderFillBehaviorType', 'allowedOrderQuantityType', 'tradeUnitType'];
const CONFIG_BOOL = ['isPotential', 'allowEditStopLoss', 'allowEditTakeProfit', 'allowStopLossTakeProfit'];
const CONFIG_NUM = ['minPositionAmount', 'minStopLossPercentage', 'maxStopLossPercentage', 'defaultStopLossPercentage', 'minTakeProfitPercentage', 'maxTakeProfitPercentage', 'defaultTakeProfitPercentage'];
function sanitizeConfiguration(row, isSecret = () => false) {
  const configuration = {}, issues = [];
  const pick = (source, target, names, predicate) => {
    for (const key of names) if (own(source, key)) {
      if (source[key] === null || predicate(source[key])) target[key] = source[key];
      else issues.push('INVALID_' + key);
    }
  };
  const numeric = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const text = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v) && !isSecret(v);
  pick(row, configuration, BOOL, v => typeof v === 'boolean');
  pick(row, configuration, NUM, numeric);
  pick(row, configuration, STR, text);
  if (own(row, 'leverageConfigs')) {
    if (!Array.isArray(row.leverageConfigs)) issues.push('INVALID_LEVERAGE_CONFIGS');
    else {
      configuration.leverageConfigs = row.leverageConfigs.map(raw => {
        const item = {};
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { issues.push('INVALID_LEVERAGE_CONFIG'); return item; }
        pick(raw, item, ['settlementType', 'direction'], text);
        pick(raw, item, CONFIG_BOOL, v => typeof v === 'boolean');
        pick(raw, item, CONFIG_NUM, numeric);
        if (own(raw, 'leverageValues')) {
          if (Array.isArray(raw.leverageValues) && raw.leverageValues.every(v => numeric(v) && v > 0)) item.leverageValues = [...raw.leverageValues];
          else issues.push('INVALID_LEVERAGE_VALUES');
        }
        if (item.minStopLossPercentage > item.maxStopLossPercentage || item.minTakeProfitPercentage > item.maxTakeProfitPercentage) issues.push('CONTRADICTORY_LIMITS');
        return item;
      });
      const keys = configuration.leverageConfigs.map(c => `${c.settlementType}|${c.direction}`);
      if (new Set(keys).size !== keys.length) issues.push('DUPLICATE_LEVERAGE_CONFIGS');
    }
  }
  return { configuration, issues };
}
function normalizeResponse(data, request, isSecret) {
  if (!data || !Array.isArray(data.eligibilities) || !Array.isArray(data.notFoundInstrumentIds) || !Array.isArray(data.notFoundSymbols)) return { status: 'INCOMPLETE', reason: 'UNEXPECTED_SCHEMA', records: [] };
  if (data.currency !== request.currency) return { status: 'INCOMPLETE', reason: 'CURRENCY_MISMATCH', records: [] };
  if (!data.notFoundInstrumentIds.every(validId) || !data.notFoundSymbols.every(validSymbol)) return { status: 'INCOMPLETE', reason: 'INVALID_NOT_FOUND_LISTS', records: [] };
  const records = [], matched = new Set();
  for (const row of data.eligibilities) {
    if (!row || !validId(row.instrumentId) || !validSymbol(row.symbol) || isSecret(row.symbol)) return { status: 'INCOMPLETE', reason: 'INVALID_RESPONSE_IDENTITY', records: [] };
    if (!request.instrumentIds.includes(row.instrumentId) && !request.symbols.includes(row.symbol)) return { status: 'INCOMPLETE', reason: 'UNREQUESTED_RESPONSE_IDENTITY', records: [] };
    const key = String(row.instrumentId);
    if (matched.has(key) || records.some(r => r.symbol === row.symbol)) return { status: 'CONTRADICTORY', reason: 'DUPLICATE_RESPONSE_IDENTITY', records: [] };
    if (data.notFoundInstrumentIds.includes(row.instrumentId) || data.notFoundSymbols.includes(row.symbol)) return { status: 'CONTRADICTORY', reason: 'FOUND_AND_NOT_FOUND', records: [] };
    matched.add(key);
    records.push({ instrumentId: row.instrumentId, symbol: row.symbol, ...sanitizeConfiguration(row, isSecret) });
  }
  for (const instrumentId of data.notFoundInstrumentIds) {
    if (!request.instrumentIds.includes(instrumentId)) return { status: 'INCOMPLETE', reason: 'UNREQUESTED_NOT_FOUND_ID', records: [] };
  }
  for (const symbol of data.notFoundSymbols) {
    if (!request.symbols.includes(symbol)) return { status: 'INCOMPLETE', reason: 'UNREQUESTED_NOT_FOUND_SYMBOL', records: [] };
  }
  const missing = request.instrumentIds.some(id => !records.some(r => r.instrumentId === id) && !data.notFoundInstrumentIds.includes(id)) || request.symbols.some(symbol => !records.some(r => r.symbol === symbol) && !data.notFoundSymbols.includes(symbol));
  return { status: missing ? 'PARTIAL' : 'AVAILABLE', reason: missing ? 'REQUESTED_INSTRUMENTS_OMITTED' : null, records, notFoundInstrumentIds: [...data.notFoundInstrumentIds], notFoundSymbols: [...data.notFoundSymbols] };
}
function createEligibilityClient({ env = process.env, fetchImpl = global.fetch, clock = Date.now, timeoutMs = 8000 } = {}) {
  let session = null, generation = 0, blockedUntil = 0;
  const times = [];
  function sync() {
    // Secrets live only in this private transport closure; never persisted or hashed.
    const next = [env.ETORO_API_KEY, env.ETORO_USER_KEY, env.ETORO_ACCOUNT_ENV || 'REAL', env.ETORO_PORTFOLIO_CONTEXT || 'AUTO', env.ETORO_EXPECTED_AGENT_PORTFOLIO_ID, env.ETORO_EXPECTED_PORTFOLIO_ID, env.ETORO_EXPECTED_AGENT_PORTFOLIO_GCID, env.ETORO_EXPECTED_MIRROR_ID, env.ETORO_EXPECTED_USER_TOKEN_ID];
    if (!session || next.some((v, i) => v !== session[i])) { session = next; generation++; }
    return { generation, environment: ['REAL', 'DEMO'].includes(session[2]) ? session[2] : 'UNKNOWN', contextKind: ['ACCOUNT', 'AGENT'].includes(session[3]) ? session[3] : 'AUTO', identityVerification: 'UNVERIFIED' };
  }
  return {
    session: sync,
    async check(input) {
      const request = validateRequest(input), context = sync();
      const base = { context, source: ENDPOINT, documentation: SOURCE, currency: request.currency, fetchedAt: new Date(clock()).toISOString(), httpStatus: null };
      if (context.environment !== 'REAL') return { ...base, status: 'UNAVAILABLE', reason: 'REAL_ENDPOINT_ONLY', records: [] };
      if (!session[0] || !session[1]) return { ...base, status: 'NOT_TESTED', reason: 'CREDENTIALS_ABSENT', records: [] };
      if (clock() < blockedUntil) return { ...base, status: 'RATE_LIMITED', reason: 'PROVIDER_COOLDOWN', records: [] };
      while (times.length && clock() - times[0] >= 60000) times.shift();
      if (times.length >= 20) return { ...base, status: 'RATE_LIMITED', reason: 'LOCAL_QUOTA', records: [] };
      times.push(clock());
      const credentials = session.slice(0, 2);
      const isSecret = value => credentials.some(secret => typeof secret === 'string' && secret.length > 0 && String(value).includes(secret));
      const controller = new AbortController();
      const duration = Number.isFinite(timeoutMs) ? Math.max(10, Math.min(timeoutMs, 10000)) : 8000;
      const timer = setTimeout(() => controller.abort(), duration);
      try {
        const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-api-key': credentials[0], 'x-user-key': credentials[1], 'x-request-id': randomUUID() }, body: JSON.stringify(request) });
        base.httpStatus = response.status;
        if (!response.ok) {
          if (response.status === 429) {
            const retry = Number(response.headers.get('retry-after'));
            blockedUntil = clock() + Math.max(60000, Math.min(Number.isFinite(retry) ? retry * 1000 : 60000, 3600000));
          }
          await response.body?.cancel();
          return { ...base, status: ({ 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 429: 'RATE_LIMITED' })[response.status] || 'UNAVAILABLE', reason: 'HTTP_FAILURE', records: [] };
        }
        const reader = response.body?.getReader();
        if (!reader) return { ...base, status: 'INCOMPLETE', reason: 'EMPTY_BODY', records: [] };
        let size = 0; const chunks = [];
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); return { ...base, status: 'INCOMPLETE', reason: 'BODY_LIMIT', records: [] }; }
          chunks.push(Buffer.from(value));
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return { ...base, status: 'INCOMPLETE', reason: 'INVALID_JSON', records: [] }; }
        if (sync().generation !== context.generation) return { ...base, status: 'UNAVAILABLE', reason: 'CONTEXT_CHANGED_DURING_REQUEST', records: [] };
        return { ...base, ...normalizeResponse(data, request, isSecret) };
      } catch { return { ...base, status: 'UNAVAILABLE', reason: 'NETWORK_OR_TIMEOUT_FAILURE', records: [] }; }
      finally { clearTimeout(timer); }
    }
  };
}
function createEligibilityRegistry({ client = createEligibilityClient(), clock = Date.now, ttlMs = 1800000 } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 86400000) throw Error('INVALID_TTL');
  let generation = null, sequence = 0;
  const cache = new Map(), pending = new Map();
  const sync = () => { const context = client.session(); if (context.generation !== generation) { cache.clear(); pending.clear(); generation = context.generation; } return context; };
  async function refresh(input) {
    const request = validateRequest(input), context = sync(), key = JSON.stringify(request);
    const saved = cache.get(key);
    if (saved && clock() >= saved.savedAt && clock() - saved.savedAt < ttlMs) return structuredClone(saved.value);
    if (pending.has(key)) return structuredClone(await pending.get(key));
    const operation = (async () => {
      const value = await client.check(request);
      if (sync().generation !== context.generation) return { status: 'UNAVAILABLE', reason: 'CONTEXT_CHANGED_DURING_REQUEST', records: [] };
      // An error replaces old evidence; never serve stale success after a refusal.
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { savedAt: clock(), sequence: ++sequence, request, value });
      return value;
    })();
    pending.set(key, operation);
    try { return structuredClone(await operation); }
    finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  return {
    refresh,
    async refreshMany({ instrumentIds = [], symbols = [], currency = 'USD' } = {}) {
      if (!Array.isArray(instrumentIds) || !Array.isArray(symbols) || instrumentIds.length + symbols.length > 1000 || instrumentIds.length + symbols.length === 0) throw Error('INVALID_BATCH_REQUEST');
      // Validate every batch before sending the first request.
      const items = [...instrumentIds.map(id => ({ id })), ...symbols.map(symbol => ({ symbol }))], batches = [];
      for (let i = 0; i < items.length; i += 100) { const part = items.slice(i, i + 100); batches.push(validateRequest({ instrumentIds: part.filter(v => own(v, 'id')).map(v => v.id), symbols: part.filter(v => own(v, 'symbol')).map(v => v.symbol), currency })); }
      const results = [];
      for (const batch of batches) { const result = await refresh(batch); results.push(result); if (['RATE_LIMITED', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_TESTED'].includes(result.status)) break; }
      return results;
    },
    inspect({ symbol, instrumentId, category, allowedAssets = [], allowedCategories = [], operation = {}, quoteFresh = null, portfolioFresh = null } = {}) {
      const context = sync();
      const observations = [...cache.values()].filter(v =>
        (validId(instrumentId) && v.request.instrumentIds.includes(instrumentId)) || (validSymbol(symbol) && v.request.symbols.includes(symbol)) ||
        v.value.records.some(r => validId(instrumentId) ? r.instrumentId === instrumentId : r.symbol === symbol));
      observations.sort((a, b) => b.sequence - a.sequence);
      const observation = observations[0];
      const record = observation?.value.records.find(r => (validId(instrumentId) && r.instrumentId === instrumentId) || (validSymbol(symbol) && r.symbol === symbol));
      const latest = record ? { record, value: observation.value } : null;
      let technical = observation ? observation.value.status : 'UNAVAILABLE'; const reasons = [];
      let identification = 'UNVERIFIED';
      const age = observation ? clock() - observation.savedAt : null;
      if (age !== null && (age < 0 || age >= ttlMs)) technical = 'STALE';
      else if (latest) {
        const r = latest.record;
        identification = validId(instrumentId) && validSymbol(symbol) && (r.instrumentId !== instrumentId || r.symbol !== symbol) ? 'CONTRADICTORY' : 'IDENTIFIED';
        technical = evaluateConfiguration(r, latest.value, operation, clock(), ttlMs);
        if (identification !== 'IDENTIFIED') technical = 'CONTRADICTORY';
      } else if (observation && ['AVAILABLE', 'PARTIAL'].includes(observation.value.status)) {
        technical = observation.value.notFoundInstrumentIds?.includes(instrumentId) || observation.value.notFoundSymbols?.includes(symbol) ? 'NOT_FOUND' : 'INCOMPLETE';
        reasons.push('NO_CONFIGURATION_RETURNED');
      } else reasons.push(observation?.value.reason || 'NO_USABLE_CONFIGURATION');
      const authorized = allowedAssets.includes(symbol) && allowedCategories.includes(category) && ['ETF', 'STOCK', 'CRYPTO'].includes(category);
      return { discovered: Boolean(validSymbol(symbol) || validId(instrumentId)), identification, technicalEligibility: technical,
        leoAuthorization: authorized ? 'AUTHORIZED_BY_CALLER_POLICY' : 'NOT_AUTHORIZED',
        dataAvailability: { quote: quoteFresh === true ? 'FRESH' : quoteFresh === false ? 'STALE_OR_MISSING' : 'UNKNOWN', portfolio: portfolioFresh === true ? 'FRESH' : portfolioFresh === false ? 'STALE_OR_MISSING' : 'UNKNOWN' },
        context, fetchedAt: latest?.value.fetchedAt || null, currency: latest?.value.currency || null,
        configuration: latest ? structuredClone(latest.record.configuration) : null,
        configurationFreshness: technical === 'STALE' ? 'STALE' : latest ? 'AVAILABLE' : 'UNAVAILABLE',
        source: observation?.value.source || ENDPOINT, documentation: SOURCE,
        configurationIssues: latest ? [...latest.record.issues] : [],
        status: 'INFORMATION_ONLY_NOT_EXECUTION_AUTHORITY', reasons, executionAttempted: false };
    }
  };
}
function evaluateConfiguration(record, response, operation, now, ttlMs) {
  const age = now - Date.parse(response.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age >= ttlMs) return 'STALE';
  if (record.issues.length) return 'INCOMPLETE';
  const c = record.configuration;
  if (!operation.action) return 'CONFIGURATION_AVAILABLE_NOT_EVALUATED';
  if (operation.currency !== response.currency) return 'CURRENCY_UNKNOWN_OR_MISMATCH';
  if (operation.action === 'CLOSE' && typeof operation.partial !== 'boolean') return 'INCOMPLETE';
  if (operation.action === 'CLOSE') return typeof c.allowClosePosition !== 'boolean' ? 'INCOMPLETE' : !c.allowClosePosition ? 'BLOCKED' : operation.partial === true ? typeof c.allowPartialClosePosition !== 'boolean' ? 'INCOMPLETE' : c.allowPartialClosePosition ? 'ALLOWED_CONFIGURATION' : 'BLOCKED' : 'ALLOWED_CONFIGURATION';
  if (operation.action !== 'OPEN') return 'NOT_EVALUATED';
  if (c.allowOpenPosition === false) return 'BLOCKED';
  if (c.allowOpenPosition !== true || !Array.isArray(c.leverageConfigs)) return 'INCOMPLETE';
  if (typeof operation.settlementType !== 'string' || !['LONG', 'SHORT'].includes(operation.direction) || typeof operation.leverage !== 'number' || !Number.isFinite(operation.leverage) || operation.leverage <= 0) return 'INCOMPLETE';
  const configs = c.leverageConfigs.filter(v => v.settlementType === operation.settlementType && v.direction === operation.direction);
  if (configs.length !== 1) return configs.length ? 'INCOMPLETE' : 'REQUESTED_CONFIGURATION_NOT_REPORTED';
  const config = configs[0];
  if (config.isPotential !== false || !Array.isArray(config.leverageValues)) return 'INCOMPLETE';
  if (!config.leverageValues.includes(operation.leverage)) return 'BLOCKED';
  if (operation.orderType !== 'MARKET') return 'ORDER_TYPE_NOT_EVALUATED';
  if (!['Both', 'Amount'].includes(c.allowedOrderQuantityType)) return 'AMOUNT_ORDER_SUPPORT_UNKNOWN';
  if (typeof operation.amount !== 'number' || !Number.isFinite(operation.amount) || operation.amount <= 0 || typeof config.minPositionAmount !== 'number' || typeof c.minPositionExposure !== 'number') return 'INCOMPLETE';
  if (c.requiresW8Ben === true) return 'PREREQUISITE_UNVERIFIED';
  if (typeof c.maxUnitsPerOrder !== 'number' || typeof operation.units !== 'number' || !Number.isFinite(operation.units) || operation.units <= 0) return 'INCOMPLETE';
  if (operation.units > c.maxUnitsPerOrder) return 'ABOVE_MAX_UNITS';
  if (operation.amount < config.minPositionAmount || operation.amount * operation.leverage < c.minPositionExposure) return 'BELOW_MINIMUM';
  return 'ALLOWED_CONFIGURATION';
}
module.exports = { ENDPOINT, SOURCE, validateRequest, createEligibilityClient, createEligibilityRegistry, evaluateConfiguration };
