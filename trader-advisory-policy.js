'use strict';
// Deterministic, cache-only research policy. No broker, scheduler or provider imports.
const { digest } = require('./trader-observer');
const { previewProposal } = require('./trader-exposure-link');
const VERSION = 'trader-context-v1';
const DAY = 86400000;
const DEFAULTS = Object.freeze({ version: VERSION, minHistoryMonths: 12, observationMaxAgeMs: 1800000,
  decisionMaxAgeMs: 1800000, quoteMaxAgeMs: 300000, qualifyingObservations: 3, probationDays: 7,
  suspensionExitDays: 30, reentryDays: 14, maxDecisionPriceDriftPct: 2, maxCostPct: 1,
  maxOrderUsd: 10, maxInstrumentWeightPct: 15, minCashReservePct: 20, reductionFraction: 0.25, maxHistory: 120 });
function config(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).some(k => !(k in DEFAULTS))) throw Error('INVALID_ADVISORY_CONFIG');
  const p = { ...DEFAULTS, ...overrides };
  if (p.version !== VERSION) throw Error('UNSUPPORTED_ADVISORY_VERSION');
  for (const k of Object.keys(p).filter(k => k !== 'version')) if (!Number.isFinite(p[k]) || p[k] <= 0) throw Error('INVALID_ADVISORY_CONFIG');
  for (const k of ['minHistoryMonths', 'qualifyingObservations', 'maxHistory']) if (!Number.isSafeInteger(p[k])) throw Error('INVALID_ADVISORY_CONFIG');
  if (p.reductionFraction > 1 || p.maxHistory > 120 || p.qualifyingObservations > 100 || p.minHistoryMonths > 120 || p.maxCostPct > 100 || p.maxDecisionPriceDriftPct > 100 || p.maxInstrumentWeightPct > 100 || p.minCashReservePct > 100) throw Error('INVALID_ADVISORY_CONFIG');
  return p;
}
const num = n => typeof n === 'number' && Number.isFinite(n) ? n : null;
const id = n => Number.isSafeInteger(n) && n > 0;
const ts = s => typeof s === 'string' && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null;
const fresh = (s, now, max) => ts(s) !== null && now >= ts(s) && now - ts(s) <= max;
const hash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function initialState() { return { version: 1, roster: {}, history: [], historyTruncated: false, lastAt: null }; }
function compactState(state, maxBytes = 48000) {
  const copy = structuredClone(state || initialState());
  while (Buffer.byteLength(JSON.stringify(copy)) > maxBytes && copy.history.length) { copy.history.shift(); copy.historyTruncated = true; }
  if (Buffer.byteLength(JSON.stringify(copy)) > maxBytes) return { ...initialState(), lastAt: copy.lastAt,
    historyTruncated: true, disabledReason: 'PERSISTENCE_BUDGET_REQUIRES_ARCHIVE; NO_AUTOMATIC_RESELECTION' };
  return copy;
}
function assess(trader, policy, now) {
  const s = trader?.snapshot, positions = s?.portfolio?.positions || [];
  const usable = id(trader?.realCID) && s?.identity?.realCID === trader.realCID && id(s?.identity?.gcid) && hash(trader.observationId) &&
    ['AVAILABLE', 'PARTIAL'].includes(trader.status) && !trader.historicalSnapshot &&
    ['AVAILABLE', 'PARTIAL'].includes(s?.portfolio?.status) && Array.isArray(s?.portfolio?.positions) && positions.some(p => id(p.instrumentId)) &&
    fresh(s?.collectedAt, now, policy.observationMaxAgeMs);
  const months = [...new Set((s?.performance?.monthly || []).filter(r => ts(r?.timestamp) !== null && num(r.gain) !== null).map(r => r.timestamp.slice(0, 7)))].sort();
  let contiguous = true;
  for (let i = 1; i < months.length; i++) if (new Date(months[i] + '-01T00:00:00Z').getTime() !== Date.UTC(Number(months[i - 1].slice(0, 4)), Number(months[i - 1].slice(5, 7)), 1)) contiguous = false;
  const weights = positions.map(p => num(p.investmentPct)), leverages = positions.map(p => num(p.leverage));
  const metrics = {
    history: { status: months.length ? 'PARTIAL' : 'UNAVAILABLE', observedMonths: months.length, firstMonth: months[0] || null, lastMonth: months.at(-1) || null,
      contiguous, minimumMonths: policy.minHistoryMonths, sufficientDepth: months.length >= policy.minHistoryMonths && contiguous,
      complete: s?.performance?.historyComplete === true, reason: 'PERIOD_DEFINITIONS_RETURN_UNITS_AND_FULL_HISTORY_NOT_VERIFIED' },
    comparableReturn: { status: 'UNAVAILABLE', value: null, reason: 'NO_VERIFIED_COMMON_WINDOW_RETURN_CONVENTION_OR_CASH_FLOW_BASIS' },
    drawdown: { status: 'UNAVAILABLE', value: null, reason: 'AGGREGATE_DRAWDOWN_HAS_NO_VERIFIED_COMPARABLE_WINDOW' },
    volatility: { status: 'UNAVAILABLE', value: null, reason: 'NO_VERIFIED_COMPARABLE_RETURN_SERIES' },
    concentration: { status: weights.some(v => v !== null) ? 'PARTIAL' : 'UNAVAILABLE', maxReportedPositionPct: weights.some(v => v !== null) ? Math.max(...weights.filter(v => v !== null)) : null,
      reason: 'PARTIAL_PUBLIC_POSITIONS_NO_COMPLETE_LOOK_THROUGH; NOT_TOTAL_INSTRUMENT_CONCENTRATION' },
    leverage: { status: leverages.some(v => v !== null) ? 'PARTIAL' : 'UNAVAILABLE', maxObserved: leverages.some(v => v !== null) ? Math.max(...leverages.filter(v => v !== null)) : null, reason: 'UNOBSERVED_POSITIONS_AND_DERIVATIVE_RISK_UNKNOWN' },
    stability: { status: 'UNAVAILABLE', value: null, reason: 'REPEATED_VISIBILITY_IS_NOT_A_BEHAVIORAL_TRACK_RECORD' },
    turnoverAndCosts: { status: 'UNAVAILABLE', value: null, reason: 'NO_TRANSACTION_HISTORY_OR_UNIT_SERIES; ALLOCATION_CHANGES_ARE_NOT_TRADES' },
    independence: { status: 'UNAVAILABLE', value: null, reason: 'SHARED_POSITIONS_DO_NOT_ESTABLISH_INDEPENDENT_SOURCES' }
  };
  return { traderId: trader.realCID, gcid: id(s?.identity?.gcid) ? s.identity.gcid : null, observationId: hash(trader.observationId) ? trader.observationId : null,
    collectedAt: ts(s?.collectedAt) !== null ? s.collectedAt : null, usableForContext: Boolean(usable), metrics,
    ranking: { status: 'UNAVAILABLE', score: null, rank: null, reason: 'BEST_TRADER_QUALIFICATION_REQUIRES_ALL_COMPARABLE_CRITERIA' },
    confidence: { status: usable ? 'LOW_CONTEXT_ONLY' : 'UNAVAILABLE', completeCriteria: 0, requiredCriteria: Object.keys(metrics).length,
      missingCriteria: Object.keys(metrics), probabilityOfSuccess: null } };
}
function transition(previous, a, policy, now) {
  const at = new Date(now).toISOString();
  const r = previous ? structuredClone(previous) : { traderId: a.traderId, gcid: a.gcid, state: 'PROBATION', since: at, firstSeenAt: at, qualifyingIds: [], everSelected: false };
  const identityConflict = r.gcid && a.gcid && r.gcid !== a.gcid;
  if (identityConflict || !a.usableForContext) {
    if (r.state !== 'EXITED') {
      if (r.state !== 'SUSPENDED') { r.state = 'SUSPENDED'; r.since = at; }
      if (now - ts(r.since) >= policy.suspensionExitDays * DAY) { r.state = 'EXITED'; r.since = at; }
    }
    r.qualifyingIds = []; r.qualificationStartedAt = null;
    r.reason = identityConflict ? 'STABLE_IDENTITY_CONFLICT' : 'VISIBILITY_LOST_OR_UNUSABLE; NOT_A_SELL_SIGNAL';
    return r;
  }
  if (!r.gcid) r.gcid = a.gcid;
  if (r.state === 'EXITED' && now - ts(r.since) < policy.reentryDays * DAY) { r.reason = 'REENTRY_COOLDOWN'; return r; }
  if (r.state === 'SUSPENDED' || r.state === 'EXITED') { r.state = 'PROBATION'; r.since = at; r.qualifyingIds = []; r.qualificationStartedAt = null; }
  if (!r.qualificationStartedAt) r.qualificationStartedAt = at;
  if (!r.qualifyingIds.includes(a.observationId)) r.qualifyingIds = [...r.qualifyingIds, a.observationId].slice(-100);
  if (r.state === 'PROBATION' && r.qualifyingIds.length >= policy.qualifyingObservations && now - ts(r.qualificationStartedAt) >= policy.probationDays * DAY) {
    r.state = 'SELECTED_CONTEXT_ONLY'; r.since = at; r.everSelected = true;
  }
  r.reason = r.state === 'SELECTED_CONTEXT_ONLY' ? 'STABLE_VISIBILITY_ONLY; NOT_BEST_TRADER_OR_TRADE_PERMISSION' : 'WAITING_FOR_DISTINCT_OBSERVATIONS_AND_MINIMUM_DURATION';
  return r;
}
function emptyExposure(now) { return { generatedAt: null, owned: { fresh: false, coverage: 'UNAVAILABLE', rows: [], knownValuesByInstrument: {}, unreconstructedRisk: [] }, pending: { status: 'UNAVAILABLE' }, dimensions: { status: 'UNAVAILABLE' }, now }; }
function propose({ ideas, assessments, roster, observerView, observerState, exposure, quotes, costs, eligibility, sizingEvidence }, policy, now) {
  const result = [];
  const traders = observerView.traders || [];
  for (const idea of ideas.slice(0, 20)) {
    if (!id(idea?.instrumentId) || !['BUY', 'SELL'].includes(idea.side)) continue;
    const vetoes = [], reasons = ['TRADER_HOLDINGS_ARE_CONTEXT_NOT_TRANSACTION_INSTRUCTIONS'];
    const refs = [], directions = new Set();
    for (const a of assessments) {
      if (!a.usableForContext || roster[a.traderId]?.state !== 'SELECTED_CONTEXT_ONLY') continue;
      const t = traders.find(t => t.realCID === a.traderId);
      const rows = (t.snapshot.portfolio.positions || []).filter(p => p.instrumentId === idea.instrumentId);
      if (!rows.length) continue;
      refs.push({ traderId: a.traderId, observationId: a.observationId });
      for (const row of rows) {
        directions.add(row.isBuy === true ? 'LONG' : row.isBuy === false ? 'SHORT' : 'UNKNOWN');
        if (num(row.leverage) === null || row.leverage !== 1) vetoes.push('SOURCE_LEVERAGE_UNKNOWN_OR_NOT_ONE');
      }
    }
    if (!refs.length) vetoes.push('NO_SELECTED_CURRENT_SOURCE_FOR_INSTRUMENT');
    if (directions.size > 1 || directions.has('UNKNOWN')) vetoes.push('CONFLICTING_OR_UNKNOWN_SOURCE_DIRECTIONS');
    if (idea.side === 'BUY' && directions.has('SHORT')) vetoes.push('SOURCE_CONTEXT_OPPOSES_LONG_ENTRY');
    if (idea.side === 'SELL' && directions.has('LONG')) reasons.push('SOURCES_STILL_HOLD_LONG; LEO_SELL_THESIS_REQUIRES_OWN_JUSTIFICATION');
    if (!fresh(idea.asOf, now, policy.decisionMaxAgeMs)) vetoes.push('LEO_IDEA_STALE_OR_UNDATED');
    if (idea.ownAnalysisApproved !== true) vetoes.push('LEO_APPROVAL_UNVERIFIED');
    if (idea.hardVeto === true) vetoes.push('LEO_ANALYSIS_OR_RISK_VETO');
    if (idea.alreadyHandled === true) vetoes.push('LEO_IDEA_ALREADY_HANDLED_NOT_A_NEW_ORDER_SIGNAL');
    const q = quotes[idea.instrumentId];
    if (!fresh(q?.asOf, now, policy.quoteMaxAgeMs) || num(q?.mid) === null || q.mid <= 0 || q.currency !== 'USD' || q.instrumentId !== idea.instrumentId) vetoes.push('QUOTE_MISSING_STALE_OR_INCOMPATIBLE');
    const drift = num(q?.mid) !== null && num(idea.referencePrice) !== null && idea.referencePrice > 0 ? Math.abs(q.mid / idea.referencePrice - 1) * 100 : null;
    if (drift === null) vetoes.push('LEO_REFERENCE_PRICE_UNKNOWN');
    else if (drift > policy.maxDecisionPriceDriftPct) vetoes.push('PRICE_MOVED_TOO_FAR_SINCE_LEO_IDEA');
    const c = costs[idea.instrumentId];
    if (c?.contextBinding !== 'VERIFIED_SAME_ACCOUNT') vetoes.push('COST_ACCOUNT_CONTEXT_UNVERIFIED');
    if (!fresh(c?.asOf, now, policy.quoteMaxAgeMs) || c?.currency !== 'USD' || c?.instrumentId !== idea.instrumentId || c?.side !== idea.side || c?.coverage !== 'COMPLETE_ESTIMATE' || num(c?.allInCostPct) === null || c.allInCostPct < 0 || !Array.isArray(c.unresolvedComponents) || c.unresolvedComponents.length) vetoes.push('COSTS_UNKNOWN_INCOMPLETE_OR_STALE');
    else if (c.allInCostPct > policy.maxCostPct) vetoes.push('COST_LIMIT_EXCEEDED');
    const e = eligibility[idea.instrumentId];
    if (e?.contextBinding !== 'VERIFIED_SAME_ACCOUNT' || e?.currency !== 'USD' || e?.leverage !== 1 || e?.orderType !== 'MARKET' || e?.settlementType !== 'Underlying') vetoes.push('ELIGIBILITY_ACCOUNT_OR_PRODUCT_CONTEXT_UNVERIFIED');
    if (!fresh(e?.asOf, now, policy.quoteMaxAgeMs) || e?.instrumentId !== idea.instrumentId || e?.side !== idea.side || e?.technicalEligible !== true || e?.leoPolicyAllowed !== true) vetoes.push('ELIGIBILITY_OR_LEO_POLICY_UNVERIFIED');
    let draft = null, action = idea.side === 'BUY' ? 'REVIEW_ENTRY_OR_REINFORCEMENT' : 'REVIEW_REDUCTION';
    if (idea.side === 'BUY') {
      if (num(idea.amountUsd) === null || idea.amountUsd <= 0) vetoes.push('LEO_AMOUNT_MISSING');
      else draft = { instrumentId: idea.instrumentId, side: 'BUY', currency: 'USD', amount: Math.min(policy.maxOrderUsd, idea.amountUsd), traderSources: refs };
    } else {
      const target = exposure.owned.rows.find(p => p.positionId === String(idea.positionId) && p.instrumentId === idea.instrumentId && p.ownership === 'DIRECT' && p.isBuy === true);
      if (!target) vetoes.push('SELL_POSITION_ID_OR_DIRECT_OWNERSHIP_UNVERIFIED');
      else if (idea.exitExplicit === true) { action = 'REVIEW_EXIT_OF_EXACT_POSITION'; draft = { instrumentId: idea.instrumentId, side: 'SELL', currency: 'USD', positionId: target.positionId, quantityMode: 'FULL_POSITION', traderSources: refs }; }
      else if (num(target.units) === null || target.units <= 0) vetoes.push('BROKER_POSITION_UNITS_UNKNOWN');
      else draft = { instrumentId: idea.instrumentId, side: 'SELL', currency: 'USD', positionId: target.positionId, quantityMode: 'UNITS', units: target.units * policy.reductionFraction, traderSources: refs };
    }
    let preview = null;
    if (!fresh(exposure.generatedAt, now, policy.quoteMaxAgeMs)) vetoes.push('EXPOSURE_CACHE_STALE_OR_UNAVAILABLE');
    if (draft) {
      preview = previewProposal(draft, exposure, { observerState, observerView, now, eligibility: e,
        proposalId: () => digest({ version: VERSION, idea: { instrumentId: idea.instrumentId, side: idea.side, asOf: idea.asOf }, draft }), sizingEvidence,
        policy: { maxOrderUsd: policy.maxOrderUsd, maxInstrumentWeightPct: policy.maxInstrumentWeightPct,
          minimumCashReserveUsd: num(sizingEvidence?.equityUsd) === null ? null : sizingEvidence.equityUsd * policy.minCashReservePct / 100 } });
      vetoes.push(...preview.problems);
      if (preview.sizing.status === 'UNAVAILABLE') vetoes.push('EXPOSURE_CASH_OR_RISK_LIMITS_UNVERIFIED');
      else if (idea.side === 'BUY' && draft.amount > preview.sizing.headroomUsd) vetoes.push('EXPOSURE_OR_CASH_LIMIT_EXCEEDED');
      if (num(c?.amountUsd) === null || c.amountUsd !== (draft.amount ?? Math.abs(preview.marginal.proposedDeltaUsd))) vetoes.push('COST_ESTIMATE_SIZE_MISMATCH_OR_UNKNOWN');
      if (num(e?.minimumUsd) === null || num(e?.maximumUsd) === null) vetoes.push('ORDER_LIMITS_UNKNOWN');
      else { const amount = draft.amount ?? Math.abs(preview.marginal.proposedDeltaUsd); if (num(amount) === null || amount < e.minimumUsd || amount > e.maximumUsd) vetoes.push('ORDER_LIMITS_INCOMPATIBLE'); }
    }
    const unique = [...new Set(vetoes)].sort();
    result.push({ instrumentId: idea.instrumentId, action, status: unique.length ? 'VETOED_ADVISORY' : 'ADVISORY_REVIEW_ONLY',
      reasons, vetoes: unique, traderSources: refs, independence: 'UNVERIFIED_NO_SOURCE_COUNT_BOOST', confidence: refs.length ? 'LOW_CONTEXT_ONLY' : 'UNAVAILABLE',
      decisionPriceDriftPct: drift, traderExecutionPriceDriftPct: null, draft, preview,
      executionAllowed: false, canOverrideLeoVeto: false });
  }
  return result;
}
function evaluate({ state = initialState(), observerView = {}, observerState = {}, ideas = [], exposure = null, quotes = {}, costs = {}, eligibility = {}, sizingEvidence = null,
  overrides = {}, now } = {}) {
  if (!Number.isFinite(now) || state.version !== 1 || !state.roster || !Array.isArray(state.history) || !Array.isArray(ideas) || state.disabledReason) throw Error('INVALID_OR_ARCHIVE_REQUIRED_ADVISORY_STATE');
  if (ts(state.lastAt) !== null && now < ts(state.lastAt)) throw Error('NON_MONOTONIC_EVALUATION');
  const policy = config(overrides), next = structuredClone(state), traders = observerView.traders || [];
  const policyId = digest(policy);
  if (next.policyId && next.policyId !== policyId) for (const r of Object.values(next.roster)) {
    if (r.state === 'SELECTED_CONTEXT_ONLY' || r.state === 'PROBATION') { r.state = 'PROBATION'; r.since = new Date(now).toISOString(); r.qualifyingIds = []; r.qualificationStartedAt = null; }
  }
  next.policyId = policyId;
  if (!Array.isArray(traders) || traders.length > 5 || traders.some(t => !id(t?.realCID))) throw Error('INVALID_ADVISORY_TRADERS');
  const duplicates = new Set(traders.filter((t, i) => traders.findIndex(r => r.realCID === t.realCID) !== i).map(t => t.realCID));
  const assessments = traders.filter((t, i) => traders.findIndex(r => r.realCID === t.realCID) === i).map(t => assess(duplicates.has(t.realCID) ? { ...t, status: 'UNAVAILABLE' } : t, policy, now)).sort((a, b) => a.traderId - b.traderId);
  const ids = new Set(assessments.map(a => a.traderId));
  for (const a of assessments) {
    if (!next.roster[a.traderId] && Object.keys(next.roster).length >= 100) throw Error('SELECTION_ROSTER_CAPACITY; ARCHIVE_REQUIRED');
    next.roster[a.traderId] = transition(next.roster[a.traderId], a, policy, now);
  }
  for (const r of Object.values(next.roster)) if (!ids.has(r.traderId)) next.roster[r.traderId] = transition(r, { traderId: r.traderId, usableForContext: false }, policy, now);
  const selectedPolicy = { id: 'LEO_CONTEXT_ONLY', version: VERSION, weights: null, reason: 'TRANSACTIONS_AND_INDEPENDENCE_NOT_PROVEN; NO_COPY_OR_SOCIAL_ONLY_TRADE' };
  const proposals = propose({ ideas, assessments, roster: next.roster, observerView, observerState, exposure: exposure || emptyExposure(now), quotes, costs, eligibility, sizingEvidence }, policy, now);
  const decision = { at: new Date(now).toISOString(), policy, policyId: digest(policy), selectedPolicy,
    assessments, selection: Object.values(next.roster).sort((a, b) => a.traderId - b.traderId),
    proposals: proposals.map(p => ({ instrumentId: p.instrumentId, action: p.action, status: p.status, vetoes: p.vetoes, traderSources: p.traderSources, traceId: p.preview?.trace?.proposalId || null })) };
  const evaluationId = digest(decision);
  if (!next.history.some(h => h.evaluationId === evaluationId)) next.history.push({ evaluationId, ...decision });
  if (next.history.length > policy.maxHistory) { next.history = next.history.slice(-policy.maxHistory); next.historyTruncated = true; }
  next.lastAt = decision.at;
  return { state: next, report: { evaluationId, generatedAt: decision.at, policy, selectedPolicy,
    hypotheses: [ { id: 'EXPLICIT_TRANSACTIONS', status: 'UNAVAILABLE', reason: 'OBSERVER_HAS_NO_INDIVIDUAL_TRANSACTION_EVIDENCE' },
      { id: 'INDEPENDENT_WEIGHTED_CONSENSUS', status: 'UNAVAILABLE', reason: 'INDEPENDENCE_AND_COMPARABLE_QUALITY_WEIGHTS_NOT_ESTABLISHED' },
      { id: 'LEO_CONTEXT_ONLY', status: 'CHOSEN_FOR_ADVISORY_RESEARCH', reason: selectedPolicy.reason } ],
    ranking: { status: 'UNAVAILABLE', orderedTraderIds: null, reason: 'NO_COMPARABLE_COMPLETE_QUALITY_DATA; COPIER_COUNT_AND_RECENT_GAIN_NOT_RANKING_INPUTS' },
    assessments, selection: decision.selection, proposals, executionAllowed: false, brokerCalls: 0,
    maintenancePolicy: 'NO_NEW_LEO_IDEA_MEANS_NO_OPERATION; SOURCE_SUSPENSION_EXIT_OR_DISAPPEARANCE_NEVER_LIQUIDATES_OWNED_POSITIONS',
    coverage: { observerHistoryTruncated: observerView.historyTruncated === true, selectionHistoryTruncated: next.historyTruncated, fullSurvivorshipFreeUniverse: false },
    limitations: ['CONFIGURED_SAMPLE_NOT_ALL_TRADERS', 'PARTIAL_POSITIONS_NOT_TRANSACTIONS', 'SOURCE_EFFECTIVE_DATES_UNKNOWN', 'NO_FUTURE_PERFORMANCE_PROOF', 'HISTORY_RETENTION_BOUNDED_ARCHIVE_REQUIRED'] } };
}
module.exports = { VERSION, DEFAULTS, config, initialState, compactState, assess, evaluate };
