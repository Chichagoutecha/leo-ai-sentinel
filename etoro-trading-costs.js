'use strict';

const { randomUUID } = require('node:crypto');
const ENDPOINT = 'https://public-api.etoro.com/api/v2/trading/info/costs';
const SOURCE = 'https://api-portal.etoro.com/api-reference/trading--real/get-what-if-trading-cost-breakdown';
const TYPES = new Set(['markup', 'marketSpread', 'transactionFee', 'overnightFee', 'overWeekendFee', 'sdrt']);

function request(input) {
  if (!input || Object.keys(input).some(k => !['instrumentId', 'amountUsd'].includes(k)) ||
      !Number.isSafeInteger(input.instrumentId) || input.instrumentId <= 0 || input.instrumentId > 2147483647 ||
      !Number.isFinite(input.amountUsd) || input.amountUsd <= 0) throw Error('INVALID_COST_QUERY');
  return { action: 'open', transaction: 'buy', instrumentId: input.instrumentId, settlementType: 'real', orderType: 'mkt', leverage: 1, amount: input.amountUsd, orderCurrency: 'usd' };
}

function normalize(data, input, now) {
  const asOf = Date.parse(data?.lastUpdated);
  const fail = reason => ({ status: 'UNAVAILABLE', reason, coverage: 'UNKNOWN', totalUsd: null, components: [] });
  if (data?.instrumentId !== input.instrumentId || !Number.isFinite(asOf) || now < asOf || now - asOf > 300000 || !Array.isArray(data.costs) || !data.costs.length || data.costs.length > 32) return fail('COST_IDENTITY_TIMESTAMP_OR_COMPONENTS_UNVERIFIED');
  const components = [], seen = new Set();
  for (const row of data.costs) {
    if (!TYPES.has(row?.costType) || seen.has(row.costType) || row.currency !== 'USD' || !Number.isFinite(row.value) || row.value < 0) return fail('UNKNOWN_CONTRADICTORY_OR_FOREIGN_COST');
    if (['overnightFee', 'overWeekendFee'].includes(row.costType) && row.value !== 0) return fail('HOLDING_COST_HORIZON_UNVERIFIED');
    seen.add(row.costType);
    components.push({ type: row.costType, valueUsd: row.value });
  }
  const totalUsd = components.reduce((sum, row) => sum + row.valueUsd, 0);
  if (!Number.isFinite(totalUsd)) return fail('COST_OVERFLOW');
  return { status: 'AVAILABLE', coverage: 'COMPLETE_ESTIMATE', source: ENDPOINT, documentation: SOURCE,
    instrumentId: input.instrumentId, side: 'BUY', amountUsd: input.amountUsd, currency: 'USD', asOf: data.lastUpdated,
    totalUsd, allInCostPct: totalUsd / input.amountUsd * 100, components, unresolvedComponents: [], observedFeesUsd: null };
}

function createCostClient({ env = process.env, fetchImpl = global.fetch, clock = Date.now } = {}) {
  let credentials = [], generation = 0, blockedUntil = 0;
  const requests = [], cache = new Map();
  function sync() {
    const next = [env.ETORO_API_KEY, env.ETORO_USER_KEY, env.ETORO_ACCOUNT_ENV, env.ETORO_CREDENTIAL_REVISION, env.ETORO_PORTFOLIO_CONTEXT];
    if (next.some((v, i) => v !== credentials[i]) || !generation) { credentials = next; generation++; cache.clear(); }
    return generation;
  }
  return { async check(input) {
    const body = request(input), current = sync(), key = JSON.stringify(body), now = clock();
    if (!credentials[0] || !credentials[1]) return { status: 'NOT_TESTED', reason: 'CREDENTIALS_ABSENT' };
    if (env.ETORO_ACCOUNT_ENV !== 'REAL') return { status: 'UNAVAILABLE', reason: 'REAL_COST_ENDPOINT_ONLY' };
    const cached = cache.get(key);
    if (cached && now >= cached.at && now - cached.at < 60000 && (cached.value.status !== 'AVAILABLE' || Number.isFinite(Date.parse(cached.value.asOf)) && now >= Date.parse(cached.value.asOf) && now - Date.parse(cached.value.asOf) <= 300000)) return structuredClone(cached.value);
    while (requests.length && now - requests[0] >= 60000) requests.shift();
    if (now < blockedUntil || requests.length >= 20) return { status: 'UNAVAILABLE', reason: 'COST_QUOTA_OR_COOLDOWN' };
    requests.push(now);
    const keys = credentials.slice(0, 2);
    try {
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', 'x-api-key': keys[0], 'x-user-key': keys[1], 'x-request-id': randomUUID() }, body: JSON.stringify(body) });
      if (!response.ok) {
        if ([401, 403, 429].includes(response.status)) blockedUntil = clock() + 60000;
        await response.body?.cancel();
        const value = { status: ({ 401: 'UNAUTHORIZED', 403: 'FORBIDDEN' })[response.status] || 'UNAVAILABLE', httpStatus: response.status, reason: 'COST_READ_REFUSED' };
        if (sync() === current) cache.set(key, { at: now, value });
        return value;
      }
      const reader = response.body?.getReader();
      if (!reader) return { status: 'UNAVAILABLE', reason: 'EMPTY_COST_RESPONSE' };
      const chunks = []; let bytes = 0;
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 131072) { await reader.cancel(); return { status: 'UNAVAILABLE', reason: 'COST_RESPONSE_TOO_LARGE' }; }
        chunks.push(Buffer.from(part.value));
      }
      const value = normalize(JSON.parse(Buffer.concat(chunks).toString('utf8')), input, clock());
      if (sync() !== current) return { status: 'UNAVAILABLE', reason: 'COST_CONTEXT_CHANGED' };
      if (cache.size >= 50) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now, value });
      return structuredClone(value);
    } catch { return { status: 'UNAVAILABLE', reason: 'COST_READ_FAILED' }; }
  } };
}

module.exports = { ENDPOINT, SOURCE, request, normalize, createCostClient };
