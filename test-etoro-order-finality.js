'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const m = require('./etoro-order-finality'), { progressFor, TIME } = require('./order-finality-fixtures');
const b = require('./trader-execution-bridge'), f = require('./activation-review-fixtures');
const NOW = Date.parse(TIME), snap = rows => ({ instrumentId: 1, positionDetails: rows });
const expected = () => ({ intentId: 'synthetic-intent', side: 'BUY', environment: 'REAL', orderId: '123', instrumentId: 1, requestedAmount: 10, account: { accountId: 7 } });
function body(units = 1, full = true) { return { orderId: 123, accountId: 7, action: 'open', transaction: 'buy', orderCurrency: 'usd', requestedAmount: 10,
  asset: { instrumentId: 1, currency: 'USD', side: 'long', leverage: 1, settlementType: 'Underlying' }, status: { id: full ? 3 : 2, name: full ? 'Filled' : 'Other' },
  totalCosts: 0.1, frozenAmount: 6.1, positionExecutions: [{ positionId: 101, openingData: { orderId: 123, units, avgPrice: 10, fees: 0.1, executionTime: TIME } }] }; }
function result(p, before, after, state) { return { intentId: `intent-${p.proposalId}`, confirmed: state === 'FILLED',
  orderProgress: progressFor(p, before, after, state), verification: { beforeSnapshot: snap(before), afterSnapshot: snap(after) } }; }
test('partial OPEN is not complete; price, quantity, costs and unexecuted amount remain separate', () => {
  const p = m.normalizeLookup(body(0.4, false), expected(), NOW);
  assert.equal(p.state, 'PARTIALLY_FILLED'); assert.equal(p.complete, false); assert.equal(p.terminal, null);
  assert.equal(p.executedUnits, 0.4); assert.equal(p.executedAmount, 4); assert.equal(p.remainingRequestedAmount, 6);
  assert.equal(p.observedFees, 0.1); assert.equal(p.observedTotalCosts, 0.1); assert.equal(p.commitment.additionalCashDeductionUsd, 0);
});
test('Filled requires matching requested size, identity and actual order-linked executions', () => {
  const full = m.normalizeLookup(body(), expected(), NOW); assert.equal(full.complete, true); assert.equal(full.terminal, true);
  for (const mutate of [d => { d.positionExecutions[0].openingData.units = 0.4; }, d => { d.orderId = 999; }, d => { d.accountId = 8; },
    d => { d.asset.instrumentId = 2; }, d => { d.positionExecutions[0].openingData.orderId = 222; }, d => { d.requestedAmount = 20; },
    d => { d.status.name = 'Other'; }, d => { d.positionExecutions.push(d.positionExecutions[0]); }, d => { delete d.positionExecutions; },
    d => { d.asset.currency = 'EUR'; }, d => { d.positionExecutions[0].openingData.executionTime = '2030-01-01'; }]) {
    const raw = body(); mutate(raw); const p = m.normalizeLookup(raw, expected(), NOW); assert.equal(p.state, 'UNKNOWN'); assert.equal(p.complete, false);
  }
  assert.equal(m.normalizeLookup(body(), { ...expected(), account: {} }, NOW).state, 'UNKNOWN');
});
test('unknown costs and prices stay null, and arbitrary raw secrets never leave normalization', () => {
  const raw = body(0.4, false); delete raw.totalCosts; delete raw.positionExecutions[0].openingData.fees; delete raw.positionExecutions[0].openingData.avgPrice;
  raw.token = 'MUST_NOT_LEAK'; raw.errorMessage = 'MUST_NOT_LEAK'; raw.positionExecutions[0].secret = 'MUST_NOT_LEAK';
  const p = m.normalizeLookup(raw, expected(), NOW); assert.equal(p.observedFees, null); assert.equal(p.executedAmount, null); assert.equal(p.remainingRequestedAmount, null);
  assert.ok(!JSON.stringify(p).includes('MUST_NOT_LEAK'));
});
test('snapshots alone cannot prove order completion; full lookup without matching snapshot cannot confirm either', () => {
  assert.equal(m.positionProof({ side: 'BUY', beforeSnapshot: snap([]), afterSnapshot: snap([f.row()]), progress: null }).matched, false);
  const p = m.normalizeLookup(body(), expected(), NOW);
  assert.equal(m.positionProof({ side: 'BUY', beforeSnapshot: snap([]), afterSnapshot: snap([f.row(0.4)]), progress: p }).matched, false);
  assert.equal(m.positionProof({ side: 'BUY', beforeSnapshot: snap([]), afterSnapshot: snap([f.row()]), progress: p }).matched, true);
});
test('late completion after restart updates one managed position without resending or inventing lots', async () => {
  const h = f.harness({ outcome: 'PARTIAL' }); const p = f.buy(); h.queue(p);
  assert.equal((await h.controller.drain()).status, 'NEEDS_RECONCILIATION'); assert.equal(h.state.managed['101'].units, 0.4);
  const restarted = f.harness({ state: b.recover(JSON.parse(JSON.stringify(h.state))) }); await restarted.controller.drain(); assert.equal(restarted.calls.length, 0);
  const full = b.reconcile(restarted.state, p.proposalId, result(p, [], [f.row()], 'FILLED'), NOW);
  assert.equal(full.operations[p.proposalId].status, 'CONFIRMED'); assert.equal(full.managed['101'].units, 1); assert.equal(full.managed['101'].operationIds.length, 1);
  const duplicate = b.reconcile(full, p.proposalId, result(p, [], [f.row()], 'FILLED'), NOW);
  assert.equal(duplicate.managed['101'].operationIds.length, 1); assert.equal(duplicate.managed['101'].traderSources.length, 1);
});
test('partial close preserves remaining units and can finish with a rejected remainder or a late full fill', async () => {
  const h = f.harness(); h.queue(f.buy()); await h.controller.drain();
  const p = f.sell(); let state = h.state;
  state.operations[p.proposalId] = { proposal: p, accountRef: 'fixture-account', intentId: `intent-${p.proposalId}`, status: 'NEEDS_RECONCILIATION', beforeSnapshot: snap([f.row()]) };
  const partial = b.reconcile(state, p.proposalId, result(p, [f.row()], [f.row(0.6)], 'PARTIAL'), NOW);
  assert.equal(partial.operations[p.proposalId].status, 'NEEDS_RECONCILIATION'); assert.equal(partial.managed['101'].units, 0.6);
  assert.equal(partial.managed['101'].status, 'RECONCILIATION_REQUIRED');
  const rejectedRest = b.reconcile(b.recover(partial), p.proposalId, result(p, [f.row()], [f.row(0.6)], 'REJECTED_REST'), NOW);
  assert.equal(rejectedRest.operations[p.proposalId].status, 'PARTIALLY_FILLED_TERMINAL'); assert.equal(rejectedRest.managed['101'].units, 0.6);
  assert.equal(rejectedRest.managed['101'].status, 'VERIFIED_MANAGED'); assert.equal(rejectedRest.operations[p.proposalId].evidence.confirmed, false);
  const full = b.reconcile(partial, p.proposalId, result(p, [f.row()], [], 'FILLED'), NOW);
  assert.equal(full.operations[p.proposalId].status, 'CONFIRMED'); assert.equal(full.managed['101'], undefined);
});
test('decreasing or corrected cumulative quantities suspend finality and preserve the previous observation', () => {
  const full = m.normalizeLookup(body(), expected(), NOW), partial = m.normalizeLookup(body(0.4, false), expected(), NOW);
  const bad = m.monotonic(full, partial); assert.equal(bad.state, 'UNKNOWN'); assert.equal(bad.lastVerified.executedUnits, 1);
  assert.equal(m.monotonic(full, m.unknown('READ_FAILED')).lastVerified.complete, true);
  const other = m.normalizeLookup(body(), expected(), NOW); other.orderId = '456'; assert.equal(m.monotonic(full, other).state, 'UNKNOWN');
});
test('documented CLOSE status ids distinguish pending, rejection, cancellation and terminal partial fills', () => {
  const ex = { side: 'SELL', environment: 'REAL', orderId: 123, instrumentId: 1, positionId: 101, requestedUnits: 1, account: { CID: 7 } };
  for (const statusID of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 999]) {
    const units = statusID === 3 ? 1 : [5, 9, 10].includes(statusID) ? 0.4 : 0;
    const p = m.normalizeLookup({ orderID: 123, instrumentID: 1, CID: 7, statusID,
      positions: units ? [{ positionID: 101, units, rate: 10, occurred: TIME }] : [] }, ex, NOW);
    if (statusID === 999) assert.equal(p.state, 'UNKNOWN');
    else { assert.equal(p.terminal, [3, 4, 7, 8, 9, 10].includes(statusID)); assert.equal(p.complete, statusID === 3); }
  }
});
test('read client constructs only official GETs, bounds calls and never uses an execution endpoint', async () => {
  let now = NOW, calls = [];
  const c = m.createReadClient({ clock: () => now, headers: () => ({ 'x-api-key': 'SYNTHETIC', 'x-user-key': 'SYNTHETIC' }),
    fetchImpl: async (url, init) => { calls.push({ url, method: init.method }); return new Response(JSON.stringify(body())); } });
  assert.equal((await c.read({ ...expected(), side: 'COPY' })).reason, 'READ_NOT_ALLOWED'); assert.equal(calls.length, 0);
  assert.equal((await c.read(expected())).complete, true); assert.equal((await c.read(expected())).reason, 'LOOKUP_COOLDOWN');
  for (let i = 0; i < 6; i++) await c.read({ ...expected(), intentId: 'other-' + i });
  assert.equal(calls.length, 6); assert.ok(calls.every(x => x.method === 'GET' && !x.url.includes('/execution/')));
  assert.equal((await c.read({ ...expected(), intentId: 'last' })).reason, 'LOCAL_SHARED_QUOTA_RESERVE');
  now += 60001; await c.read(expected()); assert.equal(calls.length, 7);
  const byReference = m.createReadClient({ clock: () => NOW, headers: () => ({ 'x-api-key': 'SYNTHETIC', 'x-user-key': 'SYNTHETIC' }),
    fetchImpl: async url => { assert.ok(url.endsWith('referenceId=123e4567-e89b-12d3-a456-426614174000')); return new Response(JSON.stringify(body())); } });
  assert.equal((await byReference.read({ ...expected(), orderId: null, referenceId: '123e4567-e89b-12d3-a456-426614174000' })).complete, true);
  assert.equal((await byReference.read({ ...expected(), method: 'POST' })).reason, 'READ_NOT_ALLOWED');
});
test('401 and 403 are not retried; 429/network errors are bounded and raw response errors are discarded', async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0, now = NOW;
    const c = m.createReadClient({ clock: () => now, headers: () => ({ 'x-api-key': 'SYNTHETIC', 'x-user-key': 'SYNTHETIC' }), fetchImpl: async () => { calls++; return new Response('SECRET_RESPONSE', { status }); } });
    const first = await c.read(expected()); now += 11000; const second = await c.read(expected());
    assert.equal(calls, 1); assert.ok(!JSON.stringify([first, second]).includes('SECRET_RESPONSE'));
  }
  const c = m.createReadClient({ headers: () => ({ 'x-api-key': 'SYNTHETIC', 'x-user-key': 'SYNTHETIC' }), fetchImpl: async () => { throw Error('SECRET_EXCEPTION'); } });
  assert.equal((await c.read(expected())).reason, 'LOOKUP_NETWORK_OR_SCHEMA_ERROR');
});
test('missing keys, account identity or unsupported DEMO do not generate additional reads', async () => {
  let calls = 0; const c = m.createReadClient({ fetchImpl: async () => { calls++; throw Error(); } });
  assert.equal((await c.read(expected())).reason, 'CREDENTIALS_ABSENT');
  assert.equal((await c.read({ ...expected(), account: {} })).reason, 'ACCOUNT_BINDING_REQUIRED_BEFORE_LOOKUP');
  assert.equal((await c.read({ ...expected(), environment: 'DEMO' })).reason, 'REAL_LOOKUP_ONLY'); assert.equal(calls, 0);
  assert.deepEqual(m.contextFromPortfolio({ data: { accountId: 7, portfolioId: 1, clientPortfolio: { accountId: 8 } } }), {});
});
test('pending exposure counts only unexecuted principal once and never subtracts a reservation from broker cash again', () => {
  const { buildTraderExposureView } = require('./trader-exposure-link');
  const progress = m.normalizeLookup(body(0.4, false), expected(), NOW);
  const view = buildTraderExposureView({ now: NOW, universe: [{ symbol: 'AAPL', instrumentId: 1 }], portfolioResponse: { ok: true, accountEnvironment: 'REAL', fetchedAt: TIME,
    data: { accountId: 7, clientPortfolio: { credit: 90, positions: [{ positionId: 101, instrumentId: 1, amount: 4, units: 0.4,
      unrealizedPnL: { pnL: 0 }, isBuy: true, leverage: 1, settlementType: 'Underlying' }], mirrors: [], orders: [], ordersForOpen: [{ orderId: 123, instrumentId: 1, amount: 10, isBuy: true, leverage: 1, currency: 'USD' }] } } },
    intents: [{ id: 'synthetic-intent', type: 'BUY', asset: 'AAPL', status: 'ORDER_PARTIALLY_FILLED', amount: 10, response: { orderId: 123 }, orderProgress: progress, positionProof: { matched: true } }] });
  assert.equal(view.pending.orders.length, 1); assert.equal(view.pending.orders[0].amountUsd, 6); assert.equal(view.pending.orders[0].additionalCashDeductionUsd, 0);
  assert.equal(view.pending.knownBuyUpperBoundByInstrument['1'], 6);
  assert.equal(view.owned.knownValuesByInstrument['1'], 4);
  assert.equal(view.owned.knownValuesByInstrument['1'] + view.pending.knownBuyUpperBoundByInstrument['1'], 10);
  assert.equal(view.owned.creditUsd, 90);
});
test('actual normal verifier distinguishes partial, full, filled-awaiting-portfolio and terminal partial close', () => {
  const leo = require('./index');
  const partial = m.normalizeLookup(body(0.4, false), expected(), NOW), full = m.normalizeLookup(body(), expected(), NOW);
  const check = (p, rows) => leo.evaluateExecutionEvidence({ side: 'BUY', beforeSnapshot: snap([]), afterSnapshot: snap(rows), orderProgress: p });
  assert.equal(check(partial, [f.row(0.4)]).status, leo.EXECUTION_STATUS.PARTIAL);
  assert.equal(check(full, [f.row(0.4)]).status, leo.EXECUTION_STATUS.FILLED_AWAITING_PORTFOLIO);
  assert.equal(check(full, [f.row()]).confirmed, true);
  const close = progressFor(f.sell(), [f.row()], [f.row(0.6)], 'REJECTED_REST');
  const stopped = leo.evaluateExecutionEvidence({ side: 'SELL', beforeSnapshot: snap([f.row()]), afterSnapshot: snap([f.row(0.6)]), expectedPositionId: '101', orderProgress: close });
  assert.equal(stopped.status, leo.EXECUTION_STATUS.TERMINAL_PARTIAL); assert.equal(stopped.confirmed, false);
});
test('runtime read budget survives restart and is persisted before lookup, never before an order resend', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const block = source.slice(source.indexOf('async function readOrderProgress('), source.indexOf('async function verifyPortfolioAfterExecution('));
  const state = { orderIntents: { i: { id: 'i', mode: 'LIVE', type: 'BUY', asset: 'AAPL', amount: 10, response: { orderId: 123 }, lookupAccountContext: { accountId: '7' }, beforeSnapshot: snap([]) } } };
  let reads = 0, durable = false;
  const setup = runtimeState => {
    const sandbox = { runtimeState, Date: { now: () => NOW, parse: Date.parse }, WATCHLIST: { AAPL: 1 }, orderFinality: m,
      savePersistentState: async () => { durable = true; return true; }, scheduleSave() {},
      orderFinalityReads: { read: async e => { assert.equal(durable, true); reads++; return m.normalizeLookup(body(0.4, false), e, NOW); } } };
    vm.createContext(sandbox); vm.runInContext(block, sandbox); return sandbox;
  };
  const first = setup(state); await first.readOrderProgress(state.orderIntents.i); assert.equal(reads, 1);
  const restored = setup(JSON.parse(JSON.stringify(state))); await restored.readOrderProgress({ ...restored.runtimeState.orderIntents.i }); assert.equal(reads, 1);
  assert.equal(restored.runtimeState.orderIntents.i.lookupReadTimes.length, 1);
});
test('normal pre-send persistence refuses a compacted-away intent or failed storage', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const block = source.slice(source.indexOf('async function persistOrderIntentBeforeSend('), source.indexOf('async function readOrderProgress('));
  const intent = { id: 'i', requestId: 'synthetic-request', status: 'ORDER_SENT' }; let writes = 0;
  const sandbox = { EXECUTION_STATUS: { SENT: 'ORDER_SENT' }, buildPersistentState: () => ({ orderIntents: { i: intent } }), hasUpstashMemory: () => true,
    fitPersistentStateToBudget: () => ({ state: { orderIntents: {} } }), savePersistentState: async () => { writes++; return false; } };
  vm.createContext(sandbox); vm.runInContext(block, sandbox);
  assert.equal(await sandbox.persistOrderIntentBeforeSend(intent), false); assert.equal(writes, 0);
  sandbox.fitPersistentStateToBudget = x => ({ state: x }); assert.equal(await sandbox.persistOrderIntentBeforeSend(intent), false); assert.equal(writes, 1);
});
test('new-format uncertain intents cannot become NO_EFFECT solely from timeout and unchanged snapshots', () => {
  const fs = require('node:fs'), vm = require('node:vm'), source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const block = source.slice(source.indexOf('function shouldResolveIntentAsNoEffect('), source.indexOf('function recordExecutionVerification('));
  const sandbox = {}; vm.createContext(sandbox); vm.runInContext(block, sandbox);
  const r = sandbox.shouldResolveIntentAsNoEffect({ finalityVersion: 1, createdAt: '2020-01-01' }, {}, {}, 999);
  assert.equal(r.resolve, false); assert.equal(r.reasons[0], 'ORDER_FINALITY_REQUIRED_NO_TIMEOUT_RELEASE');
});
test('legacy confirmations without order proof are reopened for reconciliation without resubmission', () => {
  const fs = require('node:fs'), vm = require('node:vm'), source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const block = source.slice(source.indexOf('function migrateOrderIntent('), source.indexOf('function pruneOrderIntents('));
  const sandbox = { normalizeExecutionIntentStatus: s => s, EXECUTION_STATUS: { CONFIRMED: 'POSITION_CONFIRMED', UNCERTAIN: 'EXECUTION_UNCERTAIN' }, nowIso: () => TIME };
  vm.createContext(sandbox); vm.runInContext(block, sandbox);
  const migrated = sandbox.migrateOrderIntent({ status: 'POSITION_CONFIRMED' });
  assert.equal(migrated.status, 'EXECUTION_UNCERTAIN'); assert.equal(migrated.legacyReportedStatus, 'POSITION_CONFIRMED'); assert.equal(migrated.finalityVersion, 1);
  const state = f.initialized(); state.operations.old = { status: 'CONFIRMED', proposal: f.buy() };
  assert.equal(b.recover(state).operations.old.status, 'NEEDS_RECONCILIATION');
});
test('actual DEMO pre-send path also refuses failed persistence without calling a broker', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), source = fs.readFileSync(require.resolve('./index'), 'utf8');
  const block = source.slice(source.indexOf('async function executeDemoBuy('), source.indexOf('async function executeBuy('));
  let calls = 0;
  const sandbox = { process: { env: {} }, demoBuyReady: () => true, WATCHLIST: { AAPL: 1 }, MIN_ORDER_USD: 1, LIVE_BUY_MAX_ORDER_USD: 10,
    getPortfolio: async () => ({}), validatePortfolioResponse: () => ({ ok: true, availableCash: 100 }), extractPortfolioIdentifier: () => '7', ETORO_EXPECTED_DEMO_PORTFOLIO_ID: '7',
    extractPortfolioSummary: () => ({ uniquePositionsCount: 0, totalTrackedValue: 100 }), hasOpenPosition: () => false, hasOpenOrder: () => false, MAX_OPEN_POSITIONS: 12,
    getMarketRates: async () => ({}), isMarketRateTradable: () => ({ ok: true }), ASSET_RULES: { AAPL: {} }, classifyAsset: () => 'STOCK',
    TRADE_ALLOWED_ASSETS: new Set(['AAPL']), TRADE_ALLOWED_CATEGORIES: new Set(['STOCK']), DEMO_EXECUTION_ARMED: true, ETORO_ACCOUNT_ENV: 'DEMO',
    evaluateBuyPolicy: () => ({ allowed: true }), buildAssetExecutionSnapshot: () => snap([]), createOrderIntent: () => ({ ok: true, intent: { id: 'i' } }),
    runtimeState: { orderIntents: { i: { id: 'i' } } }, etoroHeaders: () => ({}), nowIso: () => TIME, EXECUTION_STATUS: { SENT: 'ORDER_SENT', UNCERTAIN: 'EXECUTION_UNCERTAIN' },
    updateOrderIntentStatus() {}, persistOrderIntentBeforeSend: async () => false, fetchJsonWithRetry: async () => { calls++; throw Error('BROKER_FORBIDDEN'); } };
  vm.createContext(sandbox); vm.runInContext(block, sandbox);
  const r = await sandbox.executeDemoBuy('AAPL', 10); assert.equal(r.executionAttempted, false); assert.equal(calls, 0);
});
