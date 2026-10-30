'use strict';
const { createHash } = require('node:crypto');
const STATUSES = Object.freeze(['AVAILABLE', 'PARTIAL', 'STALE', 'PRIVATE', 'UNAVAILABLE']);
const validId = n => Number.isSafeInteger(n) && n > 0;
const validUsername = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const numeric = n => typeof n === 'number' && Number.isFinite(n) ? n : null;
const date = s => typeof s === 'string' && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex'); // Public observation data only, never keys.
function parseTraders(input) {
  const rows = typeof input === 'string' ? JSON.parse(input) : input;
  if (!Array.isArray(rows) || rows.length > 5) throw Error('INVALID_TRADER_LIST');
  const seen = new Set();
  return rows.map(row => {
    if (!row || Object.keys(row).some(k => !['realCID', 'expectedGcid'].includes(k)) || !validId(row.realCID) || (row.expectedGcid !== undefined && !validId(row.expectedGcid)) || seen.has(row.realCID)) throw Error('INVALID_TRADER_LIST');
    seen.add(row.realCID);
    return { realCID: row.realCID, expectedGcid: row.expectedGcid ?? null };
  }).sort((a, b) => a.realCID - b.realCID);
}
function resolveIdentity(data, trader, previous = null) {
  const users = Array.isArray(data?.users) ? data.users : [];
  const matches = users.filter(row => row?.realCID === trader.realCID);
  if (matches.length !== 1) return { status: 'UNAVAILABLE', reason: matches.length > 1 ? 'AMBIGUOUS_IDENTITY' : 'IDENTITY_NOT_RESOLVED' };
  const row = matches[0];
  if (!validId(row.gcid) || !validUsername(row.username) || (trader.expectedGcid && trader.expectedGcid !== row.gcid) || (previous?.gcid && previous.gcid !== row.gcid)) return { status: 'UNAVAILABLE', reason: 'IDENTITY_CONFLICT' };
  return { status: 'AVAILABLE', reason: null, realCID: trader.realCID, gcid: row.gcid, username: row.username, isPi: typeof row.isPi === 'boolean' ? row.isPi : null };
}
function normalizePortfolio(data) {
  const missingFields = ['units', 'portfolioEffectiveAt', 'documentedCompletenessMarker'];
  const positions = [], seen = new Map(); let invalid = 0, truncated = false;
  function add(raw, container) {
    if (!raw || !validId(raw.positionId) || !validId(raw.instrumentId)) { invalid++; return; }
    const row = { key: `${container}:${raw.positionId}`, container, positionId: raw.positionId, instrumentId: raw.instrumentId,
      isBuy: typeof raw.isBuy === 'boolean' ? raw.isBuy : null, reportedOpenAt: date(raw.openTimestamp),
      openRate: numeric(raw.openRate), leverage: numeric(raw.leverage), investmentPct: numeric(raw.investmentPct), units: null };
    if (seen.has(row.key)) { if (canonical(seen.get(row.key)) !== canonical(row)) { invalid++; const index = positions.findIndex(p => p.key === row.key); if (index >= 0) positions.splice(index, 1); } return; }
    seen.set(row.key, row);
    if (positions.length >= 100) { truncated = true; return; }
    positions.push(row);
  }
  if (!Array.isArray(data?.positions)) return { status: 'UNAVAILABLE', reason: 'PORTFOLIO_SCHEMA_UNAVAILABLE', positions: [], missingFields, complete: false };
  for (const row of data.positions.slice(0, 501)) add(row, 'DIRECT');
  if (data.positions.length > 500) truncated = true;
  if (Array.isArray(data.socialTrades)) {
    for (const social of data.socialTrades.slice(0, 101)) {
      if (!validId(social?.socialTradeId) || !Array.isArray(social.positions)) { invalid++; continue; }
      for (const row of social.positions.slice(0, 501)) add(row, `COPY:${social.socialTradeId}`);
      if (social.positions.length > 500) truncated = true;
    }
    if (data.socialTrades.length > 100) truncated = true;
  } else missingFields.push('socialTrades');
  positions.sort((a, b) => a.key.localeCompare(b.key));
  return { status: 'PARTIAL', reason: invalid ? 'INVALID_OR_CONFLICTING_POSITION_ROWS' : truncated ? 'LOCAL_POSITION_LIMIT' : 'COMPLETENESS_NOT_DOCUMENTED',
    positions, complete: false, truncated, invalidRows: invalid, effectiveAt: null, missingFields,
    pagination: { mode: 'NOT_DOCUMENTED', pagesFetched: 1, complete: null } };
}
function normalizePerformance(data) {
  const periods = {}; let invalid = 0, missing = false;
  for (const [key, limit] of [['monthly', 120], ['yearly', 20]]) {
    if (!Array.isArray(data?.[key])) { missing = true; periods[key] = null; continue; }
    const seen = new Map();
    for (const row of data[key].slice(0, 501)) {
      const time = date(row?.timestamp), gain = numeric(row?.gain);
      if (!time || gain === null) { invalid++; continue; }
      if (seen.has(time) && seen.get(time) !== gain) { invalid++; seen.set(time, null); continue; }
      seen.set(time, gain);
    }
    periods[key] = [...seen].filter(([, gain]) => gain !== null).sort(([a], [b]) => a.localeCompare(b)).slice(-limit).map(([timestamp, gain]) => ({ timestamp, gain }));
    if (data[key].length > limit) missing = true;
  }
  const timestamps = Object.values(periods).flatMap(rows => rows || []).map(row => row.timestamp).sort();
  return { status: !timestamps.length ? 'UNAVAILABLE' : invalid || missing ? 'PARTIAL' : 'AVAILABLE', reason: invalid ? 'INVALID_OR_CONFLICTING_PERFORMANCE_ROWS' : missing ? 'PERFORMANCE_WINDOW_PARTIAL' : null,
    ...periods, effectiveAt: timestamps.at(-1) || null, effectiveAtBasis: 'LATEST_REPORTED_PERIOD_NOT_PROVIDER_UPDATE_TIME', historyComplete: null, missingFields: ['fullHistoryCompleteness'],
    pagination: { mode: 'NOT_DOCUMENTED', pagesFetched: 1, complete: null } };
}
function normalizeTradeStats(data, username) {
  if (typeof data?.userName !== 'string' || data.userName.toLowerCase() !== username.toLowerCase()) return { status: 'UNAVAILABLE', reason: 'TRADE_STATS_IDENTITY_UNVERIFIED' };
  const fields = ['gain', 'dailyGain', 'riskScore', 'trades', 'winRatio', 'dailyDd', 'weeklyDd', 'peakToValley', 'avgPosSize', 'highLeveragePct', 'mediumLeveragePct', 'lowLeveragePct', 'copiers'];
  const metrics = Object.fromEntries(fields.map(key => [key, numeric(data[key])]));
  return { status: Object.values(metrics).some(v => v !== null) ? 'PARTIAL' : 'UNAVAILABLE', reason: 'AGGREGATE_STATISTICS_NOT_TRANSACTION_HISTORY',
    metrics, period: 'LastTwoYears', effectiveAt: null, missingFields: fields.filter(k => metrics[k] === null).concat(['effectiveAt', 'individualTransactions']),
    transactionHistoryStatus: 'UNAVAILABLE', pagination: { mode: 'NOT_DOCUMENTED', pagesFetched: 1, complete: null } };
}
function compareSnapshots(before, after) {
  if (!before?.portfolio || !after?.portfolio || before.realCID !== after.realCID || before.identity.gcid !== after.identity.gcid) return [];
  const events = [], old = new Map(before.portfolio.positions.map(p => [p.key, p])), current = new Map(after.portfolio.positions.map(p => [p.key, p]));
  const append = (type, key, previous, next, proof) => events.push({ type, key, previous, next, proof });
  for (const [key, row] of current) {
    const prior = old.get(key);
    if (!prior) append('POSITION_APPEARED', key, null, row, 'SNAPSHOT_PRESENCE_NOT_BUY_EXECUTION');
    else if (row.instrumentId !== prior.instrumentId || row.isBuy !== prior.isBuy) append('INDETERMINATE', key, prior, row, 'POSITION_IDENTITY_OR_DIRECTION_CONFLICT');
    else {
      if (typeof prior.units === 'number' && typeof row.units === 'number' && prior.units !== row.units) append('UNITS_CHANGED', key, prior.units, row.units, 'OBSERVED_UNITS_CHANGE_NOT_TRANSACTION');
      if (prior.investmentPct !== null && row.investmentPct !== null && prior.investmentPct !== row.investmentPct) append('WEIGHT_CHANGED', key, prior.investmentPct, row.investmentPct, 'MAY_REFLECT_MARKET_PRICE_MOVEMENT');
      if (prior.reportedOpenAt !== row.reportedOpenAt || prior.openRate !== row.openRate) append('INDETERMINATE', key, prior, row, 'REPORTED_POSITION_DETAILS_CHANGED');
    }
  }
  for (const [key, row] of old) if (!current.has(key)) append(before.portfolio.complete === true && after.portfolio.complete === true ? 'POSITION_DISAPPEARED' : 'INDETERMINATE', key, row, null, 'ABSENCE_NOT_SELL_EXECUTION_OR_PARTIAL_COVERAGE');
  return events.sort((a, b) => (a.key + a.type).localeCompare(b.key + b.type));
}
function emptyState() { return { version: 1, traders: {}, events: [], observations: [], historyTruncated: false }; }
function ingest(state, snapshot) {
  const content = { identity: snapshot.identity, portfolio: snapshot.portfolio, performance: snapshot.performance, tradeStats: snapshot.tradeStats, sources: snapshot.sources };
  const observationId = digest({ realCID: snapshot.realCID, collectedAt: snapshot.collectedAt, content });
  if (state.observations.some(o => o.id === observationId)) return false;
  const previousObservation = state.observations.find(o => o.realCID === snapshot.realCID && o.collectedAt === snapshot.collectedAt);
  const prior = state.traders[snapshot.realCID];
  const before = prior?.baselineTruncated ? null : prior?.comparisonBaseline || (['AVAILABLE', 'PARTIAL'].includes(prior?.snapshot?.portfolio?.status) ? prior.snapshot : null);
  const late = before && Date.parse(snapshot.collectedAt) < Date.parse(before.collectedAt);
  const correction = Boolean(previousObservation);
  const emit = event => {
    const row = { ...event, traderId: snapshot.realCID, gcid: snapshot.identity.gcid, observedAt: snapshot.collectedAt,
      effectiveAt: null, observationId, beforeObservationId: state.traders[snapshot.realCID]?.comparisonBaselineObservationId || state.traders[snapshot.realCID]?.observationId || null,
      source: snapshot.sources.portfolio, transactionProven: false, corrected: correction, late: Boolean(late) };
    row.id = digest(row);
    if (!state.events.some(e => e.id === row.id)) state.events.push(row);
  };
  if (late) emit({ type: 'LATE_OBSERVATION', key: 'observation', proof: 'NOT_APPLIED_TO_CURRENT_BASELINE' });
  else {
    if (correction) emit({ type: 'OBSERVATION_CORRECTED', key: 'observation', supersedes: previousObservation.id, proof: 'CORRECTED_DATA_NOT_NEW_TRADE' });
    if (before && ['AVAILABLE', 'PARTIAL'].includes(snapshot.portfolio.status) && canonical(before.portfolio) !== canonical(snapshot.portfolio)) for (const event of compareSnapshots(before, snapshot)) emit(event);
    const previousEntry = state.traders[snapshot.realCID] || {};
    const entry = { ...previousEntry, snapshot, observationId, identityPin: { realCID: snapshot.realCID, gcid: snapshot.identity.gcid } };
    if (['AVAILABLE', 'PARTIAL'].includes(snapshot.portfolio.status)) {
      delete entry.comparisonBaseline; delete entry.comparisonBaselineObservationId; entry.baselineTruncated = false;
    } else if (before) {
      entry.comparisonBaseline = { realCID: before.realCID, identity: before.identity, portfolio: before.portfolio, collectedAt: before.collectedAt };
      entry.comparisonBaselineObservationId = previousEntry.comparisonBaselineObservationId || previousEntry.observationId;
    }
    state.traders[snapshot.realCID] = entry;
  }
  state.observations.push({ id: observationId, realCID: snapshot.realCID, collectedAt: snapshot.collectedAt, late: Boolean(late), corrects: previousObservation?.id || null });
  if (state.events.length > 100 || state.observations.length > 100) state.historyTruncated = true;
  state.events = state.events.slice(-100); state.observations = state.observations.slice(-100);
  return true;
}
function compactObserverState(state, maxBytes = 48000) {
  const copy = structuredClone(state || emptyState());
  const entries = Object.entries(copy.traders || {}).sort(([, a], [, b]) => String(b.lastAttempt?.at || '').localeCompare(String(a.lastAttempt?.at || '')));
  if (entries.length > 5) { copy.traders = Object.fromEntries(entries.slice(0, 5)); copy.historyTruncated = true; }
  const bytes = () => Buffer.byteLength(JSON.stringify(copy));
  while (bytes() > maxBytes && copy.events?.length > 20) { copy.events.shift(); copy.historyTruncated = true; }
  while (bytes() > maxBytes && copy.observations?.length > 10) { copy.observations.shift(); copy.historyTruncated = true; }
  for (const [, item] of [...Object.entries(copy.traders || {})].reverse()) {
    if (bytes() <= maxBytes) break;
    if (item.snapshot) {
      item.snapshot.portfolio = { status: 'PARTIAL', reason: 'PERSISTENCE_BUDGET_TRUNCATED', positions: [], complete: false, effectiveAt: null };
      item.snapshot.performance = { status: 'UNAVAILABLE', reason: 'PERSISTENCE_BUDGET_TRUNCATED' };
      delete item.comparisonBaseline; delete item.comparisonBaselineObservationId;
      item.baselineTruncated = true; copy.historyTruncated = true;
    }
  }
  while (bytes() > maxBytes && copy.events?.length) { copy.events.shift(); copy.historyTruncated = true; }
  while (bytes() > maxBytes && copy.observations?.length) { copy.observations.shift(); copy.historyTruncated = true; }
  if (bytes() > maxBytes) {
    copy.traders = Object.fromEntries(Object.entries(copy.traders || {}).map(([key, item]) => [key, { identityPin: item.identityPin || null, lastAttempt: item.lastAttempt ? { at: item.lastAttempt.at, status: item.lastAttempt.status, reason: item.lastAttempt.reason } : null, baselineTruncated: true }]));
    copy.historyTruncated = true;
  }
  return copy;
}
module.exports = { STATUSES, validId, validUsername, date, digest, parseTraders, resolveIdentity, normalizePortfolio, normalizePerformance, normalizeTradeStats, compareSnapshots, emptyState, ingest, compactObserverState };
