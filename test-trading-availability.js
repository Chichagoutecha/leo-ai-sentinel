'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const availability = require('./trading-availability');
const b = require('./trader-execution-bridge');
const f = require('./activation-review-fixtures');
const source = fs.readFileSync(require.resolve('./index'), 'utf8');
function managed() {
  const state = f.initialized(); state.managed['101'] = { ...f.row(), accountRef: 'fixture-account', status: 'VERIFIED_MANAGED' }; return state;
}
function exitEvidence() { return f.evidence(f.sell(), [f.row()]); }
function riskHarness() {
  const ok = () => ({ ok: true, reason: 'SYNTHETIC_OK', multiplier: 1 });
  const state = { orderIntents: {} };
  Object.defineProperty(state, 'traderObserver', { get() { throw Error('OBSERVER_NOT_A_NORMAL_RISK_DEPENDENCY'); } });
  const sandbox = { tradingAvailability: availability, sanitizeDecision: d => ({ ...d }), extractPortfolioSummary: p => p,
    getExecutionStats24h: () => ({ total: 0, buys: 0, sells: 0, hoursSinceLastExecution: null }), runtimeState: state,
    LIVE_TRADING_ENABLED: true, DEMO_TRADING_ENABLED: false, PAPER_TRADING_ENABLED: false,
    isActiveExecutionStatus: s => s !== 'CONFIRMED', WATCHLIST: { TEST: 1 }, ASSET_RULES: { TEST: { sellThreshold: 70, category: 'STOCK' } },
    TRADE_ALLOWED_ASSETS: new Set(['TEST']), TRADE_ALLOWED_CATEGORIES: new Set(['STOCK']), classifyAsset: () => 'STOCK',
    isMarketRateTradable: ok, dataIntegrityCheckForAsset: ok, technicalCheckForAsset: ok, intelligenceCheckForAsset: ok,
    macroCreditCheckForDecision: ok, councilCheckForDecision: ok, riskSellCheckForDecision: ok, getTrendForAsset: () => ({}),
    MAX_EXECUTED_ORDERS_24H: 4, MIN_HOURS_BETWEEN_EXECUTIONS: 2, MAX_BUYS_24H: 3, MAX_SELLS_24H: 2, hasOpenPosition: () => true };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function riskController('), source.indexOf('async function executeDemoBuy(')), sandbox);
  return sandbox;
}
test('every bridge veto and every normal risk hold has a classified stable cause', () => {
  const bridge = fs.readFileSync(require.resolve('./trader-execution-bridge'), 'utf8');
  const codes = [...bridge.matchAll(/vetoes\.push\('([^']+)'\)/g)].map(x => x[1]);
  const risk = source.slice(source.indexOf('function riskController('), source.indexOf('async function executeDemoBuy('));
  const normal = [...risk.matchAll(/"failed", "([A-Z_]+)"/g)].map(x => x[1]);
  assert.ok(codes.length > 20 && normal.length > 20);
  for (const code of [...codes, ...normal]) { assert.ok(availability.CATALOG[code], code); assert.equal(availability.describeVeto(code).automaticOrderRetryAllowed, false); }
});
test('structured reasons are conservative, bounded and cannot grant rights or echo unknown errors', () => {
  const quote = availability.describeVeto('QUOTE_STALE_OR_INVALID', { side: 'BUY', asset: 'TEST', instrumentId: 1 });
  assert.equal(quote.scope, 'INSTRUMENT'); assert.equal(quote.otherTargetsMayBeEvaluated, true);
  const cash = availability.describeVeto('CASH_OR_RESERVE_UNAVAILABLE');
  assert.ok(cash.otherActionsMayBeEvaluated.includes('CLOSE'));
  const identity = availability.describeVeto('ACCOUNT_OR_TOKEN_BINDING_UNVERIFIED');
  assert.equal(identity.scope, 'ACCOUNT'); assert.deepEqual(identity.otherActionsMayBeEvaluated, []);
  const unknown = availability.describeVeto('SECRET_MUST_NOT_LEAK');
  assert.equal(unknown.code, 'UNCLASSIFIED_VETO'); assert.equal(unknown.reviewRequired, true);
  assert.ok(!JSON.stringify(unknown).includes('SECRET_MUST_NOT_LEAK'));
  assert.ok(!availability.requirements('SELL').includes('CASH_AND_RESERVE'));
  assert.ok(availability.requirements('BUY').includes('MARGINAL_EXPOSURE'));
});
test('exact managed close does not need entry cash, source visibility, aggregate diversification or BUY arming', async () => {
  const h = f.harness({ state: managed(), positions: [f.row()], configure: { ...f.settings(), entriesEnabled: false }, mutate: e => {
    e.sourceProof = null; e.exposure = null; e.cashUsd = null; e.reserveUsd = null; e.buyArmed = false; e.eligibility.minimumUsd = null; e.eligibility.maximumUsd = null;
  } });
  h.queue(f.sell()); assert.equal((await h.controller.drain()).status, 'CONFIRMED'); assert.equal(h.calls.length, 1);
  const operation = h.state.operations['exit-1']; assert.ok(!Object.hasOwn(operation.checks, 'source'));
  assert.equal(operation.availabilityNotes.length, 2);
  assert.deepEqual(h.state.managed, {});
});
test('same missing entry evidence still blocks BUY and reinforcement with explicit scope', async () => {
  const h = f.harness({ mutate: e => { e.sourceProof = null; e.exposure = null; e.cashUsd = null; } }); h.queue(f.buy());
  const r = await h.controller.drain(); assert.equal(r.status, 'VETOED'); assert.equal(h.calls.length, 0);
  for (const code of ['SOURCE_REFERENCES_INVALID_OR_OPPOSED', 'MARGINAL_EXPOSURE_UNKNOWN_OR_EXCESS', 'CASH_OR_RESERVE_UNAVAILABLE']) assert.ok(r.vetoes.includes(code));
  assert.ok(r.vetoDetails.every(v => v.executionPermissionGranted === false));
  assert.deepEqual(h.state.operations['proposal-1'].vetoes.map(code => availability.describeVeto(code, f.buy())), r.vetoDetails);
});
test('a local quote veto does not quarantine another instrument, and review does not queue a retry', () => {
  const state = f.initialized(), p = f.buy(), e = f.evidence(p); e.quote.asOf = '2020-01-01';
  assert.ok(b.preflight(state, p, e, f.settings(), f.NOW).includes('QUOTE_STALE_OR_INVALID'));
  const other = { ...f.buy('other'), instrumentId: 2, asset: 'OTHER' }, oe = f.evidence(other);
  oe.instrument = { asset: 'OTHER', instrumentId: 2, allowed: true }; oe.quote.instrumentId = 2;
  oe.closeTerms.instrumentId = 2; oe.cost.instrumentId = 2; oe.eligibility.instrumentId = 2; oe.risk.instrumentId = 2;
  state.operations[p.proposalId] = { status: 'VETOED', proposal: p };
  assert.deepEqual(b.preflight(state, other, oe, f.settings(), f.NOW), []);
  assert.equal(state.queue.length, 0);
});
test('an unmanaged or copied sibling position cannot block exact managed close or be targeted instead', () => {
  const state = managed(), p = f.sell(), e = exitEvidence();
  const personal = f.row(3, '202'), copy = { ...f.row(2, '303'), ownership: 'NATIVE_COPY' };
  e.positions.push(personal, copy); assert.deepEqual(b.preflight(state, p, e, f.settings(), f.NOW), []);
  state.operations[p.proposalId] = { proposal: p, status: 'RESERVED', accountRef: 'fixture-account', reservedAt: p.createdAt, checks: { portfolio: p.createdAt, quote: p.createdAt } };
  assert.equal(b.guardExecutor(state, { operationId: p.proposalId, proposalId: p.proposalId }, e.positions, 'fixture-account', f.NOW), true);
  for (const id of ['202', '303']) assert.ok(b.preflight(managed(), { ...p, positionId: id }, e, f.settings(), f.NOW).includes('EXACT_MANAGED_FULL_POSITION_SCOPE_UNVERIFIED'));
  assert.ok(b.preflight(managed(), f.buy(), f.evidence(f.buy(), e.positions), f.settings(), f.NOW).includes('UNMANAGED_OR_COPY_POSITION_ON_INSTRUMENT'));
});
test('account uncertainty, stale prices, incoherent positions, pending orders and exact-close failures still stop SELL', () => {
  const changes = [e => { e.tokenBindingVerified = false; }, e => { e.identityVerified = false; }, e => { e.portfolioComplete = false; },
    e => { e.pendingComplete = false; }, e => { e.uncertainOrPending = true; }, e => { e.positions.push(f.row()); },
    e => { e.quote.asOf = '2020-01-01'; }, e => { e.positions[0].units = 2; }, e => { e.positions[0].leverage = 2; },
    e => { e.positions[0].settlementType = 'CFD'; }, e => { e.positions[0].isBuy = false; }, e => { e.cost = null; },
    e => { e.risk.approved = false; }, e => { e.exposure.units = 2; }, e => { e.limits.singleWriterVerified = false; }];
  for (const change of changes) { const e = exitEvidence(); change(e); assert.ok(b.preflight(managed(), f.sell(), e, f.settings(), f.NOW).length > 0); }
  const state = managed(); state.operations.old = { status: 'NEEDS_RECONCILIATION' };
  assert.ok(b.preflight(state, f.sell(), exitEvidence(), f.settings(), f.NOW).includes('PENDING_OR_UNCERTAIN_OPERATION'));
});
test('normal SELL risk path is independent of entry budget, observer and benchmark, with no BUY analysis required', () => {
  const h = riskHarness(), d = { decision: 'SELL', asset: 'TEST', confidence: 90, risk_check: 'passed' };
  const agents = { healthAgent: { circuitBreakerOpen: false }, riskBudgetAgent: { newBuyBlocked: true, blocks: ['CASH'] } };
  const result = h.riskController(d, { availableCash: null }, { benchmark: null }, {}, agents);
  assert.equal(result.approved, true);
  const buy = h.riskController({ ...d, decision: 'BUY' }, {}, {}, {}, agents);
  assert.equal(buy.approved, false); assert.equal(buy.vetoDetails[0].code, 'RISK_BUDGET_ENTRY_VETO');
  h.runtimeState.orderIntents.unknown = { mode: 'LIVE', status: 'UNCERTAIN' };
  const blocked = h.riskController(d, {}, {}, {}, agents);
  assert.equal(blocked.vetoDetails[0].code, 'UNRESOLVED_LIVE_INTENTS'); assert.equal(blocked.vetoDetails[0].scope, 'ACCOUNT');
});
test('normal BUY analysis can approve independently with complete simulated constraints and no benchmark or social service', () => {
  const h = riskHarness();
  Object.assign(h, { ASSET_RULES: { TEST: { sellThreshold: 70, buyThreshold: 70, category: 'STOCK' } },
    getProgressiveOrderPolicy: () => ({ maximumOrderUsd: 10, minimumExecutableVirtualOrderUsd: 1 }), LIVE_BUY_MAX_ORDER_USD: 10,
    allocationCheckForBuy: () => ({ ok: true, reason: 'SYNTHETIC_ALLOCATION' }), PORTFOLIO_ALLOCATION_MODE: 'enforced',
    dynamicBuyAmount: () => 5, technicalSizingMultiplier: () => 1, intelligenceSizingMultiplier: () => 1,
    combineBuySizingMultipliers: () => ({ combinedMultiplier: 1, method: 'SYNTHETIC' }), roundNumber: x => x,
    MIN_ORDER_USD: 1, MAX_OPEN_POSITIONS: 12, hasOpenPosition: () => false, hasOpenOrder: () => false, isInCooldown: () => false });
  const market = {}; Object.defineProperty(market, 'benchmark', { get() { throw Error('BENCHMARK_ANALYTICS_ONLY'); } });
  const result = h.riskController({ decision: 'BUY', asset: 'TEST', confidence: 85, risk_check: 'passed' },
    { availableCash: 1000, uniquePositionsCount: 0, ordersForOpenCount: 0 }, market, {}, { healthAgent: { circuitBreakerOpen: false } });
  assert.equal(result.approved, true); assert.equal(result.finalDecision.amount_usd, 5);
});
test('normal buy policy exposes structured reasons without changing its allow decision', () => {
  const p = require('./trade-universe-policy').evaluateBuyPolicy({ mode: 'LIVE', quoteFresh: false, duplicateOrPending: true });
  assert.equal(p.allowed, false); assert.equal(p.blockers.length, p.blockerDetails.length);
  for (const d of p.blockerDetails) assert.notEqual(d.code, 'UNCLASSIFIED_VETO');
  assert.equal(p.blockerDetails.find(d => d.code === 'DUPLICATE_OR_PENDING_ORDER').reviewRequired, true);
});
test('cache-only trader evaluation errors remain distinct from dispatch uncertainty', async () => {
  const block = source.slice(source.indexOf('async function processTraderExecution('), source.indexOf('async function executeControlledDecision('));
  let drains = 0;
  const sandbox = { tradingAvailability: availability, runtimeState: { traderExecutionBridge: { managed: {} } }, traderExecutionContext: null, evaluateAutomaticTraderProposals() { throw Error('SECRET_NO_OUTPUT'); },
    traderExecutionController: { async drain() { drains++; throw Error('SUBMISSION_MAY_HAVE_HAPPENED'); } } };
  vm.createContext(sandbox); vm.runInContext(block, sandbox);
  const control = { approved: true, finalDecision: { decision: 'SELL' } };
  const result = await sandbox.processTraderExecution({}, control);
  assert.equal(result.executionAttempted, false); assert.equal(drains, 0); assert.equal(result.vetoDetails[0].scope, 'STRATEGY');
  assert.equal(sandbox.traderExecutionContext, null); assert.ok(!JSON.stringify(result).includes('SECRET_NO_OUTPUT'));
  sandbox.evaluateAutomaticTraderProposals = () => {};
  await assert.rejects(() => sandbox.processTraderExecution({}, control), /SUBMISSION_MAY_HAVE_HAPPENED/);
  assert.equal(drains, 1); assert.equal(sandbox.traderExecutionContext, null);
});
test('automatic managed SELL preserves historical source provenance without consulting trader visibility or entry sizing', () => {
  const advisory = require('./trader-advisory-policy'), { digest } = require('./trader-observer');
  const state = managed(); state.managed['101'].traderSources = f.buy().traderSources;
  const sandbox = { runtimeState: { traderExecutionBridge: state }, WATCHLIST: { AAPL: 1 }, ASSET_RULES: {}, CONFIGURED_UNIVERSE_CANDIDATES: [],
    buildUniverse: () => [{ symbol: 'AAPL', instrumentId: 1 }], currentTraderExposureView: () => ({ owned: { rows: [f.row()] } }),
    traderExecution: b, traderAdvisory: advisory, publicDataDigest: digest, process: { env: {} }, scheduleSave() {},
    traderObserver: { view() { throw Error('TRADER_VISIBILITY_NOT_REQUIRED_FOR_MANAGED_CLOSE'); } } };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function evaluateAutomaticTraderProposals('), source.indexOf('function prepareTraderExecutionEvidence(')), sandbox);
  const context = { realPortfolio: {}, marketSummary: { ratesByAsset: { AAPL: { mid: 10 } } } };
  const control = { approved: true, finalDecision: { decision: 'SELL', asset: 'AAPL', confidence: 85 } };
  assert.equal(sandbox.evaluateAutomaticTraderProposals(context, control, f.NOW).managedExitProposed, true);
  const candidate = sandbox.runtimeState.traderExecutionBridge.queue[0];
  assert.equal(candidate.positionId, '101'); assert.equal(candidate.policyId, digest(advisory.config({})));
  assert.deepEqual(candidate.traderSources, state.managed['101'].traderSources);
  assert.equal(candidate.quantityMode, 'FULL_POSITION'); assert.equal(candidate.decision, 'ADVISORY_REVIEW_ONLY');
  const incomplete = { ...exitEvidence(), sourceProof: null, exposure: null };
  incomplete.closeTerms.proposalId = candidate.proposalId; incomplete.risk.proposalId = candidate.proposalId; incomplete.release.policyId = candidate.policyId;
  assert.deepEqual(b.preflight(state, candidate, incomplete, f.settings(), f.NOW), []);
  sandbox.currentTraderExposureView = () => ({ owned: { rows: [] } });
  assert.equal(sandbox.evaluateAutomaticTraderProposals(context, control, f.NOW).candidateUnavailable, true);
  assert.match(source, /!traderExecutionResult\?\.managedExitProposed/);
});
