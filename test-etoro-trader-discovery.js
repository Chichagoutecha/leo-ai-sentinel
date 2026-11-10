'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createTraderReadClient, RANKINGS } = require('./etoro-trader-observer');
const { createDiscovery, diagnostic, combine, options } = require('./etoro-trader-discovery');
const { research, allocationProbe, screenAnnual } = require('./trader-allocation-research');
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
test('allocation research compares common closed days using only five allowlisted GETs', async () => {
  const holdings = (...instrumentIds) => instrumentIds.map(instrumentId => ({ instrumentId, valuePct: 0.2 }));
  const day = (date, ...ids) => ({ date, assets: holdings(...ids) });
  const s = setup({ handler: u => {
    const username = u.pathname.split('/')[4];
    assert.equal(u.origin, 'https://public-api.etoro.com');
    assert.equal(u.pathname, `/api/v2/portfolios/${username}/assets/history`);
    assert.equal(u.search, '?period=CurrMonth&count=7');
    if (username === 'WildNico') return new Response('SECRET_ERROR', { status: 403 });
    const rows = {
      tintinmelo75: [day('2026-11-05', 1, 2), day('2026-11-06', 3), day('2026-11-07', 3)],
      Cleonfe: [day('2026-11-05', 1), day('2026-11-06', 3), day('2026-11-07', 3)],
      HaoNing: [day('2026-11-05', 2), day('2026-11-05', 3)],
      IsraMX: [day('2026-11-05', 1, 1)]
    };
    return Response.json({ userName: username.toLowerCase(), results: rows[username], token: 'SECRET_RESPONSE' });
  } });
  const report = await research({ client: s.client, clock: () => AT });
  assert.equal(report.status, 'OBSERVED_OVERLAP_ONLY');
  assert.equal(report.calls, 5);
  assert.equal(report.comparison.day, '2026-11-05');
  assert.deepEqual(report.comparison.sharedInstruments, [{ instrumentId: 1, profiles: ['tintinmelo75', 'Cleonfe'] }]);
  assert.equal(report.comparison.coverageComplete, null);
  assert.equal(report.executionAllowed, false);
  assert.equal(report.transactionEvidence, false);
  assert.equal(report.coverageComplete, null);
  assert.ok(s.calls.every(c => c.method === 'GET' && c.body === undefined && c.redirect === 'error'));
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});
test('allocation research rejects another profile and stops on authorization or quota errors', async () => {
  for (const status of [401, 429]) {
    const s = setup({ handler: u => u.pathname.includes('tintinmelo75')
      ? Response.json({ userName: 'different', results: [{ date: '2026-11-05', assets: [{ instrumentId: 1, valuePct: 0.2 }] }] })
      : new Response('', { status }) });
    const report = await research({ client: s.client, clock: () => AT });
    assert.equal(report.status, 'NO_COMPARABLE_CLOSED_DAY');
    assert.equal(report.calls, 2);
    assert.equal(report.profiles[0].reason, 'ALLOCATION_RESPONSE_UNVERIFIED');
    assert.equal(report.profiles[1].httpStatus, status);
    assert.equal((await s.client.read('allocationHistory', { username: 'valid', path: '/orders' })).reason, 'READ_NOT_ALLOWLISTED');
    assert.equal(s.calls.length, 2);
  }
});
test('targeted allocation probe distinguishes empty data from rejected rows without leaking assets', async () => {
  const s = setup({ handler: u => {
    const username = u.pathname.split('/')[4];
    assert.equal(u.pathname, `/api/v2/portfolios/${username}/assets/history`);
    const asset = { instrumentId: 1, valuePct: 0.2, symbol: 'SECRET_SIMULATED_SYMBOL' };
    const results = username === 'thomaspj' ? [] : username === 'triangulacapital' ? [
      { date: '2026-11-04', assets: [asset, { instrumentId: 1, valuePct: null }] },
      { date: '2026-11-05', assets: [{ instrumentId: 0, valuePct: -0.1 }] },
      { date: '2026-11-06', assets: [asset] }
    ] : [{ date: '2026-11-05', assets: [asset] }];
    return Response.json({ userName: username, results, token: 'SECRET_RESPONSE' });
  } });
  const r = await allocationProbe({ client: s.client, clock: () => AT });
  assert.deepEqual(r.profiles.map(p => p.username), ['thomaspj', 'triangulacapital', 'tintinmelo75']);
  assert.equal(r.calls, 3);
  assert.equal(r.profiles[0].coverage.reportedDays, 0);
  assert.equal(r.profiles[1].coverage.daysWithAssets, 3);
  assert.equal(r.profiles[1].coverage.usableDays, 0);
  assert.deepEqual(r.profiles[1].coverage.invalidInstrumentIdKinds, { ZERO: 1 });
  assert.deepEqual(r.profiles[1].coverage.rejectionReasons, { DUPLICATE_INSTRUMENT_ID: 1, MISSING_OR_INVALID_VALUE_PCT: 1,
    INVALID_INSTRUMENT_ID: 1, NEGATIVE_VALUE_PCT: 1, CURRENT_OR_FUTURE_DATE: 1 });
  assert.equal(r.profiles[2].coverage.latestUsableDay, '2026-11-05');
  assert.ok(s.calls.every(x => x.method === 'GET' && x.body === undefined));
  assert.equal(r.executionAllowed, false);
  assert.doesNotMatch(JSON.stringify(r), /SECRET|instrumentId/);
});
test('known allocation rows remain comparable while unresolved rows and duplicate instruments are excluded', async () => {
  const asset = (instrumentId, valuePct = 0.2) => ({ instrumentId, valuePct });
  const s = setup({ handler: u => {
    const username = u.pathname.split('/')[4];
    const assets = username === 'thomaspj' ? [asset(1), asset(2), asset(0), asset(2)]
      : username === 'triangulacapital' ? [asset(1), asset(2), asset(null), asset('3'), asset(4, 0)]
        : [asset(1)];
    return Response.json({ userName: username, results: [{ date: '2026-11-05', assets }] });
  } });
  const r = await allocationProbe({ client: s.client, clock: () => AT });
  assert.equal(r.profiles[0].coverage.usableDays, 1);
  assert.equal(r.profiles[0].coverage.partialDays, 1);
  assert.deepEqual(r.profiles[1].coverage.invalidInstrumentIdKinds, { MISSING_OR_NULL: 1, STRING: 1 });
  assert.deepEqual(r.comparison.byProfile, [{ username: 'thomaspj', knownInstruments: 1, unresolvedRows: 3 },
    { username: 'triangulacapital', knownInstruments: 2, unresolvedRows: 2 }]);
  assert.deepEqual(r.comparison.sharedInstruments, [{ instrumentId: 1, profiles: ['thomaspj', 'triangulacapital'] }]);
  assert.equal(r.comparison.coverageComplete, null);
  assert.equal(r.comparison.independenceVerified, false);
  assert.equal(r.transactionEvidence, false);
});

test('cohort observation measures every common closed day with only the two candidate reads', async () => {
  const s = setup({ handler: u => {
    const username = u.pathname.split('/')[4], left = username === 'thomaspj';
    const asset = (instrumentId, valuePct) => ({ instrumentId, valuePct });
    const dates = [
      { date: '2026-11-06', assets: [asset(3, 0.5)] },
      { date: '2026-11-05', assets: [asset(left ? 7 : 8, 0.25), asset(0, 0.6)] },
      { date: '2026-11-04', assets: [asset(1, 0.2), asset(2, 0.2)] },
      ...(left ? [{ date: '2026-11-03', assets: [asset(9, 0.5)] }] : [])
    ];
    return Response.json({ userName: username, results: dates });
  } });
  const r = await allocationProbe({ client: s.client, clock: () => AT, observe: true });
  assert.equal(r.mode, 'SHADOW_RESEARCH_OBSERVATION');
  assert.equal(r.calls, 2);
  assert.deepEqual(r.profiles.map(row => row.username), ['thomaspj', 'triangulacapital']);
  assert.equal(r.history.commonDays, 2);
  assert.equal(r.history.daysWithKnownOverlap, 1);
  assert.equal(r.history.daysWithUnresolvedRows, 1);
  assert.deepEqual(r.history.days.map(row => row.day), ['2026-11-04', '2026-11-05']);
  assert.deepEqual(r.history.days[0].byProfile[0].largestKnown, { instrumentId: 1, reportedValuePct: 0.2 });
  assert.deepEqual(r.history.days[1].byProfile[0].largestKnown, { instrumentId: 7, reportedValuePct: 0.25 });
  assert.equal(r.comparison.knownSharedInstrumentCount, 0);
  assert.equal(r.executionAllowed, false);
  assert.equal(r.transactionEvidence, false);
  assert.equal(r.stableIdentitiesVerified, false);
});

function annualSetup(gains, { allocStatus = 200, identityChange = false, months = {}, mismatch = false, partial = false } = {}) {
  const ids = Object.keys(gains).map(Number);
  const identities = new Map();
  return setup({ handler: u => {
    if (u.pathname.endsWith('/rankings')) return Response.json({ results: ids.map(id => row(id, { firstActivity: id === 2 ? null : '2024-11-01T00:00:00Z' })),
      pagination: { page: 1, pageSize: 100, hasNext: false, totalItems: ids.length } });
    const username = u.searchParams.get('usernames') || u.pathname.split('/').find(part => /^Trader\d+$/.test(part));
    const id = Number(username?.slice(6));
    if (u.searchParams.has('usernames')) {
      const seen = identities.get(id) || 0; identities.set(id, seen + 1);
      return Response.json({ users: [{ realCID: id, gcid: identityChange && seen ? 7000 + id : 1000 + id, username, isPi: true }] });
    }
    if (u.pathname.endsWith('/gain/yearly')) return Response.json({ username: mismatch ? 'AnotherUser' : username.toLowerCase(),
      granularity: 'yearly', gains: gains[id].map(([year, gain]) => ({ date: `${year}-01-01`, gain: gain / 100 })) });
    if (u.pathname.endsWith('/gain/monthly')) return Response.json({ username, granularity: 'monthly',
      gains: (months[id] || []).map(date => ({ date, gain: 0 })) });
    assert.ok(u.pathname.endsWith('/assets/history'));
    if (allocStatus !== 200) return new Response('SECRET_ALLOCATION_RESPONSE', { status: allocStatus });
    const assets = [{ instrumentId: 1, valuePct: 0.1 }];
    if (partial) assets.push({ instrumentId: 0, valuePct: 0.2 });
    return Response.json({ userName: username, results: ['2026-11-04', '2026-11-05'].map(date => ({ date, assets })) });
  } });
}

const positiveFullYears = Array.from({ length: 6 }, (_, i) => [2020 + i, i]);
test('annual screen uses v2 year buckets even when ranking activity is recent or missing', async () => {
  const s = annualSetup({ 1: positiveFullYears,
    2: [[2019, 1], [2020, -1], ...positiveFullYears.slice(1)], 3: positiveFullYears.filter(([year]) => year !== 2022),
    4: [...positiveFullYears, [2025, -1]], 5: [[2019, -99], ...positiveFullYears], 6: [...positiveFullYears, [2026, -99]] });
  const r = await screenAnnual({ client: s.client, clock: () => AT });
  assert.deepEqual(r.requiredYears, [2021, 2022, 2023, 2024, 2025]);
  assert.deepEqual(r.candidates, ['Trader1']);
  assert.deepEqual(r.profiles.map(x => x.status), ['RESEARCH_CANDIDATE', 'NEGATIVE_FULL_YEAR', 'ANNUAL_HISTORY_INCOMPLETE',
    'ANNUAL_HISTORY_INVALID', 'NEGATIVE_FIRST_YEAR_COVERAGE_UNVERIFIED', 'ANNUAL_HISTORY_INVALID']);
  assert.equal(r.profiles[0].years.length, 6);
  assert.equal(r.profiles[0].years[0].gainPct, 0);
  assert.equal(r.profiles[0].years.at(-1).gainPct, 5);
  assert.ok(s.calls.filter(x => x.url.includes('/gain/')).every(x => /\/gain\/yearly\?minDate=2007-01-01&maxDate=2025-12-31$/.test(x.url)));
  assert.equal(s.calls.filter(x => x.url.includes('/assets/history')).length, 1);
  assert.equal(r.executionAllowed, false);
  assert.ok(s.calls.every(x => x.method === 'GET' && x.body === undefined));
});
test('the first reported year counts only with twelve reported months', async () => {
  const monthRows = Array.from({ length: 12 }, (_, i) => `2021-${String(i + 1).padStart(2, '0')}-01`);
  const five = positiveFullYears.slice(1);
  const s = annualSetup({ 1: five, 2: five, 3: five }, { months: { 1: monthRows, 2: monthRows.slice(1), 3: ['2020-12-01', ...monthRows.slice(1)] } });
  const r = await screenAnnual({ client: s.client, clock: () => AT });
  assert.deepEqual(r.candidates, ['Trader1']);
  assert.equal(r.profiles[0].firstCountedYear, 2021);
  assert.equal(r.profiles[1].status, 'ANNUAL_HISTORY_INCOMPLETE');
  assert.equal(r.profiles[2].status, 'ANNUAL_HISTORY_INCOMPLETE');
  assert.ok(s.calls.filter(x => x.url.includes('/gain/monthly')).every(x => /\?minDate=2021-01-01&maxDate=2021-12-31$/.test(x.url)));
});
test('gain-series response must echo the profile and request selectors cannot alter the endpoint', async () => {
  const s = annualSetup({ 1: positiveFullYears }, { mismatch: true });
  const r = await screenAnnual({ client: s.client, clock: () => AT });
  assert.equal(r.profiles[0].status, 'ANNUAL_HISTORY_UNAVAILABLE');
  assert.deepEqual(r.candidates, []);
  assert.equal((await s.client.read('yearlyGains', { username: 'Trader1', minDate: '2021-01-01' })).reason, 'READ_NOT_ALLOWLISTED');
  assert.equal((await s.client.read('monthlyGains', { username: 'Trader1', year: 2026 })).reason, 'READ_NOT_ALLOWLISTED');
  assert.equal(s.calls.length, 3);
});
test('annual success alone does not qualify a profile with denied allocations or conflicting identity', async () => {
  for (const setup of [{ allocStatus: 403 }, { identityChange: true }]) {
    const s = annualSetup({ 1: positiveFullYears }, setup);
    const r = await screenAnnual({ client: s.client, clock: () => AT });
    assert.deepEqual(r.candidates, []);
    assert.equal(r.profiles[0].status, setup.allocStatus ? 'ANNUAL_PASS_ALLOCATIONS_UNAVAILABLE' : 'IDENTITY_CONFIRMATION_FAILED');
    assert.doesNotMatch(JSON.stringify(r), /SECRET/);
  }
});
test('annual screen lists usable partial allocations separately after confirming identity', async () => {
  const s = annualSetup({ 1: positiveFullYears }, { partial: true });
  const r = await screenAnnual({ client: s.client, clock: () => AT });
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.partialCandidates, ['Trader1']);
  assert.equal(r.profiles[0].status, 'PARTIAL_ALLOCATION_RESEARCH_CANDIDATE');
  assert.equal(r.profiles[0].allocationCoverage.partialDays, 2);
  assert.equal(s.calls.length, 5);
});
test('annual screen stays inside the shared quota and can resume at the returned offset', async () => {
  const gains = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, positiveFullYears]));
  const first = annualSetup(gains);
  const a = await screenAnnual({ client: first.client, clock: () => AT });
  assert.deepEqual(a.next, { page: 1, offset: 4 });
  assert.equal(a.calls, 17);
  const second = annualSetup(gains);
  const b = await screenAnnual({ ...a.next, client: second.client, clock: () => AT });
  assert.equal(b.candidates[0], 'Trader5');
  assert.equal(b.calls, 17);
  const denied = setup({ handler: () => new Response('', { status: 429 }) });
  const c = await screenAnnual({ page: 1, offset: 8, client: denied.client, clock: () => AT });
  assert.equal(c.calls, 1);
  assert.deepEqual(c.next, { page: 1, offset: 8 });
});
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
