'use strict';
const { createTraderReadClient, FIRST_RESEARCH_YEAR } = require('./etoro-trader-observer');
const { validId } = require('./trader-observer');
const { normalizePage, rankedProfile } = require('./etoro-trader-discovery');

const TRADERS = Object.freeze(['tintinmelo75', 'Cleonfe', 'HaoNing', 'WildNico', 'IsraMX']);
const ALLOCATION_PROBE_TRADERS = Object.freeze(['thomaspj', 'triangulacapital', 'tintinmelo75']);
const SOURCE = 'https://api-portal.etoro.com/api-reference/user-stats/get-asset-allocation-history';
const STOP = new Set(['CREDENTIALS_ABSENT', 'READ_QUOTA_OR_COOLDOWN', 'CREDENTIAL_CONTEXT_CHANGED']);
const MINIMUM_YEARS = 5, MAX_REQUESTS = 20;

function inspectClosedDays(data, username, today) {
  const coverage = { reportedDays: Array.isArray(data?.results) ? data.results.length : null, daysWithAssets: 0,
    usableDays: null, latestUsableDay: null, rejectionReasons: {} };
  const reject = reason => { coverage.rejectionReasons[reason] = (coverage.rejectionReasons[reason] || 0) + 1; };
  if (typeof data?.userName !== 'string' || data.userName.toLowerCase() !== username.toLowerCase()) {
    reject('USERNAME_UNVERIFIED'); return { days: null, coverage };
  }
  if (!Array.isArray(data.results) || data.results.length > 31) {
    reject('ALLOCATION_ROWS_MISSING_OR_OVER_LIMIT'); return { days: null, coverage };
  }
  const days = new Map(), seen = new Set();
  for (const row of data.results) {
    const day = row?.date;
    if (Array.isArray(row?.assets) && row.assets.length) coverage.daysWithAssets++;
    const time = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day) : NaN;
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) { reject('INVALID_DATE'); continue; }
    if (day >= today) { reject('CURRENT_OR_FUTURE_DATE'); continue; }
    if (seen.has(day)) { reject('DUPLICATE_DATE'); days.delete(day); continue; }
    seen.add(day);
    if (!Array.isArray(row.assets) || row.assets.length > 2000) { reject('ASSET_ROWS_MISSING_OR_OVER_LIMIT'); continue; }
    if (!row.assets.length) { reject('EMPTY_ASSETS'); continue; }
    const ids = new Set(), allocated = new Set();
    const issues = new Set();
    for (const asset of row.assets) {
      const id = asset?.instrumentId, weight = asset?.valuePct;
      if (!validId(id)) issues.add('INVALID_INSTRUMENT_ID');
      else if (ids.has(id)) issues.add('DUPLICATE_INSTRUMENT_ID');
      else ids.add(id);
      if (!Number.isFinite(weight)) issues.add('MISSING_OR_INVALID_VALUE_PCT');
      else if (weight < 0) issues.add('NEGATIVE_VALUE_PCT');
      else if (weight > 0 && validId(id)) allocated.add(id);
    }
    if (issues.size) for (const issue of issues) reject(issue);
    else if (!allocated.size) reject('NO_POSITIVE_VALUE_PCT');
    else days.set(day, allocated);
  }
  coverage.usableDays = days.size;
  coverage.latestUsableDay = [...days.keys()].sort().at(-1) ?? null;
  return { days, coverage };
}

async function research({ client = createTraderReadClient(), clock = Date.now } = {}) {
  const collectedAt = new Date(clock()).toISOString(), today = collectedAt.slice(0, 10);
  const context = client.context();
  const report = { source: SOURCE, collectedAt, scope: 'ALLOCATION_RESEARCH_ONLY',
    executionAllowed: false, transactionEvidence: false, coverageComplete: null,
    stableIdentitiesVerified: false, independenceVerified: false,
    calls: 0, profiles: [], comparison: null };
  const byDay = new Map();
  for (const username of TRADERS) {
    const read = await client.read('allocationHistory', { username });
    if (read.requestAttempted) report.calls++;
    const days = read.httpStatus === 200 ? inspectClosedDays(read.data, username, today).days : null;
    report.profiles.push({ username, httpStatus: read.httpStatus ?? null, usableDays: days?.size ?? null,
      reason: read.reason || (days === null ? 'ALLOCATION_RESPONSE_UNVERIFIED' : days.size === 0 ? 'NO_USABLE_CLOSED_DAY' : null) });
    for (const [day, assets] of days || []) {
      if (!byDay.has(day)) byDay.set(day, new Map());
      byDay.get(day).set(username, assets);
    }
    if ([401, 429].includes(read.httpStatus) || STOP.has(read.reason)) break;
  }
  if (client.context().generation !== context.generation) return { ...report, profiles: [], status: 'CREDENTIAL_CONTEXT_CHANGED' };
  const day = [...byDay.keys()].sort().reverse().find(date => byDay.get(date).size >= 2);
  if (!day) return { ...report, status: 'NO_COMPARABLE_CLOSED_DAY' };
  const portfolios = byDay.get(day), overlap = new Map();
  for (const [username, ids] of portfolios) for (const id of ids) {
    if (!overlap.has(id)) overlap.set(id, []);
    overlap.get(id).push(username);
  }
  report.comparison = { day, profiles: [...portfolios.keys()],
    sharedInstruments: [...overlap].filter(([, users]) => users.length >= 2)
      .sort(([a, aa], [b, bb]) => bb.length - aa.length || a - b)
      .map(([instrumentId, profiles]) => ({ instrumentId, profiles })) };
  return { ...report, status: 'OBSERVED_OVERLAP_ONLY' };
}

async function allocationProbe({ client = createTraderReadClient(), clock = Date.now } = {}) {
  const collectedAt = new Date(clock()).toISOString(), today = collectedAt.slice(0, 10);
  const context = client.context();
  const report = { collectedAt, source: SOURCE, executionAllowed: false, calls: 0, profiles: [] };
  for (const username of ALLOCATION_PROBE_TRADERS) {
    const read = await client.read('allocationHistory', { username });
    if (read.requestAttempted) report.calls++;
    const coverage = read.status === 'AVAILABLE' ? inspectClosedDays(read.data, username, today).coverage : null;
    report.profiles.push({ username, httpStatus: read.httpStatus ?? null, reason: read.reason ?? null, coverage });
    if ([401, 429].includes(read.httpStatus) || STOP.has(read.reason)) break;
  }
  if (client.context().generation !== context.generation) return { ...report, profiles: [], status: 'CREDENTIAL_CONTEXT_CHANGED' };
  return report;
}

function gainRows(data, username, granularity) {
  return typeof data?.username === 'string' && data.username.toLowerCase() === username.toLowerCase() &&
    data.granularity === granularity && Array.isArray(data.gains) ? data.gains : null;
}

function annualResult(data, username, currentYear) {
  const rows = gainRows(data, username, 'yearly');
  if (!rows || rows.length > 50) return { status: 'ANNUAL_HISTORY_UNAVAILABLE' };
  const gains = new Map();
  for (const row of rows) {
    const year = /^\d{4}-01-01$/.test(row?.date) ? Number(row.date.slice(0, 4)) : NaN;
    const gainPct = typeof row?.gain === 'number' ? row.gain * 100 : NaN;
    if (!Number.isInteger(year) || year < FIRST_RESEARCH_YEAR || year >= currentYear || !Number.isFinite(gainPct) ||
        (gains.has(year) && gains.get(year) !== gainPct)) return { status: 'ANNUAL_HISTORY_INVALID' };
    gains.set(year, gainPct);
  }
  const years = [...gains].sort(([a], [b]) => a - b).map(([year, gainPct]) => ({ year, gainPct }));
  const firstYear = years[0]?.year ?? currentYear;
  if (years.some(row => row.gainPct < 0 && row.year > firstYear)) return { status: 'NEGATIVE_FULL_YEAR', years };
  if (years[0]?.gainPct < 0) return { status: 'NEGATIVE_FIRST_YEAR_COVERAGE_UNVERIFIED', years };
  if (years.length !== currentYear - firstYear || years.length < MINIMUM_YEARS) return { status: 'ANNUAL_HISTORY_INCOMPLETE', years };
  if (years.length === MINIMUM_YEARS) return { status: 'FIRST_YEAR_MONTHS_REQUIRED', years };
  return { status: 'NO_NEGATIVE_REPORTED_FULL_YEAR', years, firstCountedYear: firstYear + 1 };
}

function fullMonthlyCoverage(data, username, year) {
  const rows = gainRows(data, username, 'monthly');
  if (rows?.length !== 12) return false;
  const dates = new Set(rows.filter(row => Number.isFinite(row?.gain)).map(row => row.date));
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}-01`).every(date => dates.has(date));
}

async function screenAnnual({ page = 1, offset = 0, client = createTraderReadClient(), clock = Date.now } = {}) {
  if (!Number.isInteger(page) || page < 1 || page > 3 || !Number.isInteger(offset) || offset < 0 || offset >= 100) throw Error('INVALID_SCREEN_CURSOR');
  const collectedAt = new Date(clock()).toISOString(), today = collectedAt.slice(0, 10), currentYear = Number(today.slice(0, 4));
  const context = client.context();
  const report = { version: 'annual-trader-screen-v3', collectedAt, scope: 'READ_ONLY_RESEARCH', executionAllowed: false,
    transactionEvidence: false, universeComplete: false, page, offset, maxRequests: MAX_REQUESTS,
    historyBasis: 'REPORTED_PERFORMANCE_PERIODS_ONLY', lifetimeCoverage: 'UNVERIFIED',
    performanceSource: 'https://api-portal.etoro.com/api-reference/user-stats/get-investor-gain-time-series',
    requestedAnnualRange: { from: `${FIRST_RESEARCH_YEAR}-01-01`, to: `${currentYear - 1}-12-31` },
    requiredYears: Array.from({ length: MINIMUM_YEARS }, (_, i) => currentYear - MINIMUM_YEARS + i),
    calls: 0, stopReason: null, next: null, profiles: [], candidates: [] };
  const read = async (kind, selector) => {
    const response = await client.read(kind, selector);
    if (response.requestAttempted) report.calls++;
    if ([401, 429].includes(response.httpStatus) || STOP.has(response.reason)) report.stopReason = response.reason;
    return response;
  };
  const selector = { period: 'AbsTwoYears', page, pageSize: 100, popularInvestor: true };
  const rankings = normalizePage(await read('rankings', selector), selector, client);
  report.rankings = { httpStatus: rankings.httpStatus ?? null, status: rankings.status, reason: rankings.reason,
    returnedProfiles: rankings.rows.length, reportedTotalItems: rankings.pagination?.totalItems ?? null };
  const seen = new Set();
  let i = offset;
  for (; i < rankings.rows.length && !report.stopReason && report.calls + 5 <= MAX_REQUESTS; i++) {
    // A period-scoped ranking row cannot establish the start of lifetime trading activity.
    const row = rankings.rows[i];
    const result = { username: row.username, status: 'POPULAR_INVESTOR_IDENTITY_UNVERIFIED' };
    report.profiles.push(result);
    const query = { username: row.username };
    const profileRead = await read('profileByUsername', query);
    const candidate = { ...query, providerCid: row.providerCid };
    const profile = rankedProfile(profileRead, candidate, client);
    result.profileHttp = profileRead.httpStatus;
    if (report.stopReason || profile.identity?.isPi !== true) continue;
    const { realCID, gcid } = profile.identity;
    if (seen.has(gcid)) { result.status = 'DUPLICATE_PROFILE'; continue; }
    seen.add(gcid);
    const performance = await read('yearlyGains', query);
    result.performanceHttp = performance.httpStatus;
    Object.assign(result, annualResult(performance.data, row.username, currentYear));
    if (!report.stopReason && result.status === 'FIRST_YEAR_MONTHS_REQUIRED') {
      const year = result.years[0].year;
      const monthly = await read('monthlyGains', { ...query, year });
      result.monthlyHttp = monthly.httpStatus;
      const covered = fullMonthlyCoverage(monthly.data, row.username, year);
      result.status = covered ? 'NO_NEGATIVE_REPORTED_FULL_YEAR' : 'ANNUAL_HISTORY_INCOMPLETE';
      if (covered) result.firstCountedYear = year;
    }
    if (report.stopReason || result.status !== 'NO_NEGATIVE_REPORTED_FULL_YEAR') continue;
    const allocation = await read('allocationHistory', query);
    result.allocationHttp = allocation.httpStatus;
    const { days, coverage } = allocation.status === 'AVAILABLE' ? inspectClosedDays(allocation.data, row.username, today) : {};
    result.usableAllocationDays = coverage?.usableDays ?? null;
    result.latestAllocationDay = coverage?.latestUsableDay ?? null;
    result.allocationCoverage = coverage ?? null;
    if (report.stopReason || !days || days.size < 2) { result.status = 'ANNUAL_PASS_ALLOCATIONS_UNAVAILABLE'; continue; }
    const confirmationRead = await read('profileByUsername', query);
    const confirmation = rankedProfile(confirmationRead, candidate, client).identity;
    if (confirmation?.realCID !== realCID || confirmation?.gcid !== gcid || confirmation?.isPi !== true) {
      result.status = 'IDENTITY_CONFIRMATION_FAILED'; continue;
    }
    result.status = 'RESEARCH_CANDIDATE';
    report.candidates.push(row.username);
  }
  if (client.context().generation !== context.generation) return { ...report, profiles: [], candidates: [], next: null, status: 'CREDENTIAL_CONTEXT_CHANGED' };
  if (report.stopReason) report.next = { page, offset: Math.max(offset, i - 1) };
  else if (i < rankings.rows.length) report.next = { page, offset: i };
  else if (rankings.pagination?.hasNext && page < 3) report.next = { page: page + 1, offset: 0 };
  return { ...report, status: report.stopReason ? 'READS_STOPPED' : !rankings.pagination ? 'RANKINGS_UNAVAILABLE' : 'BOUNDED_SCREEN_COMPLETE' };
}

module.exports = { research, allocationProbe, screenAnnual };

if (require.main === module) {
  const [mode, page = '1', offset = '0', ...extra] = process.argv.slice(2);
  const run = mode === '--read-only' && process.argv.length === 3 ? research
    : mode === '--inspect-allocations' && process.argv.length === 3 ? allocationProbe
    : mode === '--screen-annual' && !extra.length && /^[1-3]$/.test(page) && /^\d{1,2}$/.test(offset)
      ? () => screenAnnual({ page: Number(page), offset: Number(offset) }) : null;
  if (!run) {
    console.log(JSON.stringify({ status: 'NOT_TESTED', calls: 0, executionAllowed: false }));
  } else {
    run().then(report => console.log(JSON.stringify(report, null, 2))).catch(() => {
      console.log(JSON.stringify({ status: 'RESEARCH_FAILED', executionAllowed: false }));
      process.exitCode = 1;
    });
  }
}
