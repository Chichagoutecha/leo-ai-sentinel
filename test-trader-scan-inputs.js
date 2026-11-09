'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const scan = require('./trader-scan-inputs');
const advisory = require('./trader-advisory-policy');
const readiness = require('./trader-runtime-readiness');
const bridge = require('./trader-execution-bridge');
const f = require('./activation-shadow-fixture');

function fixture() {
  const input = f.fixture();
  const state = advisory.initialState();
  state.roster[7] = { traderId: 7, gcid: 8, state: 'SELECTED_CONTEXT_ONLY', since: f.iso(input.now - f.DAY),
    qualifyingIds: [input.observerView.traders[0].observationId], qualificationStartedAt: f.iso(input.now - 8 * f.DAY) };
  let refreshCalls = 0;
  const observer = { view: () => input.observerView, refreshForScan: async () => { refreshCalls++; return { status: 'PARTIAL' }; } };
  return { input, options: { observer, state, observerState: input.observerState, universe: input.universe,
    allowedAssets: ['AAPL', 'SPY'], allowedCategories: ['STOCK', 'ETF'], quotes: input.quotes, clock: () => input.now },
    refreshCalls: () => refreshCalls };
}

test('current selected holdings become research candidates before a LEO idea, without execution authority', async () => {
  const f = fixture();
  f.input.observerView.traders[0].snapshot.portfolio.positions.push({ ...f.input.observerView.traders[0].snapshot.portfolio.positions[0] });
  const a = await scan.prepare(f.options), b = await scan.prepare(f.options);
  assert.deepEqual(a, b);
  assert.equal(a.input.candidates.length, 1);
  assert.equal(a.input.candidates[0].asset, 'AAPL');
  assert.equal(a.input.candidates[0].transactionProven, false);
  assert.equal(a.input.candidates[0].traderSources.length, 1);
  assert.equal(a.input.executionAllowed, false);
  assert.equal(a.input.candidates[0].sourceIndependence, 'UNVERIFIED');
});

test('unselected, late, stale, forbidden and ambiguous data never authorize a research candidate', async () => {
  const changes = [
    f => { f.options.state = advisory.initialState(); },
    f => { f.input.observerView.traders[0].snapshot.receivedAt = new Date(f.input.now + 1).toISOString(); },
    f => { f.input.observerView.traders[0].snapshot.collectedAt = new Date(f.input.now - 3600000).toISOString(); },
    f => { f.input.observerView.traders[0].status = 'UNAVAILABLE'; },
    f => { f.options.allowedAssets = ['SPY']; },
    f => { f.options.universe.push({ instrumentId: 1, symbol: 'OTHER', category: 'STOCK' }); },
    f => { delete f.input.quotes.AAPL; },
    f => { f.input.quotes.AAPL.date = new Date(f.input.now - 3600000).toISOString(); }
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    assert.equal((await scan.prepare(f.options)).input.candidates.length, 0);
  }
});

test('opposing source holdings veto an instrument regardless of source order or number of supporters', async () => {
  const f = fixture(), original = f.input.observerView.traders[0];
  const opposite = structuredClone(original);
  opposite.realCID = 9; opposite.snapshot.realCID = 9; opposite.snapshot.identity.realCID = 9; opposite.snapshot.identity.gcid = 10;
  opposite.snapshot.portfolio.positions[0].isBuy = false;
  f.input.observerView.traders.push(opposite);
  f.options.state.roster[9] = { ...f.options.state.roster[7], traderId: 9, gcid: 10 };
  assert.equal((await scan.prepare(f.options)).input.candidates.length, 0);
  f.input.observerView.traders.reverse();
  assert.equal((await scan.prepare(f.options)).input.candidates.length, 0);
});

test('a scan collects due traders in bounded order while failures preserve independent priorities', async () => {
  const f = fixture(), calls = [];
  const second = structuredClone(f.input.observerView.traders[0]); second.realCID = 9;
  second.lastAttempt = { at: new Date(f.input.now - 3600000).toISOString() };
  f.input.observerView.traders[0].lastAttempt = { at: new Date(f.input.now - 900000).toISOString() };
  f.input.observerView.traders.push(second);
  f.options.observer.refreshForScan = async id => { calls.push(id); throw Error('SENSITIVE_PROVIDER_MESSAGE'); };
  const result = await scan.prepare(f.options);
  assert.deepEqual(calls, [9, 7]);
  assert.equal(result.input.collection.status, 'UNAVAILABLE');
  assert.equal(result.input.collection.maximumReads, 6);
  assert.ok(!JSON.stringify(result).includes('SENSITIVE_PROVIDER_MESSAGE'));
  const priorities = [{ asset: 'SPY', eligibleForTrade: true }, { asset: 'AAPL', eligibleForTrade: true }];
  assert.deepEqual(scan.prioritize(priorities, { candidates: [] }), priorities);
  assert.deepEqual(scan.prioritize(priorities, { candidates: [{ asset: 'AAPL' }] }).map(r => r.asset), ['AAPL', 'SPY']);
  f.input.observerView.traders.forEach(t => { t.lastAttempt = { at: new Date(f.input.now).toISOString() }; });
  await scan.prepare(f.options);
  assert.deepEqual(calls, [9, 7]);
});

test('the normal LEO decision receives trader candidates without changing the output universe or adding an AI request', async () => {
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const block = source.slice(source.indexOf('async function askDecisionAgent('), source.indexOf('async function buildRuntimeContext('));
  let requests = 0, payload;
  const answer = { decision: 'HOLD', asset: 'NONE', amount_usd: 0 };
  const sandbox = { traderScanInputs: scan, WATCHLIST: { AAPL: 1 }, ASSET_RULES: {}, VERSION: 'test', TRADING_MODE: 'PAPER', OPENAI_MODEL: 'mock', PROMPT: '',
    getPreferredNextAssets: () => [{ asset: 'AAPL', eligibleForTrade: true }], getProgressiveOrderPolicy: () => ({ maximumOrderUsd: 10 }), nowIso: () => f.iso(f.START),
    getExecutionStats24h: () => ({}), runtimeState: {}, noteServiceResult: () => {},
    getOpenAIClient: () => ({ chat: { completions: { create: async options => { requests++; payload = JSON.parse(options.messages[1].content); return { choices: [{ message: { content: JSON.stringify(answer) } }] }; } } } }) };
  vm.createContext(sandbox); vm.runInContext(block, sandbox);
  const context = { candidates: [{ instrumentId: 1, asset: 'AAPL', transactionProven: false }], executionAllowed: false };
  await sandbox.askDecisionAgent({}, {}, {}, 'test', { traderContext: context });
  assert.equal(requests, 1);
  assert.deepEqual(payload.foundation_agents.traderContext, context);
  assert.deepEqual(payload.watchlist, { AAPL: 1 });
});

test('writer status expires and cannot be manufactured from a configured writer flag', () => {
  const now = f.START;
  assert.equal(scan.writerVerified({ ownLease: true, checkedAt: now, leaseRemainingMs: 100 }, now), true);
  for (const proof of [null, { singleWriterVerified: true }, { ownLease: true, checkedAt: now, leaseRemainingMs: 0 }, { ownLease: true, checkedAt: now - 100, leaseRemainingMs: 100 }]) assert.equal(scan.writerVerified(proof, now), false);
});

test('readiness explains missing integrations even with all trading switches enabled and exposes no supplied identity', () => {
  const settings = { enabled: true, confirmation: 'I_UNDERSTAND_TRADER_STRATEGY_REAL_ORDERS', entriesEnabled: true, exitsEnabled: true };
  const state = bridge.initialState();
  const r = readiness.report({ credentials: { etoro: true, persistence: true, secret: 'SECRET' }, settings,
    mode: 'LIVE', armed: true, buyArmed: true, state, writer: { ownLease: true, checkedAt: f.START, leaseRemainingMs: 10000 },
    inputs: { candidates: [{ asset: 'AAPL' }] }, now: f.START });
  assert.equal(r.status, 'BLOCKED');
  assert.ok(r.entries.reasons.includes('CANDIDATE_EVIDENCE_NOT_COLLECTED'));
  assert.ok(r.entries.resolutions.every(r => typeof r.resolution === 'string' && r.resolution.length));
  assert.ok(r.exits.reasons.includes('NO_VERIFIED_MANAGED_POSITION'));
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.equal(r.authenticatedBrokerCalls, 0);
});

test('ordinary scan collects before analysis and carries the same input to decision, while dashboard performs no trader collection', async () => {
  const data = fixture(), now = Date.now(), events = [];
  data.input.observerView.traders[0].snapshot.collectedAt = new Date(now).toISOString();
  data.input.observerView.traders[0].snapshot.receivedAt = new Date(now).toISOString();
  for (const q of Object.values(data.input.quotes)) q.date = new Date(now).toISOString();
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const block = source.slice(source.indexOf('async function buildRuntimeContext('), source.indexOf('function isAutomaticAutomationSource('));
  const observer = { view: data.options.observer.view, refreshForScan: async () => { events.push('collect'); return { status: 'PARTIAL' }; } };
  const noOp = () => ({});
  const sandbox = { traderScanInputs: scan, traderObserver: observer, lastTraderScanInputs: null, PAPER_TRADING_ENABLED: false, LIVE_TRADING_ENABLED: false,
    ETORO_ACCOUNT_ENV: 'REAL', SECONDARY_MAX_ASSETS_PER_SCAN: 3, WATCHLIST: { AAPL: 1, SPY: 2 }, ASSET_RULES: {}, CONFIGURED_UNIVERSE_CANDIDATES: [],
    TRADE_ALLOWED_ASSETS: new Set(['AAPL', 'SPY']), TRADE_ALLOWED_CATEGORIES: new Set(['STOCK', 'ETF']), process: { env: {} },
    runtimeState: { traderAdvisoryState: data.options.state, traderObserver: data.options.observerState },
    getPortfolio: async () => ({}), validatePortfolioResponse: () => ({ ok: true }), extractPortfolioSummary: () => ({ uniqueOpenAssets: [] }),
    getMarketRates: async () => ({ normalized: { ratesByAsset: data.input.quotes }, trendSummary: {} }), recordEquitySnapshot() {},
    buildLivePerformanceReport: noOp, ensurePaperPortfolio: noOp, markPaperPortfolio: noOp, paperPortfolioResponse: noOp,
    scheduleSave() {}, buildUniverse: () => data.input.universe,
    getPreferredNextAssets: () => [{ asset: 'SPY', eligibleForTrade: true }, { asset: 'AAPL', eligibleForTrade: true }],
    buildDataIntegrityReport: async () => ({}), buildTechnicalAnalysisReport: async options => { events.push('technical'); assert.equal(options.preferredNextAssets[0].asset, events.includes('collect') && !sandbox.process.env.TRADER_RECENT_OPENINGS_SHADOW_ENABLED ? 'AAPL' : 'SPY'); return {}; },
    buildMarketRegimeAgent: noOp, buildIntelligenceAnalysisReport: async () => ({}), buildMacroCreditFundamentalRegimeAgent: noOp,
    calculatePaperPerformance: noOp, buildStrategyValidationAgent: noOp, buildRiskSellIntelligenceAgent: noOp, buildAgentCouncil: noOp, buildFoundationAgents: noOp };
  vm.createContext(sandbox); vm.runInContext(block, sandbox);
  const result = await sandbox.buildRuntimeContext('manual-scan', { refreshTraders: true });
  assert.deepEqual(events, ['collect', 'technical']);
  assert.equal(result.foundationAgents.traderContext.candidates[0].asset, 'AAPL');
  const history = sandbox.runtimeState.traderAdvisoryState.history.length;
  events.length = 0;
  const dashboard = await sandbox.buildRuntimeContext('dashboard');
  assert.deepEqual(events, ['technical']);
  assert.equal(dashboard.foundationAgents.traderContext, undefined);
  assert.equal(sandbox.runtimeState.traderAdvisoryState.history.length, history);
  sandbox.PAPER_TRADING_ENABLED = true;
  sandbox.process.env.TRADER_RECENT_OPENINGS_SHADOW_ENABLED = 'true';
  events.length = 0;
  const experimental = await sandbox.buildRuntimeContext('manual-scan', { refreshTraders: true });
  assert.deepEqual(events, ['collect', 'technical']);
  assert.equal(experimental.traderRecentOpeningsShadow, true);
  assert.equal(experimental.foundationAgents.traderContext, undefined);
});

test('the execution bridge derives writer evidence only after a successful durable save', async () => {
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const block = source.slice(source.indexOf('async function processTraderExecution('), source.indexOf('async function executeControlledDecision('));
  let saved = true, reads = 0, captured;
  const sandbox = { hydrateTraderRuntimeEvidence: async context => context, lastTraderRuntimeContext: null, hasUpstashMemory: () => true, savePersistentState: async () => saved,
    continuity: { status: async () => { reads++; return { ownLease: true, leaseRemainingMs: 10000 }; } },
    traderExecutionContext: null, evaluateAutomaticTraderProposals: () => ({}),
    traderExecutionController: { drain: async () => { captured = sandbox.traderExecutionContext.executionWriterProof; return { executionAttempted: false }; } } };
  vm.createContext(sandbox); vm.runInContext(block, sandbox);
  await sandbox.processTraderExecution({}, { approved: false });
  assert.equal(reads, 1);
  assert.equal(scan.writerVerified(captured, Date.now()), true);
  saved = false;
  await sandbox.processTraderExecution({}, { approved: false });
  assert.equal(reads, 1);
  assert.equal(captured, null);
});

test('a socially informed decision cannot be labelled as the trader-free SHADOW baseline', () => {
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const block = source.slice(source.indexOf('function recordTraderShadowScan('), source.indexOf('let traderExecutionContext = null;'));
  const sandbox = { PAPER_TRADING_ENABLED: true };
  vm.createContext(sandbox); vm.runInContext(block, sandbox);
  const result = sandbox.recordTraderShadowScan({ foundationAgents: { traderContext: { candidates: [{ asset: 'AAPL' }], inputId: 'fixture', inputVersion: scan.VERSION } } });
  assert.equal(result.status, 'UNAVAILABLE_INDEPENDENT_BASELINE_REQUIRED');
  assert.equal(result.brokerCalls, 0);
  assert.equal(result.inputVersion, scan.VERSION);
});
