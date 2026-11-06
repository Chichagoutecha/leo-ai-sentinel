'use strict';
// Isolated research/diagnostic entry point. Never import index, start preloads,
// execution clients, storage credentials, or a scheduler here.
const { createTraderReadClient, createTraderObserver, RANKINGS } = require('./etoro-trader-observer');
const { emptyState, digest, validId, validUsername } = require('./trader-observer');
const VERSION = 'trader-discovery-v1';
const SOURCE = 'https://api-portal.etoro.com/api-reference/rankings/get-paginated-investor-rankings';
const PERIODS = Object.freeze(['AbsOneYear', 'AbsTwoYears']);
const FIELDS = Object.freeze(['annualizedReturn', 'gain', 'riskScore', 'maxMonthlyRiskScore', 'peakToValley',
  'trades', 'velocity', 'avgPosSize', 'highLeveragePct', 'mediumLeveragePct', 'lowLeveragePct', 'topTradedInstrumentPct', 'activeWeeks']);
const LIMITS = Object.freeze(['PROVIDER_REFRESH_DATE_NOT_RETURNED', 'COMMON_WINDOW_END_NOT_VERIFIED',
  'ACTIVITY_SPAN_IS_NOT_COMPLETE_HISTORY', 'VOLATILITY_AND_TRANSACTION_COSTS_NOT_ESTABLISHED',
  'INDEPENDENCE_REQUIRES_HOLDINGS_AND_RETURN_SERIES', 'PAGINATION_IS_NOT_A_POINT_IN_TIME_SNAPSHOT',
  'PUBLIC_PORTFOLIO_CHANGES_ARE_NOT_PROVEN_TRADES', 'SURVIVORSHIP_AND_SAMPLE_BIAS', 'NOT_A_TRADE_AUTHORIZATION']);
const numeric = n => typeof n === 'number' && Number.isFinite(n) ? n : null;
const date = s => typeof s === 'string' && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
function options(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['maxPages', 'pageSize', 'verifyCount'].includes(k))) throw Error('INVALID_DISCOVERY_OPTIONS');
  const o = { maxPages: 1, pageSize: 20, verifyCount: 1, ...input };
  for (const [key, max] of [['maxPages', 3], ['pageSize', 100], ['verifyCount', 5]]) if (!Number.isSafeInteger(o[key]) || o[key] < 1 || o[key] > max) throw Error('INVALID_DISCOVERY_OPTIONS');
  // The existing observer's shared local budget is twenty reads per minute.
  if (2 * o.maxPages + 3 * o.verifyCount > 20) throw Error('DISCOVERY_READ_BUDGET_EXCEEDED');
  return o;
}
function normalizeRow(raw, client) {
  if (!raw || !validId(raw.cid) || raw.type !== 'trader' || !validUsername(raw.username) || !client.safeUsername(raw.username)) return null;
  const metrics = Object.fromEntries(FIELDS.map(k => [k, numeric(raw[k])]));
  for (const k of ['riskScore', 'maxMonthlyRiskScore']) if (metrics[k] !== null && (metrics[k] < 1 || metrics[k] > 10)) metrics[k] = null;
  return { providerCid: raw.cid, username: raw.username, metrics, firstActivity: date(raw.firstActivity), lastActivity: date(raw.lastActivity),
    missingFields: FIELDS.filter(k => metrics[k] === null).concat(['providerRefreshAt', 'historyCompleteness', 'volatility', 'accountSpecificCosts', 'independence']),
    qualification: 'RESEARCH_ONLY', bestTraderRank: null, confidence: 'INSUFFICIENT_FOR_BEST_TRADER_RANKING' };
}
function normalizePage(read, selector, client) {
  const p = read.data?.pagination;
  const schema = read.status === 'AVAILABLE' && Array.isArray(read.data?.results) && read.data.results.length <= selector.pageSize &&
    p?.page === selector.page && p.pageSize === selector.pageSize && typeof p.hasNext === 'boolean' && Number.isSafeInteger(p.totalItems) && p.totalItems >= 0 &&
    p.totalItems >= (p.page - 1) * p.pageSize + read.data.results.length &&
    (p.hasNext ? read.data.results.length === p.pageSize && p.totalItems > p.page * p.pageSize : p.totalItems === (p.page - 1) * p.pageSize + read.data.results.length);
  const rows = schema ? read.data.results.map(r => normalizeRow(r, client)) : [];
  return { source: read.source, period: selector.period, page: selector.page, collectedAt: date(read.collectedAt), effectiveAt: null,
    httpStatus: read.httpStatus, status: schema ? rows.some(r => !r) ? 'PARTIAL' : 'AVAILABLE' : 'UNAVAILABLE',
    reason: schema ? rows.some(r => !r) ? 'INVALID_OR_NON_TRADER_ROWS' : null : read.reason || 'RANKINGS_SCHEMA_OR_PAGINATION_INVALID',
    pagination: schema ? { page: p.page, pageSize: p.pageSize, hasNext: p.hasNext, totalItems: p.totalItems } : null,
    invalidRows: rows.filter(r => !r).length, rows: rows.filter(Boolean) };
}
function combine(pages, now) {
  const records = new Map(), conflicts = new Set(), coverage = {};
  for (const period of PERIODS) {
    const group = pages.filter(p => p.period === period), seen = new Map(); let duplicateRows = 0;
    const totals = new Set(group.filter(p => p.pagination).map(p => p.pagination.totalItems));
    for (const page of group) for (const row of page.rows) {
      if (seen.has(row.providerCid)) { duplicateRows++; if (digest(seen.get(row.providerCid)) !== digest(row)) conflicts.add(row.providerCid); }
      else seen.set(row.providerCid, row);
      const entry = records.get(row.providerCid) || { providerCid: row.providerCid, username: row.username, periods: {}, identityStatus: 'UNVERIFIED' };
      if (entry.username !== row.username) conflicts.add(row.providerCid);
      entry.periods[period] = row; records.set(row.providerCid, entry);
    }
    const consecutive = group.every((p, i) => p.page === i + 1);
    const complete = group.length > 0 && group.every(p => p.status === 'AVAILABLE') && consecutive && !group.at(-1).pagination?.hasNext && totals.size === 1 && duplicateRows === 0;
    coverage[period] = { status: complete ? 'AVAILABLE' : group.some(p => p.rows.length) ? 'PARTIAL' : 'UNAVAILABLE',
      pagesFetched: group.filter(p => p.httpStatus !== null).length, retainedRows: seen.size, duplicateRows,
      reportedTotalItems: totals.size === 1 ? [...totals][0] : null, enumerationComplete: complete,
      temporalCompleteness: 'UNVERIFIED', reason: totals.size > 1 ? 'UNIVERSE_CHANGED_DURING_PAGINATION' : !complete ? 'BOUNDED_SAMPLE_OR_INCOMPLETE_PAGINATION' : 'NO_PROVIDER_SNAPSHOT_TIMESTAMP' };
  }
  const candidates = [...records.values()].map(row => {
    const completePeriods = PERIODS.every(p => row.periods[p]);
    return { ...row, status: conflicts.has(row.providerCid) ? 'AMBIGUOUS' : completePeriods ? 'RESEARCH_CANDIDATE' : 'PARTIAL',
      reason: conflicts.has(row.providerCid) ? 'CONTRADICTORY_PROVIDER_ROWS_OR_IDENTITY' : completePeriods ? 'MULTIPERIOD_REPORTED_METRICS_REQUIRE_QUALIFICATION' : 'NOT_PRESENT_IN_BOTH_BOUNDED_SAMPLES',
      bestTraderRank: null, selectedForTrading: false };
  }).sort((a, b) => a.providerCid - b.providerCid);
  return { version: VERSION, generatedAt: new Date(now).toISOString(), readOnly: true, executionAttempted: false, sourceDocumentation: SOURCE,
    periods: PERIODS, coverage, candidates, comparison: { status: 'UNAVAILABLE', ranking: null,
      reason: 'NO_VERIFIED_REFRESH_DATE_COMPLETE_HISTORIES_VOLATILITY_COSTS_OR_INDEPENDENCE' },
    selection: { status: 'NOT_SELECTED', count: 0, rule: 'DISCOVERY_NEVER_MODIFIES_OBSERVER_LIST_OR_TRADE_ALLOWLIST' }, limitations: LIMITS };
}
function createDiscovery({ env = process.env, client, clock = Date.now, configuration = {}, getState, onChange = () => {} } = {}) {
  const o = options(configuration); let active = false, collectedInProcess = false, local = { version: 1, lastAttemptAt: null, report: null, readQuota: { timestamps: [], blockedUntil: 0 } };
  const state = () => getState ? getState() : local;
  if (!client) client = createTraderReadClient({ env, clock, quotaStore: () => state().readQuota, onQuotaChange: onChange });
  let credentialGeneration = client.context().generation;
  function view() {
    const report = state().report;
    if (!report) return { version: VERSION, status: 'UNAVAILABLE', reason: 'NOT_COLLECTED', readOnly: true, providerCalls: 0 };
    const age = clock() - Date.parse(report.generatedAt);
    const changed = !collectedInProcess || credentialGeneration !== client.context().generation;
    const hasData = Object.values(report.coverage).some(c => c.status !== 'UNAVAILABLE');
    return { ...structuredClone(report), status: changed ? 'UNAVAILABLE' : age < 0 || age > 86400000 ? 'STALE' : hasData ? 'PARTIAL' : 'UNAVAILABLE',
      reason: changed ? 'CREDENTIAL_CONTEXT_CHANGED' : age < 0 || age > 86400000 ? 'COLLECTION_EXPIRED' : hasData ? 'RESEARCH_DATA_NOT_BEST_TRADER_QUALIFICATION' : report.checks?.[0]?.reason || 'NO_RANKINGS_DATA', providerCalls: 0 };
  }
  async function refresh() {
    if (active) return { status: 'UNAVAILABLE', reason: 'COLLECTION_IN_PROGRESS', readOnly: true, providerCalls: 0 };
    const ctx = client.context(), s = state();
    if (collectedInProcess && s.lastAttemptAt && ctx.generation === credentialGeneration && clock() - Date.parse(s.lastAttemptAt) < 21600000) return view();
    active = true; credentialGeneration = ctx.generation; s.lastAttemptAt = new Date(clock()).toISOString();
    const pages = [], checks = []; let providerCalls = 0, denied = false;
    try {
      onChange();
      for (const period of PERIODS) {
        if (denied) break;
        for (let page = 1; page <= o.maxPages; page++) {
          const selector = { period, page, pageSize: o.pageSize }, read = await client.read('rankings', selector);
          if (read.requestAttempted) providerCalls++;
          const normalized = normalizePage(read, selector, client); pages.push(normalized);
          checks.push({ capability: 'INVESTOR_RANKINGS', endpoint: RANKINGS, method: 'GET', period, page,
            checkedAt: read.collectedAt, httpStatus: read.httpStatus, expectedStructure: normalized.pagination ? 'PRESENT' : 'ABSENT',
            status: read.httpStatus === 401 ? 'UNAUTHORIZED' : read.httpStatus === 403 ? 'FORBIDDEN' : normalized.pagination ? 'VERIFIED_READ' : 'UNAVAILABLE', reason: normalized.reason });
          if ([401, 403, 429].includes(read.httpStatus) || ['CREDENTIALS_ABSENT', 'READ_QUOTA_OR_COOLDOWN', 'CREDENTIAL_CONTEXT_CHANGED'].includes(read.reason)) { denied = true; break; }
          if (normalized.status !== 'AVAILABLE' || !normalized.pagination.hasNext) break;
        }
      }
      const report = combine(pages, clock());
      // CID in a rankings row is not assumed to be a realCID/GCID. Verify the
      // possible mapping through the observer's official profile / holdings /
      // profile sequence before suggesting an observer configuration.
      if (!denied) for (const candidate of report.candidates.filter(c => c.status === 'RESEARCH_CANDIDATE').slice(0, o.verifyCount)) {
        const observerState = emptyState(), candidateEnv = { ...env, TRADER_OBSERVER_TRADERS_JSON: JSON.stringify([{ realCID: candidate.providerCid }]) };
        const observer = createTraderObserver({ env: candidateEnv, client, clock, getState: () => observerState });
        await observer.refreshForScan(candidate.providerCid);
        const trader = observer.view().traders[0], snapshot = trader?.snapshot;
        const reads = snapshot ? Object.values(snapshot.reads).filter(r => r.requestAttempted) : observerState.traders[candidate.providerCid]?.lastAttempt?.reads || [];
        providerCalls += reads.filter(r => r.requestAttempted).length;
        // Do not turn absence of public portfolio access into proven privacy.
        candidate.identityStatus = snapshot?.identity?.status === 'AVAILABLE' && snapshot.identity.username === candidate.username ? 'VERIFIED_READ' : 'UNVERIFIED';
        candidate.holdingsStatus = snapshot?.portfolio?.status || 'UNAVAILABLE';
        candidate.transactionHistory = 'UNAVAILABLE_AGGREGATE_STATS_AND_SNAPSHOTS_ARE_NOT_TRANSACTIONS';
        candidate.observerCandidate = candidate.identityStatus === 'VERIFIED_READ' && ['AVAILABLE', 'PARTIAL'].includes(candidate.holdingsStatus)
          ? { realCID: snapshot.identity.realCID, expectedGcid: snapshot.identity.gcid } : null;
        for (const r of reads) {
          const portfolioRead = r.source?.endsWith('/portfolio/live');
          const present = portfolioRead ? snapshot && ['AVAILABLE', 'PARTIAL'].includes(snapshot.portfolio?.status) : snapshot?.identity?.status === 'AVAILABLE';
          checks.push({ capability: portfolioRead ? 'PUBLIC_TRADER_PORTFOLIO' : 'PUBLIC_TRADER_IDENTITY',
          endpoint: r.source?.endsWith('/portfolio/live') ? 'https://public-api.etoro.com/api/v1/user-info/people/{username}/portfolio/live' : 'https://public-api.etoro.com/api/v1/user-info/people?cidList={cid}',
          method: 'GET', checkedAt: r.collectedAt, httpStatus: r.httpStatus, status: r.httpStatus === 401 ? 'UNAUTHORIZED' : r.httpStatus === 403 ? 'FORBIDDEN' : present && r.status === 'AVAILABLE' ? 'VERIFIED_READ' : 'UNAVAILABLE',
          expectedStructure: present ? 'PRESENT' : 'UNVERIFIED', reason: r.reason || (!present ? 'PUBLIC_IDENTITY_OR_PORTFOLIO_SCHEMA_UNVERIFIED' : null) });
        }
        if (reads.some(r => [401, 429].includes(r.httpStatus))) break;
      }
      if (client.context().generation !== ctx.generation) { s.report = null; onChange(); return { status: 'UNAVAILABLE', reason: 'CREDENTIAL_CONTEXT_CHANGED', providerCalls }; }
      report.checks = checks; report.providerCalls = providerCalls; report.maxRequests = 2 * o.maxPages + 3 * o.verifyCount;
      s.report = report; collectedInProcess = true; onChange(); return { ...view(), providerCalls };
    } catch {
      s.report = null; onChange(); return { status: 'UNAVAILABLE', reason: 'DISCOVERY_FAILED', readOnly: true, providerCalls };
    } finally { active = false; }
  }
  return { view, refresh };
}
// Minimal diagnostic is safe to share: no names, account IDs, holdings, balances,
// raw bodies, keys, headers, fingerprints, or error text from upstream.
function diagnostic(report) {
  return { version: VERSION, generatedAt: report.generatedAt || null, readOnly: true, executionAttempted: false,
    status: report.status, reason: report.reason, providerCalls: report.providerCalls || 0, maxRequests: report.maxRequests || 5,
    checks: report.checks || [], coverage: report.coverage || {}, candidateCount: report.candidates?.length || 0,
    verifiedPublicIdentities: report.candidates?.filter(c => c.identityStatus === 'VERIFIED_READ').length || 0,
    publicPortfoliosReadable: report.candidates?.filter(c => ['AVAILABLE', 'PARTIAL'].includes(c.holdingsStatus)).length || 0,
    comparison: report.comparison || { status: 'NOT_TESTED' }, selection: report.selection || { status: 'NOT_SELECTED', count: 0 },
    realAccountIdentity: 'NOT_TESTED', realOrderRights: 'NOT_TESTED', limitations: LIMITS };
}
module.exports = { VERSION, SOURCE, PERIODS, FIELDS, LIMITS, options, normalizePage, combine, createDiscovery, diagnostic };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--read-only-audit') {
    createDiscovery().refresh().then(report => console.log(JSON.stringify(diagnostic(report), null, 2))).catch(() => {
      console.log(JSON.stringify({ readOnly: true, status: 'UNAVAILABLE', reason: 'DIAGNOSTIC_FAILED' })); process.exitCode = 1;
    });
  } else if (!args.length) console.log(JSON.stringify({ version: VERSION, readOnly: true, status: 'NOT_TESTED', providerCalls: 0,
    command: 'node etoro-trader-discovery.js --read-only-audit', maxRequests: 5, endpoint: RANKINGS, method: 'GET' }, null, 2));
  else { console.log(JSON.stringify({ status: 'UNAVAILABLE', reason: 'UNSUPPORTED_ARGUMENTS', providerCalls: 0 })); process.exitCode = 1; }
}
