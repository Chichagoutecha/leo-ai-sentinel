'use strict';
const { randomUUID } = require('node:crypto');
const model = require('./trader-observer');
const ROOT = 'https://public-api.etoro.com/api/v1/user-info/people';
const DOCS = 'https://api-portal.etoro.com/api-reference/users-info/';
function createTraderReadClient({ env = process.env, fetchImpl = global.fetch, clock = Date.now, timeoutMs = 8000, quotaStore, onQuotaChange = () => {} } = {}) {
  let credentials = [], generation = 0; const localQuota = { timestamps: [], blockedUntil: 0 };
  function context() {
    const next = [env.ETORO_API_KEY, env.ETORO_USER_KEY, env.ETORO_ACCOUNT_ENV, env.ETORO_PORTFOLIO_CONTEXT, env.ETORO_EXPECTED_USER_TOKEN_ID];
    if (next.some((v, i) => v !== credentials[i]) || !generation) { credentials = next; generation++; }
    return { generation, credentialEnvironment: ['REAL', 'DEMO'].includes(env.ETORO_ACCOUNT_ENV) ? env.ETORO_ACCOUNT_ENV : 'UNKNOWN', contextKind: ['AGENT', 'ACCOUNT'].includes(env.ETORO_PORTFOLIO_CONTEXT) ? env.ETORO_PORTFOLIO_CONTEXT : 'AUTO', identityBinding: 'UNVERIFIED', dataScope: 'PUBLIC_REAL_TRADER' };
  }
  const safeUsername = s => model.validUsername(s) && !credentials.slice(0, 2).some(key => typeof key === 'string' && key.length && s.includes(key));
  return { context, safeUsername,
    async read(kind, selector) {
      const ctx = context(); let source;
      if (kind === 'profile' && model.validId(selector?.realCID)) source = `${ROOT}?cidList=${selector.realCID}`;
      else if (['portfolio', 'performance', 'tradeStats'].includes(kind) && safeUsername(selector?.username)) source = `${ROOT}/${encodeURIComponent(selector.username)}/${({ portfolio: 'portfolio/live', performance: 'gain', tradeStats: 'tradeinfo?period=LastTwoYears' })[kind]}`;
      else return { status: 'UNAVAILABLE', reason: 'READ_NOT_ALLOWLISTED', source: null, data: null };
      const base = { source, collectedAt: new Date(clock()).toISOString(), context: ctx, httpStatus: null, effectiveAt: null, delaySeconds: null, missingFields: ['sourceUpdateTimestamp'], pagination: { mode: 'NOT_DOCUMENTED', pagesFetched: 0, complete: null } };
      if (!credentials[0] || !credentials[1]) return { ...base, status: 'UNAVAILABLE', reason: 'CREDENTIALS_ABSENT', data: null };
      const quota = quotaStore ? quotaStore() : localQuota;
      quota.timestamps = (Array.isArray(quota.timestamps) ? quota.timestamps : []).filter(t => Number.isFinite(t) && clock() - t < 60000).slice(-20);
      if (clock() < Number(quota.blockedUntil || 0) || quota.timestamps.length >= 20) return { ...base, status: 'UNAVAILABLE', reason: 'READ_QUOTA_OR_COOLDOWN', data: null };
      quota.timestamps.push(clock()); onQuotaChange();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? Math.max(10, Math.min(timeoutMs, 10000)) : 8000);
      try {
        const r = await fetchImpl(source, { method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { 'x-api-key': credentials[0], 'x-user-key': credentials[1], 'x-request-id': randomUUID() } });
        base.httpStatus = r.status;
        if (!r.ok) {
          if (r.status === 429) { const retry = Number(r.headers.get('retry-after')); const currentQuota = quotaStore ? quotaStore() : quota; currentQuota.blockedUntil = clock() + Math.max(60000, Number.isFinite(retry) ? Math.min(retry * 1000, 86400000) : 60000); onQuotaChange(); }
          await r.body?.cancel();
          return { ...base, status: 'UNAVAILABLE', reason: ({ 401: 'UNAUTHORIZED', 403: 'FORBIDDEN_PRIVACY_UNPROVEN', 404: 'NOT_FOUND', 429: 'PROVIDER_QUOTA' })[r.status] || 'HTTP_FAILURE', data: null };
        }
        const reader = r.body?.getReader(); if (!reader) return { ...base, status: 'UNAVAILABLE', reason: 'EMPTY_RESPONSE', data: null };
        const chunks = []; let size = 0;
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2097152) { await reader.cancel(); return { ...base, status: 'PARTIAL', reason: 'RESPONSE_SIZE_LIMIT', data: null }; } chunks.push(Buffer.from(part.value)); }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return { ...base, status: 'UNAVAILABLE', reason: 'INVALID_JSON', data: null }; }
        if (context().generation !== ctx.generation) return { ...base, status: 'UNAVAILABLE', reason: 'CREDENTIAL_CONTEXT_CHANGED', data: null };
        return { ...base, status: 'AVAILABLE', reason: null, pagination: { ...base.pagination, pagesFetched: 1 }, data };
      } catch { return { ...base, status: 'UNAVAILABLE', reason: 'NETWORK_OR_TIMEOUT_FAILURE', data: null }; }
      finally { clearTimeout(timer); }
    }
  };
}
function createTraderObserver({ env = process.env, client, clock = Date.now, getState, onChange = () => {}, minIntervalMs = 900000, staleMs = 1800000 } = {}) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 1000 || !Number.isFinite(staleMs) || staleMs < minIntervalMs) throw Error('INVALID_OBSERVER_INTERVAL');
  let local = model.emptyState(), active = false;
  const state = () => {
    const s = getState ? getState() : local;
    if (!s || s.version !== 1 || !s.traders || !Array.isArray(s.events) || !Array.isArray(s.observations)) throw Error('INVALID_OBSERVER_STATE');
    return s;
  };
  const configured = () => model.parseTraders(env.TRADER_OBSERVER_TRADERS_JSON || '[]');
  const persist = () => {
    const s = state(), compact = model.compactObserverState(s);
    Object.assign(s, compact); onChange();
  };
  if (!client) client = createTraderReadClient({ env, clock, quotaStore: () => { const s = state(); if (!s.readQuota) s.readQuota = { timestamps: [], blockedUntil: 0 }; return s.readQuota; }, onQuotaChange: persist });
  function view() {
    let list; try { list = configured(); } catch { return { status: 'UNAVAILABLE', reason: 'INVALID_TRADER_LIST', traders: [], executionAttempted: false }; }
    const s = state();
    return { readOnly: true, executionAttempted: false, statuses: model.STATUSES, configuredCount: list.length, historyTruncated: s.historyTruncated,
      capabilities: { explicitTransactions: 'UNAVAILABLE_AGGREGATE_STATS_ONLY', units: 'UNAVAILABLE_IN_DOCUMENTED_PUBLIC_SCHEMA', privateDetection: 'UNAVAILABLE_NO_DOCUMENTED_PRIVACY_MARKER' },
      traders: list.map(trader => {
        const row = s.traders[trader.realCID], snapshot = row?.snapshot;
        const age = snapshot ? clock() - Date.parse(snapshot.collectedAt) : null;
        const failed = row?.lastAttempt?.status === 'UNAVAILABLE';
        return { realCID: trader.realCID, status: failed ? 'UNAVAILABLE' : snapshot ? !Number.isFinite(age) || age < 0 || age > staleMs ? 'STALE' : snapshot.status : 'UNAVAILABLE',
          reason: failed ? row.lastAttempt.reason : row?.baselineTruncated ? 'PERSISTENCE_BUDGET_TRUNCATED' : snapshot?.reason || 'NOT_COLLECTED',
          lastAttempt: row?.lastAttempt || null, snapshot: snapshot ? structuredClone(snapshot) : null,
          historicalSnapshot: Boolean(failed || row?.baselineTruncated || (age !== null && age > staleMs)) };
      }),
      events: structuredClone(s.events.filter(e => list.some(t => t.realCID === e.traderId))) };
  }
  async function refresh(realCID) {
    const list = configured(), trader = list.find(t => t.realCID === realCID);
    if (!trader) throw Error('TRADER_NOT_CONFIGURED');
    const s = state();
    for (const key of Object.keys(s.traders)) if (!list.some(t => String(t.realCID) === key)) { delete s.traders[key]; s.historyTruncated = true; }
    const existing = s.traders[realCID];
    if (active) return { status: 'UNAVAILABLE', reason: 'COLLECTION_IN_PROGRESS', executionAttempted: false };
    const previousAttempt = Date.parse(existing?.lastAttempt?.at || '');
    if (Number.isFinite(previousAttempt) && clock() - previousAttempt < minIntervalMs) return { status: 'UNAVAILABLE', reason: 'TRADER_READ_COOLDOWN', executionAttempted: false };
    active = true;
    const startedAt = new Date(clock()).toISOString(), context = client.context(), attemptedReads = [];
    const noteRead = r => { attemptedReads.push({ source: r.source, collectedAt: r.collectedAt, httpStatus: r.httpStatus, status: r.status, reason: r.reason, context: r.context, effectiveAt: null, delaySeconds: null, pagination: r.pagination }); return r; };
    s.traders[realCID] = { ...existing, lastAttempt: { at: startedAt, status: 'UNAVAILABLE', reason: 'COLLECTION_NOT_FINISHED' } };
    const fail = reason => { s.traders[realCID].lastAttempt = { at: startedAt, completedAt: new Date(clock()).toISOString(), status: 'UNAVAILABLE', reason, context, reads: attemptedReads }; persist(); return { status: 'UNAVAILABLE', reason, executionAttempted: false }; };
    try {
      persist();
      const profile = noteRead(await client.read('profile', { realCID }));
      if (!profile.data) return fail(profile.reason || 'PROFILE_UNAVAILABLE');
      const identity = model.resolveIdentity(profile.data, trader, existing?.identityPin || existing?.snapshot?.identity);
      if (identity.status !== 'AVAILABLE' || !client.safeUsername(identity.username)) return fail(identity.reason || 'IDENTITY_UNSAFE');
      const results = {};
      for (const kind of ['portfolio', 'performance', 'tradeStats']) {
        results[kind] = noteRead(await client.read(kind, identity));
        if (results[kind].httpStatus === 401 || results[kind].httpStatus === 429 || ['READ_QUOTA_OR_COOLDOWN', 'CREDENTIAL_CONTEXT_CHANGED'].includes(results[kind].reason)) return fail(results[kind].reason);
      }
      // Re-resolve the stable account after username-addressed reads to avoid rename races.
      const finalProfile = noteRead(await client.read('profile', { realCID }));
      const finalIdentity = finalProfile.data ? model.resolveIdentity(finalProfile.data, trader, identity) : null;
      if (finalIdentity?.status !== 'AVAILABLE' || finalIdentity.username !== identity.username || client.context().generation !== context.generation) return fail('IDENTITY_OR_CONTEXT_CHANGED_DURING_COLLECTION');
      const unavailable = result => ({ status: 'UNAVAILABLE', reason: result.reason, positions: [], complete: false, effectiveAt: null, missingFields: ['response'], pagination: result.pagination });
      const snapshot = { realCID, identity, collectedAt: new Date(clock()).toISOString(), collectionStartedAt: startedAt,
        effectiveAt: null, delaySeconds: null, context,
        portfolio: results.portfolio.data ? model.normalizePortfolio(results.portfolio.data) : unavailable(results.portfolio),
        performance: results.performance.data ? model.normalizePerformance(results.performance.data) : unavailable(results.performance),
        tradeStats: results.tradeStats.data ? model.normalizeTradeStats(results.tradeStats.data, identity.username) : unavailable(results.tradeStats),
        sources: { identity: profile.source, portfolio: results.portfolio.source, performance: results.performance.source, tradeStats: results.tradeStats.source },
        reads: Object.fromEntries(Object.entries({ identity: profile, ...results, identityConfirmation: finalProfile }).map(([key, r]) => [key, { source: r.source, collectedAt: r.collectedAt, httpStatus: r.httpStatus, status: r.status, reason: r.reason, context: r.context, effectiveAt: null, delaySeconds: null, missingFields: ['sourceUpdateTimestamp'], pagination: r.pagination }])) };
      snapshot.status = 'PARTIAL';
      snapshot.reason = 'SOURCE_TIMESTAMPS_COMPLETENESS_OR_TRANSACTION_HISTORY_UNAVAILABLE';
      model.ingest(s, snapshot);
      s.traders[realCID].lastAttempt = { at: startedAt, status: snapshot.status, reason: snapshot.reason };
      persist();
      return { status: snapshot.status, reason: snapshot.reason, executionAttempted: false, realCID };
    } catch { return fail('COLLECTION_FAILED'); }
    finally { active = false; }
  }
  return { view, refresh };
}
module.exports = { ROOT, DOCS, createTraderReadClient, createTraderObserver };
