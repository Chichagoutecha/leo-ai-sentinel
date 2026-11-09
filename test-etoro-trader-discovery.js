'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createTraderReadClient, RANKINGS } = require('./etoro-trader-observer');
const { createDiscovery, diagnostic, combine, options } = require('./etoro-trader-discovery');
const AT = Date.parse('2026-11-06T15:30:00Z');
const row = (cid = 1, extra = {}) => ({ cid, username: `Trader${cid}`, type: 'trader', riskScore: 4,
  gain: 30, annualizedReturn: 12, firstActivity: '2020-01-01T00:00:00Z', lastActivity: '2026-11-05T00:00:00Z', ...extra });
function setup({ configuration, handler, env: overrides, verifyObserver } = {}) {
  let now = AT; const calls = [], env = { ETORO_API_KEY: 'SECRET_APPLICATION', ETORO_USER_KEY: 'SECRET_USER', ...overrides };
  const state = { version: 1, lastAttemptAt: null, report: null, readQuota: { timestamps: [], blockedUntil: 0 } };
  const client = createTraderReadClient({ env, clock: () => now, quotaStore: () => state.readQuota, fetchImpl: async (url, init) => {
    const u = new URL(url); calls.push({ url, method: init.method, body: init.body, redirect: init.redirect });
    const result = handler && await handler(u, init);
    if (result !== undefined) return result;
    const body = url.startsWith(RANKINGS) ? { results: [row()], pagination: { page: Number(u.searchParams.get('page')), pageSize: Number(u.searchParams.get('pageSize')), hasNext: false, totalItems: 1 } }
      : u.pathname.endsWith('/people') ? { users: [{ realCID: Number(u.searchParams.get('usernames')?.replace(/^Trader/, '')), gcid: 101, username: 'Trader1' }] }
      : { positions: [{ positionId: 10, instrumentId: 100, isBuy: true, leverage: 1, investmentPct: 10 }], socialTrades: [] };
    return new Response(JSON.stringify(body));
  } });
  const discovery = createDiscovery({ env, client, clock: () => now, configuration, getState: () => state, verifyObserver });
  return { discovery, calls, state, env, client, advance: ms => { now += ms; } };
}
test('default CLI imports no startup code and never sends a request', () => {
  const result = spawnSync(process.execPath, ['etoro-trader-discovery.js'], { cwd: __dirname, env: {}, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).providerCalls, 0);
  assert.equal(JSON.parse(result.stdout).status, 'NOT_TESTED'); assert.equal(result.stderr, '');
});
test('five bounded official GETs verify one public identity, never select or trade', async () => {
  const s = setup(), report = await s.discovery.refresh();
  assert.equal(s.calls.length, 5); assert.equal(report.providerCalls, 5); assert.equal(report.maxRequests, 5);
  assert.ok(s.calls.every(c => c.method === 'GET' && c.body === undefined && c.redirect === 'error'));
  assert.equal(report.candidates[0].identityStatus, 'VERIFIED_READ');
  assert.deepEqual(report.candidates[0].observerCandidate, { realCID: 1, expectedGcid: 101 });
  assert.equal(report.candidates[0].holdingsStatus, 'PARTIAL');
  assert.equal(report.comparison.status, 'UNAVAILABLE'); assert.equal(report.selection.count, 0);
  assert.equal(report.candidates[0].bestTraderRank, null); assert.equal(report.executionAttempted, false);
});
test('list discovery does not sort by gain, copiers or popularity, or assume names are identities', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/rankings') ? new Response(JSON.stringify({ results: [row(2, { gain: 900, copiers: 1000000 }), row(1)],
    pagination: { page: 1, pageSize: 20, hasNext: false, totalItems: 2 } })) : undefined });
  const r = await s.discovery.refresh();
  assert.deepEqual(r.candidates.map(c => c.providerCid), [1, 2]);
  assert.equal(r.candidates[1].identityStatus, 'UNVERIFIED'); assert.equal(r.candidates[1].selectedForTrading, false);
  assert.equal('copiers' in r.candidates[1].periods.AbsOneYear.metrics, false);
});
test('missing and invalid metrics remain unknown, not zero or positive scores', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/rankings') ? new Response(JSON.stringify({ results: [row(1, { riskScore: 0, gain: '50', annualizedReturn: null })],
    pagination: { page: 1, pageSize: 20, hasNext: false, totalItems: 1 } })) : undefined });
  const r = await s.discovery.refresh(), m = r.candidates[0].periods.AbsOneYear;
  assert.equal(m.metrics.riskScore, null); assert.equal(m.metrics.gain, null); assert.equal(m.metrics.annualizedReturn, null);
  assert.ok(m.missingFields.includes('volatility')); assert.equal(m.confidence, 'INSUFFICIENT_FOR_BEST_TRADER_RANKING');
});
test('missing keys cause zero requests, with no attempt to start the main server', async () => {
  const s = setup({ env: { ETORO_API_KEY: '' } }), r = await s.discovery.refresh();
  assert.equal(s.calls.length, 0); assert.equal(r.providerCalls, 0); assert.equal(r.candidates.length, 0);
  assert.equal(r.checks[0].reason, 'CREDENTIALS_ABSENT');
});
for (const [http, status] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [429, 'UNAVAILABLE']]) test(`${http} is not retried or bypassed and does not imply other capabilities`, async () => {
  const s = setup({ handler: () => new Response('DO_NOT_PRINT_SECRET_USER', { status: http }) });
  const r = await s.discovery.refresh(); await s.discovery.refresh();
  assert.equal(s.calls.length, 1); assert.equal(r.checks[0].status, status); assert.equal(r.candidates.length, 0);
  const d = diagnostic(r); assert.equal(d.realOrderRights, 'NOT_TESTED'); assert.equal(d.realAccountIdentity, 'NOT_TESTED');
  assert.equal(JSON.stringify(d).includes('SECRET_USER'), false);
});
test('partial pagination never becomes whole-app coverage', async () => {
  const s = setup({ configuration: { pageSize: 1 }, handler: u => u.pathname.endsWith('/rankings') ? new Response(JSON.stringify({ results: [row()],
    pagination: { page: 1, pageSize: 1, hasNext: true, totalItems: 5000 } })) : undefined });
  const r = await s.discovery.refresh();
  assert.equal(r.coverage.AbsOneYear.status, 'PARTIAL'); assert.equal(r.coverage.AbsOneYear.enumerationComplete, false);
  assert.equal(r.coverage.AbsOneYear.reportedTotalItems, 5000); assert.equal(r.comparison.ranking, null);
});
test('contradictory repeated rows quarantine the identity; exact duplicates degrade coverage', async () => {
  for (const contradictory of [true, false]) {
    const s = setup({ configuration: { pageSize: 1, maxPages: 2 }, handler: u => {
      if (!u.pathname.endsWith('/rankings')) return;
      const page = Number(u.searchParams.get('page'));
      return new Response(JSON.stringify({ results: [row(1, page === 2 && contradictory ? { gain: 900 } : {})],
        pagination: { page, pageSize: 1, hasNext: page === 1, totalItems: 2 } }));
    } });
    const r = await s.discovery.refresh();
    assert.equal(r.coverage.AbsOneYear.enumerationComplete, false); assert.equal(r.coverage.AbsOneYear.duplicateRows, 1);
    if (contradictory) { assert.equal(r.candidates[0].status, 'AMBIGUOUS'); assert.equal(s.calls.length, 4); }
  }
});
test('contradictory names across periods cannot produce an observer configuration', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/rankings') ? new Response(JSON.stringify({ results: [row(1, { username: u.searchParams.get('period') === 'AbsOneYear' ? 'OldName' : 'NewName' })],
    pagination: { page: 1, pageSize: 20, hasNext: false, totalItems: 1 } })) : undefined });
  const r = await s.discovery.refresh(); assert.equal(r.candidates[0].status, 'AMBIGUOUS'); assert.equal(s.calls.length, 2);
});
test('ranking CID is not blindly declared to be a stable real account ID', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/people') ? new Response(JSON.stringify({ users: [{ realCID: 999, gcid: 101, username: 'Trader1' }] })) : undefined });
  const r = await s.discovery.refresh(); assert.equal(r.candidates[0].identityStatus, 'UNVERIFIED');
  assert.equal(r.candidates[0].observerCandidate, null); assert.equal(r.candidates[0].holdingsStatus, 'UNAVAILABLE');
  assert.equal(diagnostic(r).candidateChecks[0].identityReason, 'RANKING_CID_NOT_CONFIRMED_BY_PROFILE');
  assert.equal(s.calls.some(c => c.url.endsWith('/portfolio/live')), false);
});
test('ranking CID can be the global ID while the observer uses the separate real account ID', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/people')
    ? new Response(JSON.stringify({ users: [{ realCID: 999, gcid: 1, username: 'Trader1', isPi: true }] })) : undefined });
  const report = await s.discovery.refresh();
  const profiles = s.calls.filter(c => new URL(c.url).pathname.endsWith('/people'));
  assert.equal(profiles.length, 2);
  assert.ok(profiles.every(c => new URL(c.url).search === '?usernames=Trader1'));
  assert.deepEqual(report.candidates[0].observerCandidate, { realCID: 999, expectedGcid: 1 });
  assert.equal(diagnostic(report).candidateChecks[0].rankingCidBinding, 'GCID');
});
test('a changed account behind the same ranked username discards the portfolio', async () => {
  let profiles = 0;
  const s = setup({ handler: u => u.pathname.endsWith('/people')
    ? new Response(JSON.stringify({ users: [{ realCID: ++profiles === 1 ? 999 : 998, gcid: 1, username: 'Trader1' }] })) : undefined });
  const report = diagnostic(await s.discovery.refresh());
  assert.equal(report.providerCalls, 5);
  assert.equal(report.verifiedPublicIdentities, 0);
  assert.equal(report.publicPortfoliosReadable, 0);
  assert.equal(report.candidateChecks[0].holdingsReason, 'IDENTITY_CONFIRMATION_FAILED');
});
test('isolated observer uses the confirmed real CID and reports truncation without disclosing positions', async () => {
  const positions = Array.from({ length: 105 }, (_, i) => ({ positionId: i + 5000, instrumentId: i + 1000 }));
  const s = setup({ verifyObserver: true, handler: u => {
    if (u.pathname.endsWith('/people')) return new Response(JSON.stringify({
      users: [{ realCID: 999, gcid: 1, username: 'Trader1', isPi: true }]
    }));
    if (u.pathname.endsWith('/portfolio/live')) return new Response(JSON.stringify({ positions, socialTrades: [] }));
  } });
  const report = diagnostic(await s.discovery.refresh());
  assert.equal(report.providerCalls, 8);
  assert.equal(report.maxRequests, 8);
  assert.equal(s.calls.filter(c => new URL(c.url).search === '?cidList=999').length, 2);
  assert.deepEqual(report.candidateChecks[0].holdingsCoverage, {
    returnedDirectRows: 105, returnedCopyRows: 0, retainedRows: 100,
    localTruncation: true, providerCompleteness: 'UNVERIFIED'
  });
  assert.deepEqual(report.observerProbe, {
    status: 'PARTIAL', reason: 'LOCAL_POSITION_LIMIT', retainedRows: 100, context: 'OBSERVED_PRESENCE_ONLY'
  });
  assert.equal(report.selection.count, 0);
  assert.doesNotMatch(JSON.stringify(report), /Trader1|positionId|instrumentId|expectedGcid/);
});
test('a real CID lookup that disagrees with the verified discovery binding stops the observer probe', async () => {
  const s = setup({ verifyObserver: true, handler: u => {
    if (u.pathname.endsWith('/people')) return new Response(JSON.stringify({
      users: [{ realCID: 999, gcid: u.searchParams.has('cidList') ? 2 : 1, username: 'Trader1', isPi: true }]
    }));
  } });
  const report = diagnostic(await s.discovery.refresh());
  assert.equal(report.providerCalls, 6);
  assert.equal(s.calls.filter(c => c.url.endsWith('/portfolio/live')).length, 1);
  assert.equal(report.observerProbe.status, 'UNAVAILABLE');
  assert.equal(report.observerProbe.reason, 'IDENTITY_CONFLICT');
});
test('successful response with missing pagination or an incorrect page is unusable', async () => {
  for (const pagination of [null, { page: 2, pageSize: 20, hasNext: false, totalItems: 1 }]) {
    const s = setup({ handler: () => new Response(JSON.stringify({ results: [row()], pagination })) });
    const r = await s.discovery.refresh(); assert.equal(r.candidates.length, 0);
    assert.ok(r.checks.every(c => c.status === 'UNAVAILABLE' && c.expectedStructure === 'ABSENT'));
  }
});
test('forbidden public portfolio is not proven private and does not imply no real-account access', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/portfolio/live') ? new Response('{}', { status: 403 }) : undefined });
  const r = await s.discovery.refresh(); assert.equal(r.candidates[0].holdingsStatus, 'UNAVAILABLE');
  assert.equal(r.candidates[0].identityStatus, 'VERIFIED_READ'); assert.equal(r.candidates[0].observerCandidate, null);
  assert.equal(diagnostic(r).realAccountIdentity, 'NOT_TESTED');
});
test('views and refresh cooldown are cache-only; expiry is explicit', async () => {
  const s = setup(); await s.discovery.refresh(); s.discovery.view(); await s.discovery.refresh();
  assert.equal(s.calls.length, 5); s.advance(86400001); assert.equal(s.discovery.view().status, 'STALE');
  assert.equal(s.calls.length, 5); s.env.ETORO_USER_KEY = 'NEW_SECRET'; assert.equal(s.discovery.view().status, 'UNAVAILABLE');
});
test('in-flight credential rotation discards the report and never exposes the old secret', async () => {
  let s; s = setup({ handler: () => { s.env.ETORO_USER_KEY = 'ROTATED'; return new Response('{}'); } });
  const r = await s.discovery.refresh(); assert.equal(r.reason, 'CREDENTIAL_CONTEXT_CHANGED'); assert.equal(s.state.report, null);
  assert.equal(JSON.stringify(r).includes('SECRET_USER'), false);
});
test('diagnostic retains neither public names/IDs nor accidental secret response fields', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/rankings') ? new Response(JSON.stringify({ results: [row(1, { fullName: 'PERSONAL_NAME', token: 'SECRET_USER', headers: { key: 'SECRET_APPLICATION' } })],
    pagination: { page: 1, pageSize: 20, hasNext: false, totalItems: 1 } })) : undefined });
  const r = await s.discovery.refresh(), text = JSON.stringify(diagnostic(r));
  for (const unsafe of ['PERSONAL_NAME', 'SECRET_USER', 'SECRET_APPLICATION', 'Trader1', 'expectedGcid', 'investmentPct']) assert.equal(text.includes(unsafe), false, unsafe);
  assert.equal(JSON.stringify(r).includes('SECRET_USER'), false);
});
test('arbitrary endpoints, POSTs, sort/filter injection and overflowing request budgets are refused', async () => {
  const s = setup();
  for (const selector of [{ period: 'AbsOneYear', page: 1, pageSize: 20, method: 'POST' }, { period: '../orders', page: 1, pageSize: 20 }, { period: 'AbsOneYear', page: 4, pageSize: 20 }, { period: 'AbsOneYear', page: 1, pageSize: 101 }]) {
    assert.equal((await s.client.read('rankings', selector)).reason, 'READ_NOT_ALLOWLISTED');
  }
  assert.equal(s.calls.length, 0); assert.throws(() => options({ endpoint: 'anything' }));
  assert.throws(() => options({ maxPages: 3, verifyCount: 5 }));
});
test('concurrent collection is rejected, network attempts counted even without HTTP response', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const s = setup({ handler: async () => { await gate; throw Error('SECRET_APPLICATION'); } });
  const pending = s.discovery.refresh(); const second = await s.discovery.refresh(); assert.equal(second.reason, 'COLLECTION_IN_PROGRESS');
  release(); const report = await pending; assert.equal(report.providerCalls, 2); assert.equal(s.calls.length, 2);
  assert.equal(JSON.stringify(diagnostic(report)).includes('SECRET_APPLICATION'), false);
});
test('different totals during pagination make coverage partial and calculations deterministic', () => {
  const page = (n, total, cid) => ({ period: 'AbsOneYear', page: n, httpStatus: 200, status: 'AVAILABLE',
    pagination: { page: n, pageSize: 1, hasNext: n === 1, totalItems: total }, rows: [{ providerCid: cid, username: `Trader${cid}` }] });
  const pages = [page(1, 2, 1), page(2, 3, 2)];
  const a = combine(pages, AT); assert.deepEqual(a, combine(pages, AT));
  assert.equal(a.coverage.AbsOneYear.reason, 'UNIVERSE_CHANGED_DURING_PAGINATION');
  assert.equal(a.coverage.AbsOneYear.enumerationComplete, false); assert.equal(a.coverage.AbsOneYear.reportedTotalItems, null);
});
test('restoring a report never silently binds it to the newly loaded credentials', async () => {
  const s = setup(); await s.discovery.refresh();
  const restored = createDiscovery({ env: s.env, client: s.client, clock: () => AT, getState: () => s.state });
  assert.equal(restored.view().status, 'UNAVAILABLE');
  await restored.refresh(); assert.equal(s.calls.length, 10);
});
test('HTTP 200 without valid public identity is not reported as a verified identity structure', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/people') ? new Response('{"users":[]}') : undefined });
  const r = await s.discovery.refresh(), check = r.checks.find(c => c.capability === 'PUBLIC_TRADER_IDENTITY');
  assert.equal(check.httpStatus, 200); assert.equal(check.status, 'UNAVAILABLE'); assert.equal(check.expectedStructure, 'UNVERIFIED');
  assert.equal(diagnostic(r).verifiedPublicIdentities, 0);
});
test('discovery always requests the officially documented active Popular Investor filter', async () => {
  const s = setup(); await s.discovery.refresh();
  const ranks = s.calls.filter(c => c.url.startsWith(RANKINGS));
  assert.equal(ranks.length, 2); assert.ok(ranks.every(c => new URL(c.url).searchParams.get('popularInvestor') === 'true'));
  const before = s.calls.length;
  for (const value of [false, 'true', 1, null]) assert.equal((await s.client.read('rankings', { period: 'AbsOneYear', page: 1, pageSize: 20, popularInvestor: value })).reason, 'READ_NOT_ALLOWLISTED');
  assert.equal(s.calls.length, before);
});
for (const [name, reason] of [['OtherTrader', 'RANKING_PROFILE_USERNAME_MISMATCH'], ['trader1', 'RANKING_PROFILE_USERNAME_CASE_DIFFERENCE']]) test(`ranking mismatch ${reason} is explained before any portfolio request`, async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/people') ? new Response(JSON.stringify({ users: [{ realCID: 1, gcid: 101, username: name }] })) : undefined });
  const r = await s.discovery.refresh(), d = diagnostic(r);
  assert.equal(s.calls.length, 3); assert.equal(s.calls.some(c => c.url.endsWith('/portfolio/live')), false);
  assert.equal(d.candidateChecks[0].publicIdentityRead, 'VERIFIED_READ');
  assert.equal(d.candidateChecks[0].rankingProfileMatch, 'MISMATCH'); assert.equal(d.candidateChecks[0].identityReason, reason);
  assert.equal(d.candidateChecks[0].holdingsReason, 'NOT_REQUESTED_IDENTITY_MISMATCH'); assert.equal(d.verifiedPublicIdentities, 0);
  assert.equal(JSON.stringify(d).includes(name), false);
});
test('a forbidden portfolio is local to its candidate; three independent candidates stay within eleven GETs', async () => {
  const s = setup({ configuration: { verifyCount: 3 }, handler: u => {
    if (u.pathname.endsWith('/rankings')) return new Response(JSON.stringify({ results: [row(1), row(2), row(3)], pagination: { page: 1, pageSize: 20, hasNext: false, totalItems: 3 } }));
    if (u.pathname.endsWith('/people')) { const id = Number(u.searchParams.get('usernames')?.replace(/^Trader/, '')); return new Response(JSON.stringify({ users: [{ realCID: id, gcid: id + 100, username: `Trader${id}`, isPi: true }] })); }
    if (u.pathname.endsWith('/Trader1/portfolio/live')) return new Response('{}', { status: 403 });
  } });
  const r = await s.discovery.refresh(), d = diagnostic(r);
  assert.equal(s.calls.length, 11); assert.equal(r.maxRequests, 11); assert.equal(r.providerCalls, 11);
  assert.equal(d.candidateChecks[0].holdingsStatus, 'UNAVAILABLE');
  assert.equal(d.candidateChecks[0].holdingsReason, 'FORBIDDEN_PRIVACY_UNPROVEN');
  assert.equal(d.publicPortfoliosReadable, 2); assert.equal(d.verifiedPublicIdentities, 3);
  assert.equal(d.selection.count, 0); assert.equal(s.calls.filter(c => c.url.endsWith('/Trader1/portfolio/live')).length, 1);
});
test('successful filtered rankings contradicted by profile isPi=false never suggest observer enrollment', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/people') ? new Response(JSON.stringify({ users: [{ realCID: 1, gcid: 101, username: 'Trader1', isPi: false }] })) : undefined });
  const r = await s.discovery.refresh(); assert.equal(r.candidates[0].popularInvestorStatus, 'CONTRADICTED_BY_PROFILE');
  assert.equal(r.candidates[0].observerCandidate, null); assert.equal(r.selection.count, 0);
});
test('rejection counts explain unsupported rows without retaining raw types, names or secrets', async () => {
  const s = setup({ handler: u => u.pathname.endsWith('/rankings') ? new Response(JSON.stringify({ results: [row(), row(2, { type: 'SECRET_USER' }), row(0), row(3, { username: 'unsafe/name' })],
    pagination: { page: 1, pageSize: 20, hasNext: false, totalItems: 4 } })) : undefined });
  const r = await s.discovery.refresh();
  assert.deepEqual(r.coverage.AbsOneYear.rejectedRows, { invalidCid: 1, notDocumentedTraderType: 1, invalidOrUnsafeUsername: 1 });
  assert.equal(JSON.stringify(r).includes('SECRET_USER'), false); assert.equal(JSON.stringify(r).includes('unsafe/name'), false);
});
test('request IDs are fresh correlation UUIDs, not authentication or secret fingerprints', async () => {
  const s = setup(); const r = await s.discovery.refresh();
  assert.equal(new Set(r.checks.map(c => c.requestId)).size, 5);
  assert.ok(r.checks.every(c => /^[a-f0-9-]{36}$/.test(c.requestId)));
  assert.equal(JSON.stringify(diagnostic(r)).includes('SECRET_APPLICATION'), false);
});
test('a 401 during candidate observation stops the remaining candidates without retry', async () => {
  const s = setup({ configuration: { verifyCount: 3 }, handler: u => {
    if (u.pathname.endsWith('/rankings')) return new Response(JSON.stringify({ results: [row(1), row(2), row(3)], pagination: { page: 1, pageSize: 20, hasNext: false, totalItems: 3 } }));
    return new Response('{}', { status: 401 });
  } });
  const r = await s.discovery.refresh(); assert.equal(s.calls.length, 3); assert.equal(r.providerCalls, 3);
  assert.equal(r.checks.at(-1).status, 'UNAUTHORIZED'); assert.equal(r.candidates.filter(c => c.publicIdentityRead).length, 1);
});
test('completion timestamp includes the candidate checks rather than only the ranking stage', async () => {
  let s; s = setup({ handler: () => { s.advance(100); } });
  const r = await s.discovery.refresh(); assert.ok(r.checks.every(c => Date.parse(c.checkedAt) <= Date.parse(r.generatedAt)));
  assert.equal(Date.parse(r.generatedAt), AT + 500);
});
