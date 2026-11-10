'use strict';
const { createTraderReadClient } = require('./etoro-trader-observer');
const { validId } = require('./trader-observer');
const { normalizePage, rankedProfile } = require('./etoro-trader-discovery');

const TRADERS = Object.freeze(['tintinmelo75', 'Cleonfe', 'HaoNing', 'WildNico', 'IsraMX']);
const SOURCE = 'https://api-portal.etoro.com/api-reference/user-stats/get-asset-allocation-history';
const STOP = new Set(['CREDENTIALS_ABSENT', 'READ_QUOTA_OR_COOLDOWN', 'CREDENTIAL_CONTEXT_CHANGED']);
const MINIMUM_YEARS = 5, MAX_REQUESTS = 20;

function closedDays(data, username, today) {
  if (typeof data?.userName !== 'string' || data.userName.toLowerCase() !== username.toLowerCase() ||
      !Array.isArray(data.results) || data.results.length > 31) return null;
  const days = new Map(), seen = new Set();
  for (const row of data.results) {
    const day = row?.date;
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= today) continue;
    const time = Date.parse(day);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) continue;
    if (seen.has(day)) { days.delete(day); continue; }
    seen.add(day);
    if (!Array.isArray(row.assets) || row.assets.length > 2000) continue;
    const ids = new Set(), allocated = new Set();
    for (const asset of row.assets) {
      if (!validId(asset?.instrumentId) || ids.has(asset.instrumentId) ||
          !Number.isFinite(asset.valuePct) || asset.valuePct < 0) break;
      ids.add(asset.instrumentId);
      if (asset.valuePct > 0) allocated.add(asset.instrumentId);
    }
    if (ids.size === row.assets.length && allocated.size) days.set(day, allocated);
  }
  return days;
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
    const days = read.httpStatus === 200 ? closedDays(read.data, username, today) : null;
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

function annualResult(data, currentYear) {
  if (!Array.isArray(data?.yearly) || data.yearly.length > 50) return { status: 'ANNUAL_HISTORY_UNAVAILABLE' };
  const gains = new Map();
  for (const row of data.yearly) {
    const year = new Date(typeof row?.timestamp === 'string' ? row.timestamp : NaN).getUTCFullYear();
    if (!Number.isInteger(year) || year > currentYear) return { status: 'ANNUAL_HISTORY_INVALID' };
    if (year === currentYear) continue;
    if (!Number.isFinite(row.gain) || (gains.has(year) && gains.get(year) !== row.gain)) return { status: 'ANNUAL_HISTORY_INVALID' };
    gains.set(year, row.gain);
  }
  const years = [...gains].sort(([a], [b]) => a - b).map(([year, gainPct]) => ({ year, gainPct }));
  const firstYear = years[0]?.year ?? currentYear;
  const monthly = new Set();
  for (const row of Array.isArray(data.monthly) ? data.monthly : []) {
    const at = new Date(typeof row?.timestamp === 'string' ? row.timestamp : NaN);
    const year = at.getUTCFullYear();
    if (year < firstYear) return { status: 'ANNUAL_HISTORY_INCOMPLETE', years };
    if (year === firstYear && Number.isFinite(row.gain)) monthly.add(at.getUTCMonth());
  }
  const firstYearCovered = monthly.size === 12;
  if (years.some(row => row.gainPct < 0 && (row.year > firstYear || firstYearCovered))) return { status: 'NEGATIVE_FULL_YEAR', years };
  if (years[0]?.gainPct < 0) return { status: 'NEGATIVE_FIRST_YEAR_COVERAGE_UNVERIFIED', years };
  const firstCountedYear = firstYearCovered ? firstYear : firstYear + 1;
  if (years.length !== currentYear - firstYear || currentYear - firstCountedYear < MINIMUM_YEARS) return { status: 'ANNUAL_HISTORY_INCOMPLETE', years };
  return { status: 'NO_NEGATIVE_REPORTED_FULL_YEAR', years, firstCountedYear };
}

async function screenAnnual({ page = 1, offset = 0, client = createTraderReadClient(), clock = Date.now } = {}) {
  if (!Number.isInteger(page) || page < 1 || page > 3 || !Number.isInteger(offset) || offset < 0 || offset >= 100) throw Error('INVALID_SCREEN_CURSOR');
  const collectedAt = new Date(clock()).toISOString(), today = collectedAt.slice(0, 10), currentYear = Number(today.slice(0, 4));
  const context = client.context();
  const report = { version: 'annual-trader-screen-v2', collectedAt, scope: 'READ_ONLY_RESEARCH', executionAllowed: false,
    transactionEvidence: false, universeComplete: false, page, offset, maxRequests: MAX_REQUESTS,
    historyBasis: 'REPORTED_PERFORMANCE_PERIODS_ONLY', lifetimeCoverage: 'UNVERIFIED',
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
  for (; i < rankings.rows.length && !report.stopReason && report.calls + 4 <= MAX_REQUESTS; i++) {
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
    const performance = await read('performance', query);
    result.performanceHttp = performance.httpStatus;
    Object.assign(result, annualResult(performance.data, currentYear));
    if (report.stopReason || result.status !== 'NO_NEGATIVE_REPORTED_FULL_YEAR') continue;
    const allocation = await read('allocationHistory', query);
    result.allocationHttp = allocation.httpStatus;
    const days = allocation.status === 'AVAILABLE' ? closedDays(allocation.data, row.username, today) : null;
    result.usableAllocationDays = days?.size ?? null;
    result.latestAllocationDay = days?.size ? [...days.keys()].sort().at(-1) : null;
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

module.exports = { research, screenAnnual };

if (require.main === module) {
  const [mode, page = '1', offset = '0', ...extra] = process.argv.slice(2);
  const run = mode === '--read-only' && process.argv.length === 3 ? research
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
