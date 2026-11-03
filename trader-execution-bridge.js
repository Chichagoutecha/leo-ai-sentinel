'use strict';
// Orchestration only: no HTTP, credentials, order client or autonomous worker.
const { digest } = require('./trader-observer');
const VERSION = 'trader-execution-v1';
const finite = n => typeof n === 'number' && Number.isFinite(n);
const safeId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);
const brokerPositionId = v => typeof v === 'number' ? Number.isSafeInteger(v) && v > 0 : typeof v === 'string' && /^[1-9][0-9]{0,25}$/.test(v);
const stamp = s => typeof s === 'string' && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null;
const fresh = (s, now, age = 300000) => stamp(s) !== null && now >= stamp(s) && now - stamp(s) <= age;
const active = s => !['CONFIRMED', 'REJECTED', 'VETOED'].includes(s);
function initialState() { return { version: 1, recoveryRequired: true, emergencyStop: false, disabledReason: null, operations: {}, managed: {}, queue: [] }; }
function proposal(raw) {
  const allowed = ['proposalId', 'decisionId', 'policyVersion', 'policyId', 'createdAt', 'side', 'asset', 'instrumentId', 'amountUsd', 'positionId', 'units', 'quantityMode', 'traderSources', 'decision', 'scope', 'leoConfidence', 'referencePrice', 'priceDriftLimitPct'];
  if (!raw || Object.keys(raw).some(k => !allowed.includes(k)) || !safeId(raw.proposalId) || !safeId(raw.policyVersion) || stamp(raw.createdAt) === null || !['BUY', 'SELL'].includes(raw.side) || !/^[A-Z0-9.:-]{1,32}$/.test(raw.asset) || !Number.isSafeInteger(raw.instrumentId) || raw.instrumentId <= 0 || raw.scope !== 'REAL_MANAGED_STRATEGY' || raw.decision !== 'ADVISORY_REVIEW_ONLY') throw Error('INVALID_EXECUTION_PROPOSAL');
  if (!Array.isArray(raw.traderSources) || !raw.traderSources.length || raw.traderSources.length > 5 || raw.traderSources.some(r => !Number.isSafeInteger(r?.traderId) || r.traderId <= 0 || !/^[a-f0-9]{64}$/.test(r?.observationId) || Object.keys(r).some(k => !['traderId', 'observationId', 'eventId'].includes(k)) || r.eventId !== undefined && !/^[a-f0-9]{64}$/.test(r.eventId))) throw Error('INVALID_SOURCE_PROVENANCE');
  if (!finite(raw.leoConfidence) || raw.leoConfidence < 0 || raw.leoConfidence > 100) throw Error('LEO_CONFIDENCE_REQUIRED');
  if (!/^[a-f0-9]{64}$/.test(raw.policyId)) throw Error('EXACT_POLICY_CONFIG_REQUIRED');
  if (!safeId(raw.decisionId)) throw Error('STABLE_LEO_DECISION_ID_REQUIRED');
  if (!finite(raw.referencePrice) || raw.referencePrice <= 0 || !finite(raw.priceDriftLimitPct) || raw.priceDriftLimitPct <= 0 || raw.priceDriftLimitPct > 100) throw Error('DECISION_PRICE_REFERENCE_REQUIRED');
  if (raw.side === 'BUY' && (!finite(raw.amountUsd) || raw.amountUsd <= 0 || raw.positionId !== undefined || raw.units !== undefined)) throw Error('INVALID_BUY');
  if (raw.side === 'SELL' && (!brokerPositionId(raw.positionId) || !finite(raw.units) || raw.units <= 0 || !['FULL_POSITION', 'UNITS'].includes(raw.quantityMode) || raw.amountUsd !== undefined)) throw Error('INVALID_SELL');
  return structuredClone(raw);
}
function initializeForContext(state, evidence) {
  if (evidence?.identityVerified !== true || evidence?.tokenBindingVerified !== true || !safeId(evidence.accountRef) || evidence.mode !== 'LIVE' || evidence.executionHistoryReviewed !== true || Object.keys(state.operations).length || Object.keys(state.managed).length) throw Error('INITIALIZATION_REVIEW_REQUIRED');
  return { ...structuredClone(state), recoveryRequired: false, accountRef: evidence.accountRef };
}
function enqueue(state, raw) {
  const p = proposal(raw), next = structuredClone(state);
  const previous = next.queue.find(r => r.proposalId === p.proposalId) || next.operations[p.proposalId]?.proposal;
  if (previous) { if (digest(previous) !== digest(p)) throw Error('PROPOSAL_ID_CONFLICT'); return next; }
  if (next.queue.some(r => r.decisionId === p.decisionId) || Object.values(next.operations).some(o => o.proposal.decisionId === p.decisionId)) throw Error('DUPLICATE_ORIGIN_DECISION');
  if (next.queue.length >= 50 || Object.keys(next.operations).length >= 200) { next.disabledReason = 'ARCHIVE_REQUIRED_NO_IDEMPOTENCY_EVICTION'; return next; }
  next.queue.push(p); return next;
}
function select(state) {
  return [...state.queue].filter(p => !state.operations[p.proposalId]).sort((a, b) => (a.side === 'SELL' ? 0 : 1) - (b.side === 'SELL' ? 0 : 1) || a.createdAt.localeCompare(b.createdAt) || a.proposalId.localeCompare(b.proposalId))[0] || null;
}
function preflight(state, p, e, settings, now) {
  const vetoes = [];
  if (settings.enabled !== true) vetoes.push('AUTOMATION_DISABLED');
  if (settings.confirmation !== 'I_UNDERSTAND_TRADER_STRATEGY_REAL_ORDERS') vetoes.push('STRATEGY_ARMING_REQUIRED');
  if (e?.mode !== 'LIVE' || e?.armed !== true) vetoes.push('LIVE_MODE_AND_ARMING_REQUIRED');
  if (state.recoveryRequired || state.disabledReason) vetoes.push('RECOVERY_OR_ARCHIVE_REQUIRED');
  if (state.emergencyStop || settings.emergencyStop === true) vetoes.push('EMERGENCY_STOP');
  if (e?.identityVerified !== true || e?.tokenBindingVerified !== true || !safeId(e?.accountRef) || state.accountRef !== e.accountRef) vetoes.push('ACCOUNT_OR_TOKEN_BINDING_UNVERIFIED');
  if (!fresh(p.createdAt, now)) vetoes.push('PROPOSAL_STALE_OR_FUTURE');
  if (p.side === 'BUY' && (settings.entriesEnabled !== true || e.buyArmed !== true)) vetoes.push('ENTRIES_DISABLED_OR_BUY_ARMING_REQUIRED');
  if (p.side === 'SELL' && settings.exitsEnabled !== true) vetoes.push('EXITS_DISABLED');
  if (e?.release?.status !== 'APPROVED_CHRONOLOGICAL_EVALUATION' || e.release.policyVersion !== p.policyVersion || e.release.policyId !== p.policyId || e.release.accountRef !== e.accountRef || e.release.environment !== 'REAL' || e.release.sampleStatus !== 'SUFFICIENT' || e.release.liveAccountReviewed !== true || stamp(e.release.approvedAt) === null || stamp(e.release.approvedAt) > now || stamp(e.release.evaluationEndAt) === null || stamp(e.release.evaluationEndAt) > stamp(e.release.approvedAt)) vetoes.push('EVALUATION_RELEASE_UNVERIFIED');
  if (!e?.instrument || e.instrument.instrumentId !== p.instrumentId || e.instrument.asset !== p.asset || e.instrument.allowed !== true) vetoes.push('INSTRUMENT_OR_ALLOWLIST_UNVERIFIED');
  if (!fresh(e?.asOf, now) || e?.portfolioComplete !== true || e?.pendingComplete !== true) vetoes.push('PORTFOLIO_OR_PENDING_INCOMPLETE');
  if (!Array.isArray(e?.positions) || e.positions.some(r => !brokerPositionId(r.positionId) || r.instrumentId !== p.instrumentId && r.asset === p.asset)) vetoes.push('POSITION_IDENTITY_UNVERIFIED');
  if (Array.isArray(e?.positions) && new Set(e.positions.map(r => String(r.positionId))).size !== e.positions.length) vetoes.push('DUPLICATE_POSITION_IDENTIFIERS');
  if (e?.uncertainOrPending === true || Object.values(state.operations).some(o => active(o.status))) vetoes.push('PENDING_OR_UNCERTAIN_OPERATION');
  const quote = e?.quote;
  if (!fresh(quote?.asOf, now) || quote.instrumentId !== p.instrumentId || quote.currency !== 'USD' || !finite(quote.bid) || !finite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) vetoes.push('QUOTE_STALE_OR_INVALID');
  if (finite(quote?.bid) && finite(quote?.ask) && Math.abs((quote.bid + quote.ask) / 2 / p.referencePrice - 1) * 100 > p.priceDriftLimitPct) vetoes.push('PRICE_DRIFT_SINCE_PROPOSAL');
  const eligibility = e?.eligibility;
  if (!fresh(eligibility?.asOf, now) || eligibility.instrumentId !== p.instrumentId || eligibility.side !== p.side || eligibility.allowed !== true || eligibility.accountRef !== e.accountRef || eligibility.currency !== 'USD' || eligibility.leverage !== 1 || eligibility.settlementType !== 'Underlying') vetoes.push('ELIGIBILITY_UNVERIFIED');
  const cost = e?.cost;
  if (!fresh(cost?.asOf, now) || cost.instrumentId !== p.instrumentId || cost.side !== p.side || cost.accountRef !== e.accountRef || cost.coverage !== 'COMPLETE_ESTIMATE' || !finite(cost.totalUsd) || cost.totalUsd < 0 || !finite(settings.maxCostUsd) || cost.totalUsd > settings.maxCostUsd) vetoes.push('COST_UNKNOWN_OR_EXCESS');
  if (e?.risk?.approved !== true || e.risk.side !== p.side || e.risk.instrumentId !== p.instrumentId || e.risk.proposalId !== p.proposalId || !fresh(e.risk.asOf, now)) vetoes.push('FINAL_LEO_RISK_VETO_OR_UNVERIFIED');
  if (e?.limits?.cadenceAllowed !== true || e?.limits?.dailyAllowed !== true || e?.limits?.singleWriterVerified !== true) vetoes.push('CADENCE_RISK_OR_SINGLE_WRITER_UNVERIFIED');
  if (!e?.exposure || e.exposure.coverage !== 'COMPLETE' || e.exposure.afterWithinLimits !== true || !fresh(e.exposure.asOf, now) || e.exposure.proposalId !== p.proposalId) vetoes.push('MARGINAL_EXPOSURE_UNKNOWN_OR_EXCESS');
  if (e?.sourceProof?.status !== 'CURRENT_REFERENCES_VERIFIED' || e.sourceProof.proposalId !== p.proposalId || !fresh(e.sourceProof.asOf, now) || e.sourceProof.opposed === true) vetoes.push('SOURCE_REFERENCES_INVALID_OR_OPPOSED');
  const matching = (e?.positions || []).filter(r => r.instrumentId === p.instrumentId);
  if (matching.some(r => !state.managed[String(r.positionId)] || state.managed[String(r.positionId)].accountRef !== e.accountRef || state.managed[String(r.positionId)].status !== 'VERIFIED_MANAGED' || state.managed[String(r.positionId)].units !== r.units || r.ownership !== 'DIRECT' || r.isBuy !== true || r.leverage !== 1 || r.settlementType !== 'Underlying')) vetoes.push('UNMANAGED_OR_COPY_POSITION_ON_INSTRUMENT');
  if (p.side === 'BUY') {
    if (!finite(settings.maxOrderUsd) || p.amountUsd > settings.maxOrderUsd || !finite(eligibility?.minimumUsd) || !finite(eligibility?.maximumUsd) || p.amountUsd < eligibility.minimumUsd || p.amountUsd > eligibility.maximumUsd) vetoes.push('AMOUNT_OUTSIDE_CAP_OR_MINIMUMS');
    if (!finite(e?.cashUsd) || e.cashUsd < 0 || !finite(e?.reserveUsd) || e.reserveUsd < 0 || !finite(cost?.totalUsd) || e.cashUsd - p.amountUsd - cost.totalUsd < e.reserveUsd) vetoes.push('CASH_OR_RESERVE_UNAVAILABLE');
    if (cost?.amountUsd !== p.amountUsd || e?.exposure?.amountUsd !== p.amountUsd || e?.risk?.amountUsd !== p.amountUsd) vetoes.push('BUY_SIZE_EVIDENCE_MISMATCH');
  } else {
    const managed = state.managed[String(p.positionId)], target = matching.filter(r => String(r.positionId) === String(p.positionId));
    if (p.quantityMode !== 'FULL_POSITION') vetoes.push('PARTIAL_CLOSE_NOT_RELIABLY_SUPPORTED');
    if (target.length !== 1 || !managed || managed.status !== 'VERIFIED_MANAGED' || managed.accountRef !== e.accountRef || managed.instrumentId !== p.instrumentId || target[0]?.ownership !== 'DIRECT' || target[0]?.isBuy !== true || target[0]?.units !== p.units || managed.units !== p.units || managed.externalMutation === true) vetoes.push('EXACT_MANAGED_FULL_POSITION_SCOPE_UNVERIFIED');
    if (cost?.units !== p.units || e?.exposure?.units !== p.units || e?.risk?.positionId !== String(p.positionId) || e?.risk?.units !== p.units) vetoes.push('SELL_SIZE_EVIDENCE_MISMATCH');
    const cap = settings.maxExitNotionalUsd ?? settings.maxOrderUsd;
    if (!finite(cap) || !finite(quote?.bid) || p.units * quote.bid > cap) vetoes.push('FULL_EXIT_EXCEEDS_ORDER_CAP_PARTIAL_CLOSE_UNSUPPORTED');
  }
  return [...new Set(vetoes)].sort();
}
function guardExecutor(state, metadata, positions, accountRef, now) {
  const operation = state.operations[metadata?.operationId];
  const p = operation?.proposal;
  if (!operation || operation.status !== 'RESERVED' || !p || metadata.proposalId !== p.proposalId || operation.accountRef !== accountRef || state.emergencyStop || state.disabledReason || state.recoveryRequired || !fresh(operation.reservedAt, now) || !Array.isArray(positions) || !operation.checks || Object.values(operation.checks).some(t => !fresh(t, now))) return false;
  const rows = positions.filter(r => r.instrumentId === p.instrumentId);
  if (rows.some(r => r.ownership !== 'DIRECT' || !state.managed[String(r.positionId)] || state.managed[String(r.positionId)].units !== r.units)) return false;
  if (p.side === 'SELL') return rows.filter(r => String(r.positionId) === String(p.positionId) && r.units === p.units && r.isBuy === true).length === 1;
  return true;
}
function recover(state) {
  const copy = structuredClone(state);
  for (const o of Object.values(copy.operations)) if (active(o.status)) o.status = 'NEEDS_RECONCILIATION';
  return copy;
}
function applyResult(state, id, result, now) {
  const op = state.operations[id];
  if (!op) throw Error('UNKNOWN_OPERATION');
  if (op.intentId && op.intentId !== result?.intentId || result?.confirmed === true && !op.intentId) { op.status = 'NEEDS_RECONCILIATION'; return; }
  op.intentId = safeId(result?.intentId) ? result.intentId : op.intentId || null;
  op.updatedAt = new Date(now).toISOString();
  if (result?.confirmed !== true) {
    op.status = result?.verification_status === 'ORDER_REJECTED' ? 'REJECTED' : result?.skipped === true && !op.intentId ? 'VETOED' : 'NEEDS_RECONCILIATION';
    op.evidence = { confirmed: false, acknowledgementOnly: result?.businessAcknowledged === true, brokerOrderId: null };
    if (op.status === 'VETOED') op.vetoes = ['STRATEGY_LIVE_ONLY', 'STRATEGY_REVALIDATION_FAILED', 'TARGET_UNITS_CHANGED', 'PARTIAL_CLOSE_NOT_RELIABLY_SUPPORTED'].includes(result?.reason) ? [result.reason] : ['NORMAL_EXECUTOR_VETO'];
    return;
  }
  const before = result?.verification?.beforeSnapshot || op.beforeSnapshot;
  const after = result?.verification?.afterSnapshot;
  const p = op.proposal;
  const beforeRows = before?.positionDetails, afterRows = after?.positionDetails;
  if (!op.intentId || !Array.isArray(beforeRows) || !Array.isArray(afterRows) || before?.instrumentId !== p.instrumentId || after?.instrumentId !== p.instrumentId) { op.status = 'NEEDS_RECONCILIATION'; return; }
  if ([...beforeRows, ...afterRows].some(r => !brokerPositionId(r.positionId) || !finite(r.units) || r.units <= 0)) { op.status = 'NEEDS_RECONCILIATION'; return; }
  const ids = rows => rows.map(r => String(r.positionId));
  if (new Set(ids(beforeRows)).size !== beforeRows.length || new Set(ids(afterRows)).size !== afterRows.length) { op.status = 'NEEDS_RECONCILIATION'; return; }
  if (p.side === 'SELL') {
    if (!beforeRows.some(r => String(r.positionId) === String(p.positionId) && r.units === p.units) || afterRows.some(r => String(r.positionId) === String(p.positionId))) { op.status = 'NEEDS_RECONCILIATION'; return; }
    delete state.managed[String(p.positionId)];
  } else {
    const changed = afterRows.filter(a => !beforeRows.some(b => String(b.positionId) === String(a.positionId) && b.units === a.units));
    const beforeUnchanged = beforeRows.every(b => afterRows.some(a => String(a.positionId) === String(b.positionId) && a.units >= b.units));
    const target = changed[0], existing = target && state.managed[String(target.positionId)];
    const previous = target && beforeRows.find(b => String(b.positionId) === String(target.positionId));
    if (!beforeUnchanged || changed.length !== 1 || !safeId(String(target?.positionId || '')) || String(result?.data?.positionId || '') !== String(target?.positionId) || !finite(target?.units) || target.units <= 0 || previous && (!existing || existing.units !== previous.units) || !previous && existing || previous && target.units <= previous.units) { op.status = 'NEEDS_RECONCILIATION'; return; }
    state.managed[String(target.positionId)] = { positionId: String(target.positionId), instrumentId: p.instrumentId, asset: p.asset, units: target.units,
      accountRef: op.accountRef, status: 'VERIFIED_MANAGED', operationIds: [...(existing?.operationIds || []), id], traderSources: [...(existing?.traderSources || []), ...p.traderSources],
      scope: 'WHOLE_BROKER_POSITION_NOT_SIGNAL_LOTS', verifiedAt: op.updatedAt };
  }
  op.status = 'CONFIRMED'; op.evidence = { confirmed: true, proof: p.side === 'SELL' ? 'EXACT_TARGET_REMOVAL' : 'UNAMBIGUOUS_MANAGED_POSITION_CHANGE', intentId: op.intentId };
}
function createController({ getState, setState, persist, evidence, executeNormal, clock = Date.now, settings = () => ({ enabled: false }) }) {
  let running = false;
  async function drain() {
    if (running) return { status: 'BUSY', executionAttempted: false };
    running = true;
    try {
      const config = settings(), state = getState();
      if (!config.enabled) return { status: 'AUTOMATION_DISABLED', executionAttempted: false };
      const p = select(state); if (!p) return { status: 'NO_PROPOSAL', executionAttempted: false };
      const e = await evidence(p);
      if (getState().operations[p.proposalId]) return { status: 'DUPLICATE_OPERATION', executionAttempted: false };
      const vetoes = preflight(getState(), p, e, settings(), clock());
      if (vetoes.length) {
        const next = structuredClone(getState()); next.operations[p.proposalId] = { proposal: p, status: 'VETOED', vetoes, accountRef: e?.accountRef || null, updatedAt: new Date(clock()).toISOString() };
        setState(next); await persist(); return { status: 'VETOED', proposalId: p.proposalId, vetoes, executionAttempted: false };
      }
      const next = structuredClone(getState());
      next.operations[p.proposalId] = { proposal: p, status: 'RESERVED', accountRef: e.accountRef, reservedAt: new Date(clock()).toISOString(),
        finalDecision: { side: p.side, instrumentId: p.instrumentId, amountUsd: p.amountUsd ?? null, positionId: p.positionId || null, units: p.units ?? null },
        checks: { portfolio: e.asOf, quote: e.quote.asOf, eligibility: e.eligibility.asOf, cost: e.cost.asOf, exposure: e.exposure.asOf, source: e.sourceProof.asOf, risk: e.risk.asOf },
        evidenceAtApproval: { quote: { bid: e.quote.bid, ask: e.quote.ask, asOf: e.quote.asOf },
          cost: { totalUsd: e.cost.totalUsd, amountUsd: e.cost.amountUsd ?? null, units: e.cost.units ?? null, coverage: e.cost.coverage },
          eligibility: { allowed: e.eligibility.allowed, minimumUsd: e.eligibility.minimumUsd ?? null, maximumUsd: e.eligibility.maximumUsd ?? null },
          exposure: { coverage: e.exposure.coverage, afterWithinLimits: e.exposure.afterWithinLimits }, cashUsd: e.cashUsd ?? null, reserveUsd: e.reserveUsd ?? null },
        beforeSnapshot: { instrumentId: p.instrumentId, positionDetails: e.positions.filter(r => r.instrumentId === p.instrumentId).map(r => ({ positionId: String(r.positionId), units: r.units })) } };
      setState(next);
      if (await persist() !== true) { getState().operations[p.proposalId].status = 'NEEDS_RECONCILIATION'; return { status: 'PERSISTENCE_UNAVAILABLE', executionAttempted: false }; }
      // Re-check after the durable reservation; no second executor invocation after any uncertainty.
      const again = settings();
      if (!getState().operations[p.proposalId] || getState().disabledReason || !again.enabled || again.emergencyStop || getState().emergencyStop) { if (getState().operations[p.proposalId]) getState().operations[p.proposalId].status = 'VETOED'; await persist(); return { status: 'EMERGENCY_STOP', executionAttempted: false }; }
      const withoutSelf = { ...getState(), operations: Object.fromEntries(Object.entries(getState().operations).filter(([id]) => id !== p.proposalId)) };
      const recheck = preflight(withoutSelf, p, e, again, clock());
      if (recheck.length) { getState().operations[p.proposalId].status = 'VETOED'; getState().operations[p.proposalId].vetoes = recheck; await persist(); return { status: 'VETOED', vetoes: recheck, executionAttempted: false }; }
      let result;
      try { result = await executeNormal(p, { operationId: p.proposalId, proposalId: p.proposalId, accountRef: e.accountRef }); }
      catch { result = { confirmed: false, uncertain: true }; }
      applyResult(getState(), p.proposalId, result, clock());
      if (await persist() !== true) { getState().operations[p.proposalId].status = 'NEEDS_RECONCILIATION'; getState().emergencyStop = true; }
      return { status: getState().operations[p.proposalId].status, proposalId: p.proposalId, intentId: getState().operations[p.proposalId].intentId || null,
        adapterInvoked: true, executionAttempted: result?.executionAttempted !== false && !(result?.skipped && !result?.intentId) };
    } finally { running = false; }
  }
  return { drain };
}
function reconcile(state, id, result, now) { const copy = structuredClone(state); applyResult(copy, id, result, now); return copy; }
function compact(state, maxBytes = 60000) {
  const copy = structuredClone(state || initialState());
  if (Buffer.byteLength(JSON.stringify(copy)) <= maxBytes) return copy;
  return { ...initialState(), emergencyStop: true, disabledReason: 'ARCHIVE_REQUIRED_NO_AUTOMATIC_RESET', accountRef: copy.accountRef || null };
}
module.exports = { VERSION, initialState, initializeForContext, proposal, enqueue, select, preflight, guardExecutor, recover, reconcile, createController, compact };
