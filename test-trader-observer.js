'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./trader-observer');
const { ROOT, createTraderReadClient, createTraderObserver } = require('./etoro-trader-observer');
const start = Date.parse('2026-10-30T12:00:00Z');
const position = { positionId: 7, instrumentId: 1001, isBuy: true, openTimestamp: '2026-10-01T12:00:00Z', openRate: 100, investmentPct: 20, leverage: 1 };
const portfolio = () => ({ positions: [structuredClone(position)], socialTrades: [] });
function setup({ handler, timeoutMs } = {}) {
  let now = start, username = 'TraderOne', saves = 0; const calls = [], state = m.emptyState();
  const env = { ETORO_API_KEY: 'SECRET_API', ETORO_USER_KEY: 'SECRET_USER', TRADER_OBSERVER_TRADERS_JSON: '[{"realCID":1}]' };
  const fetchImpl = async (url, init) => {
    const u = new URL(url); calls.push({ url, method: init.method, redirect: init.redirect });
    if (handler) { const value = await handler(u, init); if (value !== undefined) return value; }
    const body = u.pathname.endsWith('/people') ? { users: [{ realCID: Number(u.searchParams.get('cidList')), gcid: 101, username }] }
      : u.pathname.endsWith('/portfolio/live') ? portfolio()
      : u.pathname.endsWith('/gain') ? { monthly: [{ timestamp: '2026-09-30T00:00:00Z', gain: 1 }], yearly: [] }
      : { userName: username, gain: 4, riskScore: 3, trades: 10 };
    return new Response(JSON.stringify(body));
  };
  const client = createTraderReadClient({ env, fetchImpl, clock: () => now, timeoutMs });
  const observer = createTraderObserver({ env, client, clock: () => now, getState: () => state, onChange: () => { saves++; }, minIntervalMs: 1000, staleMs: 2000 });
  return { env, calls, state, client, observer, advance: ms => { now += ms; }, rename: value => { username = value; }, saves: () => saves };
}
function snapshot(at, positions = [position]) {
  return { realCID: 1, identity: { realCID: 1, gcid: 101, username: 'TraderOne' }, collectedAt: new Date(at).toISOString(), portfolio: m.normalizePortfolio({ positions, socialTrades: [] }), performance: null, tradeStats: null, sources: { portfolio: ROOT + '/TraderOne/portfolio/live' } };
}
test('configuration requires stable numeric account IDs, rejects fuzzy names, duplicates and overflow', () => {
  for (const invalid of [[{ username: 'TraderOne' }], [{ realCID: 1 }, { realCID: 1 }], Array.from({ length: 6 }, (_, i) => ({ realCID: i + 1 })), [{ realCID: '1' }]]) assert.throws(() => m.parseTraders(invalid));
  assert.deepEqual(m.parseTraders([{ realCID: 2 }, { realCID: 1 }]).map(t => t.realCID), [1, 2]);
});
test('identity resolution rejects multiple rows, changed GCID and near usernames', () => {
  const trader = { realCID: 1 };
  assert.equal(m.resolveIdentity({ users: [{ realCID: 1 }, { realCID: 1 }] }, trader).reason, 'AMBIGUOUS_IDENTITY');
  assert.equal(m.resolveIdentity({ users: [{ realCID: 2, gcid: 101, username: 'Trader0ne' }] }, trader).reason, 'IDENTITY_NOT_RESOLVED');
  assert.equal(m.resolveIdentity({ users: [{ realCID: 1, gcid: 102, username: 'TraderOne' }] }, trader, { gcid: 101 }).reason, 'IDENTITY_CONFLICT');
});
test('client exposes only constructed official GETs and no arbitrary path or method', async () => {
  const s = setup();
  for (const kind of ['POST', '/api/v2/trading/copy', 'https://evil.example', 'orders']) assert.equal((await s.client.read(kind, { realCID: 1 })).reason, 'READ_NOT_ALLOWLISTED');
  assert.equal((await s.client.read('portfolio', { username: '../evil' })).reason, 'READ_NOT_ALLOWLISTED');
  assert.equal(s.calls.length, 0);
  await s.client.read('profile', { realCID: 1 });
  assert.equal(s.calls[0].url, ROOT + '?cidList=1');
  assert.equal(s.calls[0].method, 'GET'); assert.equal(s.calls[0].redirect, 'error');
});
test('missing credentials cause zero network calls and preserve explicit failure state', async () => {
  const s = setup(); delete s.env.ETORO_USER_KEY;
  assert.equal((await s.observer.refresh(1)).reason, 'CREDENTIALS_ABSENT');
  assert.equal(s.calls.length, 0); assert.equal(s.observer.view().traders[0].status, 'UNAVAILABLE');
});
test('renaming the same account updates one trader; status views never collect', async () => {
  const s = setup(); assert.equal((await s.observer.refresh(1)).status, 'PARTIAL');
  assert.equal(s.calls.length, 5); s.observer.view(); s.observer.view(); assert.equal(s.calls.length, 5);
  s.advance(1001); s.rename('NewName'); await s.observer.refresh(1);
  assert.deepEqual(Object.keys(s.state.traders), ['1']);
  assert.equal(s.observer.view().traders[0].snapshot.identity.username, 'NewName');
  assert.equal(s.state.events.length, 0);
});
test('identity rename race or context rotation discards the collection', async () => {
  let profiles = 0;
  const s = setup({ handler: u => u.pathname.endsWith('/people') ? new Response(JSON.stringify({ users: [{ realCID: 1, gcid: 101, username: ++profiles === 1 ? 'Old' : 'New' }] })) : undefined });
  assert.equal((await s.observer.refresh(1)).reason, 'IDENTITY_OR_CONTEXT_CHANGED_DURING_COLLECTION');
  assert.equal(s.state.observations.length, 0);
});
test('cooldown and single in-flight collection bound manual refreshes', async () => {
  const s = setup(); const first = s.observer.refresh(1), second = await s.observer.refresh(1);
  assert.equal(second.reason, 'COLLECTION_IN_PROGRESS'); await first;
  assert.equal((await s.observer.refresh(1)).reason, 'TRADER_READ_COOLDOWN');
  assert.equal(s.calls.length, 5);
});
test('private or forbidden responses are unavailable, not falsely proven PRIVATE', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/portfolio/live') ? new Response('{"private":true,"secret":"SECRET_USER"}', { status: 403 }) : undefined });
  await s.observer.refresh(1); const view = s.observer.view();
  assert.ok(view.statuses.includes('PRIVATE'));
  assert.equal(view.traders[0].snapshot.portfolio.status, 'UNAVAILABLE');
  assert.equal(view.traders[0].snapshot.portfolio.reason, 'FORBIDDEN_PRIVACY_UNPROVEN');
  assert.equal(view.capabilities.privateDetection, 'UNAVAILABLE_NO_DOCUMENTED_PRIVACY_MARKER');
  assert.equal(JSON.stringify(view).includes('SECRET_USER'), false);
});
test('periodic statistics cannot produce individual transaction events or units', async () => {
  const s = setup(); await s.observer.refresh(1);
  const row = s.observer.view().traders[0].snapshot;
  assert.equal(row.tradeStats.transactionHistoryStatus, 'UNAVAILABLE');
  assert.equal(row.portfolio.positions[0].units, null);
  assert.equal(row.effectiveAt, null); assert.equal(row.delaySeconds, null);
  assert.equal(row.portfolio.positions[0].reportedOpenAt, new Date(position.openTimestamp).toISOString());
  assert.equal(s.state.events.length, 0);
});
test('position appearance is presence evidence, and partial disappearance stays indeterminate', () => {
  const a = snapshot(start), b = snapshot(start + 1000, []);
  const removed = m.compareSnapshots(a, b);
  assert.equal(removed[0].type, 'INDETERMINATE');
  assert.equal(m.compareSnapshots(b, a)[0].type, 'POSITION_APPEARED');
  a.portfolio.complete = true; b.portfolio.complete = true;
  assert.equal(m.compareSnapshots(a, b)[0].type, 'POSITION_DISAPPEARED');
});
test('weight-only changes are not buys or sells; unknown raw units are not parsed', () => {
  const a = snapshot(start), b = snapshot(start + 1000, [{ ...position, investmentPct: 25, units: 100 }]);
  assert.equal(b.portfolio.positions[0].units, null);
  assert.deepEqual(m.compareSnapshots(a, b).map(e => e.type), ['WEIGHT_CHANGED']);
  // A future verified adapter may supply measured units; the difference remains distinct from transaction proof.
  a.portfolio.positions[0].units = 5; b.portfolio.positions[0].units = 4;
  assert.ok(m.compareSnapshots(a, b).some(e => e.type === 'UNITS_CHANGED'));
});
test('duplicate positions deduplicate, conflicting duplicates are excluded, incomplete pages never prove a sale', () => {
  assert.equal(m.normalizePortfolio({ positions: [position, position], socialTrades: [] }).positions.length, 1);
  const conflict = m.normalizePortfolio({ positions: [position, { ...position, investmentPct: 25 }], socialTrades: [] });
  assert.equal(conflict.positions.length, 0); assert.ok(conflict.invalidRows > 0);
  const a = snapshot(start), b = snapshot(start + 1000, []);
  b.portfolio.pagination = { complete: false, pagesFetched: 1, expectedPages: 2 };
  assert.equal(m.compareSnapshots(a, b)[0].type, 'INDETERMINATE');
});
test('event IDs deduplicate replay, are reproducible and retain provenance', () => {
  const a = snapshot(start), b = snapshot(start + 1000, [{ ...position, investmentPct: 25 }]);
  const one = m.emptyState(), two = m.emptyState();
  for (const s of [one, two]) { m.ingest(s, structuredClone(a)); m.ingest(s, structuredClone(b)); }
  assert.equal(m.ingest(one, b), false); assert.deepEqual(one.events, two.events);
  assert.equal(one.events[0].transactionProven, false); assert.ok(one.events[0].source && one.events[0].observationId && one.events[0].beforeObservationId);
});
test('corrected and late observations are journaled without overwriting newer baseline', () => {
  const state = m.emptyState(), a = snapshot(start), b = snapshot(start + 1000, [{ ...position, investmentPct: 25 }]);
  m.ingest(state, a); m.ingest(state, b);
  const corrected = snapshot(start + 1000, [{ ...position, investmentPct: 22 }]); m.ingest(state, corrected);
  assert.ok(state.events.some(e => e.type === 'OBSERVATION_CORRECTED'));
  m.ingest(state, snapshot(start - 1000, []));
  assert.equal(state.traders[1].snapshot.portfolio.positions[0].investmentPct, 22);
  assert.ok(state.events.some(e => e.type === 'LATE_OBSERVATION' && e.late));
});
test('missing portfolio does not reset baseline or turn recovered positions into new purchases', () => {
  const state = m.emptyState(), a = snapshot(start); m.ingest(state, a);
  const failed = snapshot(start + 1000); failed.portfolio = { status: 'UNAVAILABLE', positions: [], complete: false };
  m.ingest(state, failed); m.ingest(state, snapshot(start + 2000));
  assert.equal(state.events.length, 0);
});
test('performance corrections reject conflicting timestamp values and do not invent full history', () => {
  const normalized = m.normalizePerformance({ monthly: [{ timestamp: '2026-09-01', gain: 1 }, { timestamp: '2026-09-01', gain: 2 }], yearly: [] });
  assert.equal(normalized.status, 'UNAVAILABLE'); assert.equal(normalized.monthly.length, 0);
  assert.equal(normalized.historyComplete, null);
});
test('stale view and persisted restore retain freshness and event deduplication', async () => {
  const s = setup(); await s.observer.refresh(1); s.advance(3000);
  assert.equal(s.observer.view().traders[0].status, 'STALE');
  const restored = m.compactObserverState(JSON.parse(JSON.stringify(s.state)));
  assert.equal(m.ingest(restored, structuredClone(s.state.traders[1].snapshot)), false);
});
test('persistence budget truncation is explicit and preserves identity pin without synthetic removals', () => {
  const state = m.emptyState();
  for (let i = 1; i <= 5; i++) { const s = snapshot(start, Array.from({ length: 100 }, (_, n) => ({ ...position, positionId: n + 1 }))); s.realCID = i; s.identity.realCID = i; m.ingest(state, s); }
  for (const item of Object.values(state.traders)) item.lastAttempt = { at: new Date(start).toISOString(), status: 'UNAVAILABLE', reason: 'TEST_FAILURE', reads: Array.from({ length: 5 }, () => ({ source: ROOT + '/TraderOne/portfolio/live', context: { identityBinding: 'UNVERIFIED', credentialEnvironment: 'UNKNOWN', dataScope: 'PUBLIC_REAL_TRADER' } })) };
  const compact = m.compactObserverState(state, 4000);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 4000);
  assert.equal(compact.historyTruncated, true);
  assert.equal(compact.traders[1].identityPin.gcid, 101);
  assert.equal(compact.traders[1].baselineTruncated, true);
  const a = snapshot(start + 1000); m.ingest(compact, a);
  assert.equal(compact.events.some(e => e.type === 'POSITION_APPEARED'), false);
});
test('quota and 429 stop collection; no retries, secrets or arbitrary headers in outputs', async () => {
  const s = setup({ handler: () => new Response('SECRET_USER', { status: 429 }) });
  const result = await s.observer.refresh(1);
  assert.equal(result.reason, 'PROVIDER_QUOTA'); assert.equal(s.calls.length, 1);
  assert.equal((await s.client.read('profile', { realCID: 1 })).reason, 'READ_QUOTA_OR_COOLDOWN');
  assert.equal(JSON.stringify(s.observer.view()).includes('SECRET_USER'), false);
  const quota = setup(); for (let i = 0; i < 21; i++) await quota.client.read('profile', { realCID: 1 });
  assert.equal(quota.calls.length, 20);
});
test('timeouts and credential rotation discard errors without exposing their text', async () => {
  const s = setup({ timeoutMs: 10, handler: (_u, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('SECRET_USER')))) });
  assert.equal((await s.observer.refresh(1)).reason, 'NETWORK_OR_TIMEOUT_FAILURE');
  assert.equal(s.calls.length, 1);
  assert.equal(JSON.stringify(s.observer.view()).includes('SECRET_USER'), false);
  const rotate = setup({ handler: () => { rotate.env.ETORO_USER_KEY = 'ROTATED'; return new Response('{}'); } });
  assert.equal((await rotate.client.read('profile', { realCID: 1 })).reason, 'CREDENTIAL_CONTEXT_CHANGED');
});
test('persisted quota survives a new read client without storing any credential fingerprint', async () => {
  const quota = { timestamps: [], blockedUntil: 0 }; let calls = 0;
  const options = { env: { ETORO_API_KEY: 'KEY_ONE', ETORO_USER_KEY: 'KEY_TWO' }, clock: () => start,
    quotaStore: () => quota, fetchImpl: async () => { calls++; return new Response('{}'); } };
  const first = createTraderReadClient(options);
  for (let i = 0; i < 20; i++) await first.read('profile', { realCID: 1 });
  const second = createTraderReadClient(options);
  assert.equal((await second.read('profile', { realCID: 1 })).reason, 'READ_QUOTA_OR_COOLDOWN');
  assert.equal(calls, 20);
  assert.deepEqual(Object.keys(quota).sort(), ['blockedUntil', 'timestamps']);
});
test('profile secrets and invented transaction fields never enter persisted observations', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/people') ? new Response(JSON.stringify({ users: [{ realCID: 1, gcid: 101, username: 'TraderOne', userToken: 'SECRET_USER', fullName: 'PRIVATE_PERSON' }] }))
    : u.pathname.endsWith('/portfolio/live') ? new Response(JSON.stringify({ ...portfolio(), transactions: [{ side: 'BUY', secret: 'SECRET_USER' }] })) : undefined });
  await s.observer.refresh(1); const text = JSON.stringify(s.state);
  assert.equal(text.includes('SECRET_USER'), false); assert.equal(text.includes('PRIVATE_PERSON'), false);
  assert.equal(s.state.events.some(e => e.transactionProven), false);
});
test('authenticated dashboard is cache-only and unconfigured/unauthorized refreshes cannot reach eToro', async () => {
  const priorSecret = process.env.BOT_SECRET, priorList = process.env.TRADER_OBSERVER_TRADERS_JSON, originalFetch = global.fetch;
  try {
    process.env.BOT_SECRET = 'OBSERVER_TEST_AUTH'; process.env.TRADER_OBSERVER_TRADERS_JSON = '[]'; let calls = 0;
    global.fetch = async () => { calls++; throw Error('unexpected request'); };
    const { app } = require('./index');
    const invoke = async (path, method, auth, body) => {
      const route = app._router.stack.find(l => l.route?.path === path && l.route.methods[method]).route;
      let status = 200, value, allowed = false;
      const req = { headers: auth ? { 'x-bot-secret': 'OBSERVER_TEST_AUTH' } : {}, query: {}, body };
      const res = { status(n) { status = n; return this; }, json(v) { value = v; }, setHeader() {} };
      route.stack[0].handle(req, res, () => { allowed = true; });
      if (allowed) await route.stack[1].handle(req, res);
      return { status, value };
    };
    assert.equal((await invoke('/trader-observer-refresh', 'post', false, { realCID: 1 })).status, 401);
    const view = await invoke('/trader-observer-status', 'get', true);
    assert.equal(view.value.executionAttempted, false); assert.deepEqual(view.value.traders, []);
    assert.equal((await invoke('/trader-observer-refresh', 'post', true, { realCID: 1 })).status, 400);
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
    if (priorSecret === undefined) delete process.env.BOT_SECRET; else process.env.BOT_SECRET = priorSecret;
    if (priorList === undefined) delete process.env.TRADER_OBSERVER_TRADERS_JSON; else process.env.TRADER_OBSERVER_TRADERS_JSON = priorList;
  }
});
test('429 cooldown survives persistence that replaces the quota object', async () => {
  let saved = { timestamps: [], blockedUntil: 0 };
  const client = createTraderReadClient({ env: { ETORO_API_KEY: 'API', ETORO_USER_KEY: 'USER' }, clock: () => start,
    quotaStore: () => saved, onQuotaChange: () => { saved = structuredClone(saved); },
    fetchImpl: async () => new Response('{}', { status: 429 }) });
  await client.read('profile', { realCID: 1 });
  assert.equal(saved.blockedUntil, start + 60000);
  assert.equal((await client.read('profile', { realCID: 1 })).reason, 'READ_QUOTA_OR_COOLDOWN');
});
