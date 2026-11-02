'use strict';
// Chronological paired experiment. No broker, provider, AI, timer or environment access.
const advisory = require('./trader-advisory-policy');
const { digest } = require('./trader-observer');
const { virtualFill } = require('./paper-shadow-execution');
const { buildPaperShadowScorecard } = require('./paper-shadow-accounting');
const DAY = 86400000, VERSION = 'trader-shadow-v1';
const number = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const stamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const iso = v => new Date(v).toISOString();
const SOURCE_VETOES = new Set(['NO_SELECTED_CURRENT_SOURCE_FOR_INSTRUMENT', 'CONFLICTING_OR_UNKNOWN_SOURCE_DIRECTIONS', 'SOURCE_CONTEXT_OPPOSES_LONG_ENTRY', 'SOURCE_LEVERAGE_UNKNOWN_OR_NOT_ONE', 'TRADER_SOURCE_UNVERIFIED_OR_STALE']);
const DEFAULTS = Object.freeze({ designDays: 30, evaluationDays: 90, minimumEvaluationDays: 60, minimumDecisions: 100, minimumFullClosures: 20, maxRecords: 120 });
function protocolConfig(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).some(k => !(k in DEFAULTS))) throw Error('INVALID_EXPERIMENT_PROTOCOL');
  const p = { ...DEFAULTS, ...overrides };
  for (const n of Object.values(p)) if (number(n) === null || n <= 0) throw Error('INVALID_EXPERIMENT_PROTOCOL');
  if (!Number.isSafeInteger(p.maxRecords) || p.maxRecords > 120) throw Error('INVALID_EXPERIMENT_PROTOCOL');
  if (p.minimumEvaluationDays > p.evaluationDays) throw Error('INVALID_EXPERIMENT_PROTOCOL');
  return p;
}
function emptyState() { return { version: 1, protocol: null, advisoryState: advisory.initialState(), phases: {}, records: [], processedCycleIds: [], historyTruncated: false, lastAt: null, disabledReason: null }; }
function quoteAt(q, now, maxAgeMs) {
  const time = stamp(q?.date), received = stamp(q?.receivedAt || q?.fetchedAt || q?.date);
  return time !== null && received !== null && time <= now && received <= now && now - time <= maxAgeMs && now - received <= maxAgeMs &&
    q?.priceStatus === 'FRESH' && q?.eligibleForTrade === true && number(q?.mid) !== null && q.mid > 0;
}
function safeQuotes(rows, now, maxAgeMs) {
  const out = {};
  for (const [asset, q] of Object.entries(rows || {}).slice(0, 100)) if (/^[A-Z0-9.:-]{1,32}$/.test(asset)) out[asset] = {
    mid: number(q?.mid), bid: number(q?.bid), ask: number(q?.ask), date: stamp(q?.date) === null ? null : q.date,
    receivedAt: stamp(q?.receivedAt || q?.fetchedAt) === null ? null : q.receivedAt || q.fetchedAt,
    priceStatus: quoteAt(q, now, maxAgeMs) ? 'FRESH' : 'UNAVAILABLE_STALE_OR_FUTURE', eligibleForTrade: quoteAt(q, now, maxAgeMs),
    source: typeof q?.source === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(q.source) ? q.source : 'UNVERIFIED_SOURCE_LABEL' };
  return out;
}
function observerAt(view, state, now) {
  const copy = structuredClone(view || {}), ledger = structuredClone(state || {});
  const admitted = [];
  copy.traders = (copy.traders || []).filter(t => {
    const dates = [stamp(t.snapshot?.collectedAt), stamp(t.snapshot?.receivedAt || t.lastAttempt?.completedAt || t.snapshot?.collectedAt)];
    const allowed = dates.every(d => d !== null && d <= now) && [t.snapshot?.effectiveAt, t.snapshot?.publishedAt].every(d => stamp(d) === null || stamp(d) <= now);
    if (allowed) admitted.push(t.realCID);
    return allowed;
  });
  ledger.observations = (ledger.observations || []).filter(o => admitted.includes(o.realCID) && stamp(o.collectedAt) !== null && stamp(o.collectedAt) <= now && (stamp(o.receivedAt) === null || stamp(o.receivedAt) <= now));
  ledger.events = (ledger.events || []).filter(e => admitted.includes(e.traderId) && stamp(e.observedAt) !== null && stamp(e.observedAt) <= now && (stamp(e.receivedAt) === null || stamp(e.receivedAt) <= now));
  copy.events = ledger.events;
  ledger.traders = Object.fromEntries(Object.entries(ledger.traders || {}).filter(([key]) => admitted.includes(Number(key))));
  return { view: copy, state: ledger };
}
function seedBook(template, now, assumptions) {
  return { createdAt: iso(now), currency: 'USD', startingEquity: null, cash: template.cash, startingCash: template.cash,
    positions: structuredClone(template.positions || {}), realizedPnl: 0, feesPaid: 0, slippageCost: 0, orders: [], closedTrades: [], decisions: [], snapshots: [],
    cashFlows: [], cashFlowHistoryComplete: true, snapshotHistoryComplete: true, performanceBaseline: null, seedCoverage: structuredClone(template.seedCoverage || { complete: false, omittedAssets: [] }),
    assumptions: { feePct: assumptions.feePct, slippageBpsPerSide: assumptions.slippageBps, feeBasis: 'CONFIGURED_SIMULATION_ASSUMPTION' },
    benchmark: { asset: assumptions.benchmarkAsset, currency: assumptions.benchmarkCurrency, currencySource: 'FROZEN_PROTOCOL', startPrice: null, startTime: null, priceStatus: 'UNAVAILABLE' } };
}
function mark(book, quotes, now) {
  const missing = [], stale = [];
  let value = 0;
  for (const [asset, p] of Object.entries(book.positions)) {
    const q = quotes[asset];
    if (!q || number(q.mid) === null || q.mid <= 0) missing.push(asset);
    else if (q.priceStatus !== 'FRESH') stale.push(asset);
    else { p.currentPrice = q.mid; p.currentValue = p.units * q.mid; p.unrealizedPnl = p.currentValue - p.costBasis; }
    // Retained marks are a known subtotal, never proof of a complete current valuation.
    value += number(p.currentValue) ?? 0;
  }
  const equity = book.cash + value;
  const point = { time: iso(now), equity, cash: book.cash, valuationComplete: !missing.length && !stale.length && book.seedCoverage.complete === true,
    priceCoverage: { missingAssets: missing.sort(), staleAssets: stale.sort(), marketClosedAssets: [], omittedSeedAssets: book.seedCoverage.omittedAssets || [] } };
  if (!book.performanceBaseline) { book.performanceBaseline = structuredClone(point); book.startingEquity = equity; }
  const q = quotes[book.benchmark.asset];
  if (q?.priceStatus === 'FRESH') {
    if (book.benchmark.startPrice === null) Object.assign(book.benchmark, { startPrice: q.mid, startTime: iso(now), startPriceStatus: 'FRESH' });
    Object.assign(book.benchmark, { currentPrice: q.mid, priceStatus: 'FRESH', priceTime: q.date });
  } else book.benchmark.priceStatus = 'UNAVAILABLE';
  if (book.snapshots.at(-1)?.time.slice(0, 10) === point.time.slice(0, 10)) book.snapshots[book.snapshots.length - 1] = point;
  else book.snapshots.push(point);
  return point;
}
function virtualExposure(book, universe, quotes, now, pendingComplete) {
  const rows = [], values = {};
  for (const [asset, p] of Object.entries(book.positions)) {
    const item = universe.find(r => r.symbol === asset);
    if (!item) continue;
    rows.push({ positionId: `shadow-${asset.replace(/[^A-Za-z0-9_-]/g, '_')}`, asset, instrumentId: item.instrumentId, ownership: 'DIRECT',
      isBuy: true, units: p.units, estimatedValueUsd: p.currentValue, leverage: 1, settlementType: 'Underlying' });
    values[item.instrumentId] = p.currentValue;
  }
  const complete = book.snapshots.at(-1)?.valuationComplete === true && rows.length === Object.keys(book.positions).length;
  return { generatedAt: iso(now), owned: { scope: 'VIRTUAL_EXPERIMENT_ONLY', rows, knownValuesByInstrument: values, fresh: complete,
    coverage: complete ? 'COMPLETE' : 'INCOMPLETE', unreconstructedRisk: [] }, pending: { status: pendingComplete ? 'COMPLETE_KNOWN_BUY_UPPER_BOUND' : 'INCOMPLETE', knownBuyUpperBoundByInstrument: {} }, dimensions: { status: 'UNAVAILABLE_WITHOUT_LOOK_THROUGH' } };
}
function runCycle(input = {}) {
  const { now, mode, rawDecision = {}, control = {}, universe = [], template, costs = {}, eligibility = {}, realExposure = null, constraintsEvidence = null,
    extraAiCostUsd = null, experimentOverrides = {}, advisoryOverrides = {}, assumptions = {}, flow = null } = input;
  if (mode !== 'SHADOW') return { state: input.state || emptyState(), status: 'SHADOW_REQUIRED', brokerCalls: 0 };
  if (number(now) === null || !template || number(template.cash) === null || !Array.isArray(universe)) throw Error('INVALID_SHADOW_INPUT');
  const state = structuredClone(input.state || emptyState());
  if (state.disabledReason) return { state, status: 'ARCHIVE_REQUIRED', brokerCalls: 0 };
  const p = protocolConfig(experimentOverrides), a = advisory.config(advisoryOverrides);
  const spec = { experiment: p, advisory: a, assumptions: { feePct: assumptions.feePct, slippageBps: assumptions.slippageBps, benchmarkAsset: assumptions.benchmarkAsset, benchmarkCurrency: assumptions.benchmarkCurrency } };
  if (number(spec.assumptions.feePct) === null || spec.assumptions.feePct < 0 || number(spec.assumptions.slippageBps) === null || spec.assumptions.slippageBps < 0 || spec.assumptions.slippageBps >= 10000) throw Error('INVALID_SHADOW_COST_ASSUMPTIONS');
  const specId = digest(spec);
  if (!state.protocol && input.advisorySeed) {
    const seed = input.advisorySeed;
    if (seed.version !== 1 || seed.disabledReason || stamp(seed.lastAt) !== null && stamp(seed.lastAt) > now || (seed.history || []).some(h => stamp(h.at) !== null && stamp(h.at) > now)) throw Error('ADVISORY_SEED_UNAVAILABLE_OR_FUTURE');
    state.advisoryState = structuredClone(seed);
  }
  if (!state.protocol) state.protocol = { version: VERSION, registeredAt: iso(now), designUntil: iso(now + p.designDays * DAY), evaluationUntil: iso(now + (p.designDays + p.evaluationDays) * DAY), spec, specId,
    criteria: ['PAIRED_FLOW_ADJUSTED_RETURN_DIFFERENCE', 'DRAWDOWN', 'VOLATILITY', 'TURNOVER_AND_COSTS', 'COVERAGE', 'MINIMUM_DECISIONS_AND_FULL_CLOSURES'],
    statisticalClaim: 'DESCRIPTIVE_ONLY_NO_SIGNIFICANCE_OR_FUTURE_PERFORMANCE_CLAIM', template: { cash: template.cash, positions: structuredClone(template.positions || {}), seedCoverage: structuredClone(template.seedCoverage) } };
  if (state.protocol.specId !== specId) { state.invalidProtocolAttempts = (state.invalidProtocolAttempts || 0) + 1; return { state, status: 'FROZEN_PROTOCOL_MISMATCH_NEW_EXPERIMENT_REQUIRED', brokerCalls: 0 }; }
  if (typeof input.cycleId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.cycleId)) throw Error('STABLE_CYCLE_ID_REQUIRED');
  if (state.processedCycleIds.includes(input.cycleId)) return { state, status: 'DUPLICATE_CYCLE_ID', brokerCalls: 0 };
  if (stamp(state.lastAt) !== null && now <= stamp(state.lastAt)) return { state, status: 'DUPLICATE_OR_NON_CHRONOLOGICAL_CYCLE', brokerCalls: 0 };
  if (now >= stamp(state.protocol.evaluationUntil)) return { state, status: 'EVALUATION_WINDOW_CLOSED', brokerCalls: 0 };
  const phase = now < stamp(state.protocol.designUntil) ? 'DESIGN' : 'EVALUATION';
  const quotes = safeQuotes(input.quotes, now, a.quoteMaxAgeMs), observed = observerAt(input.observerView, input.observerState, now);
  if (!state.phases[phase]) state.phases[phase] = { startAt: iso(now), cycles: 0, differences: 0, commonComplete: 0, flowIds: [], fullClosures: { strategy: 0, baseline: 0 }, reductions: { strategy: 0, baseline: 0 },
    strategy: seedBook(state.protocol.template, now, assumptions), baseline: seedBook(state.protocol.template, now, assumptions) };
  const pair = state.phases[phase];
  state.readWatermarks ||= {};
  let newlyObservedReadResponses = 0;
  for (const trader of input.observerView?.traders || []) {
    const channels = ['identity', 'portfolio', 'performance', 'tradeStats', 'identityConfirmation'];
    const readGroups = [trader.snapshot?.reads || {}, Object.fromEntries((trader.lastAttempt?.reads || []).map((r, i) => [channels[i] || 'unknown', r]))];
    for (const group of readGroups) for (const [kind, read] of Object.entries(group)) {
      if (!channels.includes(kind)) continue;
      const key = `${trader.realCID}:${kind}`;
      const at = stamp(read?.collectedAt);
      if (Number.isInteger(read?.httpStatus) && read.httpStatus >= 100 && read.httpStatus <= 599 && at !== null && at >= stamp(state.protocol.registeredAt) && at <= now && at > (state.readWatermarks[key] ?? -Infinity)) {
        newlyObservedReadResponses++; state.readWatermarks[key] = at;
      }
    }
  }
  state.observedUpstreamResponses = (state.observedUpstreamResponses || 0) + newlyObservedReadResponses;
  mark(pair.strategy, quotes, now); mark(pair.baseline, quotes, now);
  const symbol = typeof rawDecision.asset === 'string' && /^[A-Z0-9.:-]{1,32}$/.test(rawDecision.asset) ? rawDecision.asset : 'NONE';
  const item = universe.filter(r => r.symbol === symbol);
  const instrumentId = item.length === 1 ? item[0].instrumentId : null;
  const side = ['BUY', 'SELL'].includes(rawDecision.decision) ? rawDecision.decision : 'HOLD';
  const cutoffId = digest({ phase, now, side, symbol, specId });
  const pick = (row, fields) => row ? Object.fromEntries(fields.map(k => [k, typeof row[k] === 'boolean' || typeof row[k] === 'number' && Number.isFinite(row[k]) || typeof row[k] === 'string' && /^[A-Za-z0-9_.:% -]{1,120}$/.test(row[k]) ? row[k] : null])) : null;
  const frozen = { id: cutoffId, cycleId: input.cycleId, at: iso(now), phase, policyVersion: a.version, policyId: digest(a), protocolId: specId,
    raw: { side, asset: symbol, instrumentId, amountUsd: number(rawDecision.amount_usd) },
    leoFinal: { side: ['BUY', 'SELL', 'HOLD'].includes(control.finalDecision?.decision) ? control.finalDecision.decision : 'HOLD',
      approved: control.approved === true, amountUsd: number(control.finalDecision?.amount_usd), code: typeof control.code === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(control.code) ? control.code : null },
    eligibility: pick(eligibility[instrumentId], ['instrumentId', 'side', 'asOf', 'receivedAt', 'technicalStatus', 'technicalEligible', 'leoPolicyAllowed', 'minimumUsd', 'maximumUsd', 'currency', 'leverage', 'orderType', 'settlementType', 'contextBinding']),
    costs: pick(costs[instrumentId], ['instrumentId', 'side', 'asOf', 'receivedAt', 'amountUsd', 'currency', 'coverage', 'allInCostPct', 'contextBinding', 'estimatedFeePct', 'estimatedSlippageBps']),
    unknownCostComponents: ['BROKER_FEES_NOT_OBSERVED', 'FX', 'TAXES', 'MARKET_IMPACT', 'INFRASTRUCTURE_AND_UPSTREAM_COLLECTION'],
    realExposure: pick(realExposure, ['coverage', 'fetchedAt', 'pendingStatus', 'knownUnreconstructedRiskCount', 'knownUnresolvedPositionRowsCount']), quote: structuredClone(quotes[symbol] || null),
    observations: observed.view.traders.map(t => ({ traderId: t.realCID, observationId: t.observationId, receivedAt: t.snapshot?.receivedAt || t.lastAttempt?.completedAt || t.snapshot?.collectedAt || null,
      receivedAtBasis: 'COLLECTION_COMPLETION_NOT_PUBLICATION', publishedAt: stamp(t.snapshot?.publishedAt) === null ? null : t.snapshot.publishedAt,
      sourceEffectiveAt: stamp(t.snapshot?.effectiveAt) === null ? null : t.snapshot.effectiveAt,
      availabilityStatus: ['AVAILABLE', 'PARTIAL', 'STALE', 'PRIVATE', 'UNAVAILABLE'].includes(t.status) ? t.status : 'UNAVAILABLE',
      historicalSnapshot: t.historicalSnapshot === true, portfolioCoverageComplete: typeof t.snapshot?.portfolio?.complete === 'boolean' ? t.snapshot.portfolio.complete : null,
      proof: 'PARTIAL_PUBLIC_POSITION_PRESENCE_NOT_TRANSACTION', source: t.snapshot?.sources?.portfolio || null })),
    additionalCalls: { providers: 0, ai: 0, brokerExecution: 0 }, newlyObservedUpstreamReadResponses: newlyObservedReadResponses,
    sharedLeoAiCostUsd: number(extraAiCostUsd), extraInfrastructureCostUsd: null, arms: {} };
  const receiptFuture = [costs[instrumentId]?.asOf, costs[instrumentId]?.receivedAt, eligibility[instrumentId]?.asOf, eligibility[instrumentId]?.receivedAt, constraintsEvidence?.asOf, constraintsEvidence?.receivedAt].some(t => stamp(t) !== null && stamp(t) > now);
  let nextAdvisoryState;
  for (const arm of ['strategy', 'baseline']) {
    const book = pair[arm], exposure = virtualExposure(book, universe, quotes, now, input.pendingComplete === true);
    const target = exposure.owned.rows.find(r => r.instrumentId === instrumentId);
    const q = quotes[symbol];
    const ideas = instrumentId && side !== 'HOLD' ? [{ instrumentId, side, amountUsd: number(control.finalDecision?.amount_usd) ?? number(rawDecision.amount_usd),
      asOf: iso(now), ownAnalysisApproved: control.approved === true && control.finalDecision?.decision === side && control.finalDecision?.asset === symbol,
      hardVeto: control.approved !== true, referencePrice: q?.mid ?? null, positionId: target?.positionId || null, exitExplicit: input.exitExplicit === true }] : [];
    const sized = constraintsEvidence?.lookThroughCoverage === 'COMPLETE' && constraintsEvidence?.virtualOnly === true && exposure.owned.coverage === 'COMPLETE' ? {
      ...constraintsEvidence, equityUsd: book.snapshots.at(-1).equity, availableCashUsd: book.cash, sourceType: 'VIRTUAL_SHADOW_LEDGER', sourceUrl: 'local:shadow-ledger' } : null;
    const result = advisory.evaluate({ state: state.advisoryState, observerView: observed.view, observerState: observed.state, ideas, exposure, quotes: instrumentId ? { [instrumentId]: { instrumentId, mid: q?.mid ?? null, asOf: q?.date, currency: 'USD' } } : {},
      costs, eligibility, sizingEvidence: sized, overrides: advisoryOverrides, now });
    if (arm === 'strategy') nextAdvisoryState = result.state;
    frozen.selection = structuredClone(result.report.selection);
    const proposal = result.report.proposals[0];
    let vetoes = proposal ? proposal.vetoes.filter(v => arm === 'strategy' || !SOURCE_VETOES.has(v)) : side === 'HOLD' ? ['LEO_HOLD'] : ['INSTRUMENT_NOT_IDENTIFIED'];
    if (receiptFuture) vetoes = [...vetoes, 'EVIDENCE_RECEIVED_AFTER_DECISION'];
    // Cost/eligibility evidence refers to an intended size: each arm must bind it to its own size.
    const units = target ? (input.exitExplicit === true ? target.units : target.units * a.reductionFraction) : null;
    const draft = proposal?.draft || (side === 'BUY' && number(ideas[0]?.amountUsd) !== null && ideas[0].amountUsd > 0 ? { amount: Math.min(a.maxOrderUsd, ideas[0].amountUsd) } : null);
    const finalSide = vetoes.length ? 'HOLD' : side;
    const fill = finalSide !== 'HOLD' ? virtualFill(book, { asset: symbol, side, amount: draft?.amount, units: side === 'SELL' ? units : undefined }, q,
      { now, orderId: digest({ cutoffId, arm }), feePct: assumptions.feePct, slippageBps: assumptions.slippageBps, tradable: q?.eligibleForTrade === true, allowReinforcement: true }) : { paper: book, result: { skipped: true, reason: 'VETO_OR_HOLD', simulated: true, executionAttempted: false } };
    pair[arm] = fill.paper;
    if (fill.result.ok && side === 'SELL') {
      if (fill.result.fullyClosed) pair.fullClosures[arm]++;
      else pair.reductions[arm]++;
    }
    pair[arm].decisions.unshift({ id: cutoffId, time: iso(now), status: fill.result.ok ? 'SIMULATED' : 'VETOED', proposed: { decision: side }, final: { decision: fill.result.ok ? side : 'HOLD' }, vetoReason: vetoes.join(';') || fill.result.reason || null });
    mark(pair[arm], quotes, now);
    frozen.arms[arm] = { proposal: proposal ? { action: proposal.action, traderSources: arm === 'strategy' ? proposal.traderSources : [], priceDriftPct: proposal.decisionPriceDriftPct } : null,
      exposureBefore: { virtualOnly: true, valuesByInstrument: exposure.owned.knownValuesByInstrument, coverage: exposure.owned.coverage, pendingStatus: exposure.pending.status },
      lookThroughCoverage: constraintsEvidence?.lookThroughCoverage || 'UNAVAILABLE',
      final: fill.result.ok ? side : 'HOLD', vetoes: [...new Set(vetoes)].sort(), simulation: structuredClone(fill.result) };
  }
  state.advisoryState = nextAdvisoryState;
  // Paired flows are explicit and apply to both arms; an unaffordable withdrawal is rejected for both.
  if (flow) applyPairFlow(pair, flow, quotes, now);
  pair.cycles++; pair.lastAt = iso(now);
  if (frozen.arms.strategy.final !== frozen.arms.baseline.final) pair.differences++;
  if (frozen.arms.baseline.vetoes.length === 0 || side === 'HOLD') pair.commonComplete++;
  state.records.push(frozen); state.processedCycleIds.push(input.cycleId); state.lastAt = iso(now);
  // Never forget processed cycle identifiers to make room for new fills: archive/stop instead.
  if (state.records.length > p.maxRecords) { state.records = state.records.slice(-p.maxRecords); state.historyTruncated = true; }
  for (const book of [pair.strategy, pair.baseline]) {
    if (book.snapshots.length > p.maxRecords) { book.snapshots = book.snapshots.slice(-p.maxRecords); book.snapshotHistoryComplete = false; }
    if (book.orders.length > p.maxRecords || book.closedTrades.length > p.maxRecords) book.activityHistoryComplete = false;
    book.orders = book.orders.slice(0, p.maxRecords); book.closedTrades = book.closedTrades.slice(0, p.maxRecords); book.decisions = book.decisions.slice(0, p.maxRecords);
  }
  return { state, status: 'RECORDED_VIRTUAL_PAIR', recordId: cutoffId, phase, brokerCalls: 0 };
}
function applyPairFlow(pair, flow, quotes, now) {
  if (typeof flow.id !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(flow.id) || !['DEPOSIT', 'WITHDRAWAL'].includes(flow.type) || number(flow.amount) === null || flow.amount <= 0 || flow.currency !== 'USD') throw Error('INVALID_PAIRED_FLOW');
  if (pair.flowIds.includes(flow.id)) {
    const prior = pair.strategy.cashFlows.find(f => f.id === flow.id);
    if (!prior || prior.amount !== flow.amount || prior.type !== flow.type) throw Error('CONFLICTING_PAIRED_FLOW');
    return 'DUPLICATE_FLOW';
  }
  const signedAmount = flow.type === 'DEPOSIT' ? flow.amount : -flow.amount;
  if (signedAmount < 0 && ['strategy', 'baseline'].some(arm => pair[arm].cash < -signedAmount)) throw Error('PAIRED_WITHDRAWAL_INSUFFICIENT_CASH');
  for (const arm of ['strategy', 'baseline']) {
    const book = pair[arm]; mark(book, quotes, now);
    const complete = book.snapshots.at(-1)?.valuationComplete === true;
    book.cash += signedAmount; book.cashFlows.push({ id: flow.id, time: iso(now), type: flow.type, amount: flow.amount, signedAmount, currency: 'USD', valuationComplete: complete });
    mark(book, quotes, now);
  }
  pair.flowIds.push(flow.id);
  return 'PAIRED_FLOW_RECORDED';
}
function applyFlow(input) {
  const { now, flow, quotes, mode } = input;
  const state = structuredClone(input.state || emptyState());
  if (mode !== 'SHADOW' || !state.protocol || state.disabledReason) return { state, status: 'NO_ACTIVE_SHADOW_EXPERIMENT' };
  if (number(now) === null || stamp(state.lastAt) !== null && now < stamp(state.lastAt)) throw Error('NON_CHRONOLOGICAL_FLOW');
  const phase = now < stamp(state.protocol.designUntil) ? 'DESIGN' : 'EVALUATION';
  if (!state.phases[phase] || now >= stamp(state.protocol.evaluationUntil)) {
    state.flowCoverageIncomplete = true;
    for (const pair of Object.values(state.phases)) for (const arm of ['strategy', 'baseline']) pair[arm].cashFlowHistoryComplete = false;
    return { state, status: 'FLOW_OUTSIDE_INITIALIZED_COHORT' };
  }
  const status = applyPairFlow(state.phases[phase], flow, safeQuotes(quotes, now, state.protocol.spec.advisory.quoteMaxAgeMs), now);
  state.lastAt = iso(now); state.phases[phase].lastAt = iso(now);
  return { state, status };
}
function report(state = emptyState()) {
  const phases = {};
  for (const [name, pair] of Object.entries(state.phases)) {
    const strategy = buildPaperShadowScorecard(pair.strategy), baseline = buildPaperShadowScorecard(pair.baseline);
    const reasons = [];
    if (name !== 'EVALUATION') reasons.push('DESIGN_PERIOD_NOT_OUT_OF_SAMPLE');
    if (pair.cycles < state.protocol.spec.experiment.minimumDecisions) reasons.push('INSUFFICIENT_DECISIONS');
    const fullClosures = pair.fullClosures;
    if (Object.values(fullClosures).some(n => n < state.protocol.spec.experiment.minimumFullClosures)) reasons.push('INSUFFICIENT_FULL_CLOSURES');
    if (pair.commonComplete < pair.cycles) reasons.push('COMMON_DATA_OR_CONSTRAINTS_INCOMPLETE');
    if (state.flowCoverageIncomplete) reasons.push('PAIRED_FLOW_COVERAGE_INCOMPLETE');
    if (state.failedCycles || state.invalidProtocolAttempts) reasons.push('DECISION_OR_FROZEN_PROTOCOL_COVERAGE_INCOMPLETE');
    if (strategy.dataCoverage?.status !== 'COMPLETE' || baseline.dataCoverage?.status !== 'COMPLETE') reasons.push('VALUATION_FLOW_OR_SAMPLE_COVERAGE_INCOMPLETE');
    if (state.historyTruncated || pair.strategy.snapshotHistoryComplete === false || pair.baseline.snapshotHistoryComplete === false || pair.strategy.activityHistoryComplete === false || pair.baseline.activityHistoryComplete === false) reasons.push('RETAINED_HISTORY_TRUNCATED');
    if (!pair.differences) reasons.push('NO_DIFFERING_DECISIONS_YET');
    const durationDays = (stamp(pair.lastAt) - stamp(pair.startAt)) / DAY;
    if (name === 'EVALUATION' && durationDays < state.protocol.spec.experiment.minimumEvaluationDays) reasons.push('INSUFFICIENT_PREDECLARED_EVALUATION_DURATION');
    phases[name] = { startAt: pair.startAt, lastAt: pair.lastAt, durationDays, decisions: pair.cycles, differingDecisions: pair.differences,
      completeCommonDecisionCount: pair.commonComplete, fullClosures, reductions: pair.reductions,
      strategy, baseline, comparison: { status: reasons.length ? 'UNAVAILABLE_RELIABLE_COMPARISON' : 'DESCRIPTIVE_CONDITIONAL_COMPARISON', reasons,
        flowAdjustedDifferencePct: reasons.length ? null : strategy.return.flowAdjusted.returnPct - baseline.return.flowAdjusted.returnPct,
        basis: 'PAIRED_SHARED_LEO_IDEAS_NOT_INDEPENDENT_AI_FEEDBACK_OR_CAUSAL_ALPHA', significance: 'NOT_ESTIMATED' } };
  }
  return { version: VERSION, virtualOnly: true, executionAllowed: false, protocol: state.protocol ? { ...state.protocol, template: undefined } : null, phases,
    retainedRecords: state.records.length, historyTruncated: state.historyTruncated, disabledReason: state.disabledReason,
    failedCycles: state.failedCycles || 0, invalidProtocolAttempts: state.invalidProtocolAttempts || 0,
    additionalCalls: { provider: 0, ai: 0, brokerExecution: 0 }, additionalProviderCostUsd: 0, additionalAiCostUsd: 0, additionalInfrastructureCostUsd: null,
    upstreamObserverCallsAndCost: { knownReadResponses: state.observedUpstreamResponses || 0, coverage: 'PARTIAL_CURRENT_SUMMARIES_ONLY', causalAdditionalCalls: null, costUsd: null },
    storageCalls: 'SHARED_DEBOUNCED_PERSISTENCE_NOT_SEPARATELY_ATTRIBUTED',
    limitations: ['CONDITIONAL_SHARED_ANALYSIS_AND_RISK_CONTEXT', 'PUBLIC_POSITIONS_NOT_TRANSACTIONS', 'UNKNOWN_REAL_COSTS_NOT_ZERO', 'BOUNDED_RETENTION_REQUIRES_ARCHIVE', 'VIRTUAL_RESULTS_NOT_FUTURE_PERFORMANCE_PROOF'] };
}
function compact(state, maxBytes = 90000) {
  const copy = structuredClone(state || emptyState());
  copy.advisoryState = advisory.compactState(copy.advisoryState, Math.max(1000, Math.min(12000, maxBytes / 4)));
  while (Buffer.byteLength(JSON.stringify(copy)) > maxBytes && copy.records.length) { copy.records.shift(); copy.historyTruncated = true; }
  if (Buffer.byteLength(JSON.stringify(copy)) > maxBytes) return { ...emptyState(), protocol: copy.protocol ? { ...copy.protocol, template: { cash: null } } : null,
    historyTruncated: true, lastAt: copy.lastAt, disabledReason: 'ARCHIVE_REQUIRED_BUDGET_EXCEEDED_NO_AUTOMATIC_RESET' };
  return copy;
}
module.exports = { VERSION, DEFAULTS, emptyState, protocolConfig, runCycle, applyFlow, report, compact, observerAt, quoteAt };
