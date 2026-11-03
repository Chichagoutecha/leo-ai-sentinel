'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const b = require('./trader-execution-bridge');
const { progressFor } = require('./order-finality-fixtures');
const NOW = Date.parse('2026-11-02T12:00:00Z'), at = new Date(NOW).toISOString();
function buy(id = 'proposal-1') { return { proposalId: id, decisionId: `decision-${id}`, policyVersion: 'trader-context-v1', policyId: 'a'.repeat(64), createdAt: at,
  side: 'BUY', asset: 'AAPL', instrumentId: 1, amountUsd: 10, scope: 'REAL_MANAGED_STRATEGY', decision: 'ADVISORY_REVIEW_ONLY', leoConfidence: 85, referencePrice: 10, priceDriftLimitPct: 2,
  traderSources: [{ traderId: 7, observationId: 'b'.repeat(64) }] }; }
function sell(id = 'exit-1', units = 1) { const p = buy(id); delete p.amountUsd; return { ...p, side: 'SELL', positionId: '101', units, quantityMode: 'FULL_POSITION' }; }
function settings() { return { enabled: true, entriesEnabled: true, exitsEnabled: true, confirmation: 'I_UNDERSTAND_TRADER_STRATEGY_REAL_ORDERS', maxOrderUsd: 10, maxExitNotionalUsd: 100, maxCostUsd: 1 }; }
function initialized() { return b.initializeForContext(b.initialState(), { identityVerified: true, tokenBindingVerified: true, accountRef: 'fixture-account', mode: 'LIVE', executionHistoryReviewed: true }); }
function row(units = 1, id = '101') { return { asset: 'AAPL', positionId: id, instrumentId: 1, ownership: 'DIRECT', isBuy: true, leverage: 1, settlementType: 'Underlying', units }; }
function evidence(p, positions = []) { return { mode: 'LIVE', armed: true, buyArmed: true, accountRef: 'fixture-account', identityVerified: true, tokenBindingVerified: true,
  release: { status: 'APPROVED_CHRONOLOGICAL_EVALUATION', policyVersion: p.policyVersion, policyId: p.policyId, accountRef: 'fixture-account', environment: 'REAL', sampleStatus: 'SUFFICIENT', liveAccountReviewed: true, approvedAt: at, evaluationEndAt: at },
  asOf: at, portfolioComplete: true, pendingComplete: true, positions, uncertainOrPending: false,
  instrument: { asset: 'AAPL', instrumentId: 1, allowed: true }, quote: { instrumentId: 1, currency: 'USD', bid: 10, ask: 10, asOf: at, tradable: true },
  closeTerms: { proposalId: p.proposalId, accountRef: 'fixture-account', instrumentId: p.instrumentId, asOf: at, currency: 'USD',
    settlementType: 'Underlying', leverage: 1, fullCloseAllowed: true, minimumUsd: 1, maximumUsd: 100, minimumUnits: 0.01, maximumUnits: 10,
    costCoverage: 'COMPLETE_ESTIMATE', maximumCostUsd: 0.1, entryAmountUsd: p.amountUsd, projectedMinUnits: 0.98, projectedMaxUnits: 1.03, positionId: p.positionId, units: p.units },
  eligibility: { instrumentId: 1, side: p.side, allowed: true, accountRef: 'fixture-account', currency: 'USD', leverage: 1, settlementType: 'Underlying', minimumUsd: 1, maximumUsd: 100, asOf: at },
  cost: { instrumentId: 1, side: p.side, accountRef: 'fixture-account', coverage: 'COMPLETE_ESTIMATE', totalUsd: 0.1, amountUsd: p.amountUsd, units: p.units, asOf: at },
  risk: { approved: true, side: p.side, instrumentId: 1, proposalId: p.proposalId, amountUsd: p.amountUsd, positionId: p.side === 'SELL' ? String(p.positionId) : null, units: p.units, asOf: at },
  limits: { exitSlotAfterEntry: true, cadenceAllowed: true, dailyAllowed: true, singleWriterVerified: true },
  exposure: { coverage: 'COMPLETE', afterWithinLimits: true, proposalId: p.proposalId, amountUsd: p.amountUsd, units: p.units, asOf: at },
  sourceProof: { status: 'CURRENT_REFERENCES_VERIFIED', proposalId: p.proposalId, opposed: false, asOf: at }, cashUsd: 1000, reserveUsd: 200 }; }
function harness({ state = initialized(), positions = [], configure = settings(), mutate = () => {}, outcome = 'CONFIRMED', save = () => true } = {}) {
  let current = state, rows = structuredClone(positions), config = configure;
  const calls = [], saves = [];
  const persist = async () => { saves.push(structuredClone(current)); return save(saves.length); };
  const controller = b.createController({ getState: () => current, setState: s => { current = s; }, persist, clock: () => NOW,
    settings: () => config, evidence: p => { const e = evidence(p, rows); mutate(e); return e; },
    executeNormal: async (p, metadata) => {
      assert.ok(saves.some(s => s.operations[p.proposalId]?.status === 'RESERVED'));
      assert.equal(b.guardExecutor(current, metadata, rows, 'fixture-account', NOW), true);
      current.operations[p.proposalId].intentId = `intent-${p.proposalId}`;
      await persist(); // Simulates normal executor's durable intent boundary, before submission.
      calls.push({ side: p.side, proposalId: p.proposalId, positionId: p.positionId, units: p.units, metadata });
      if (outcome === 'NETWORK') throw Error('SECRET_ERROR_NOT_RETAINED');
      if (outcome === 'ACK') return { intentId: `intent-${p.proposalId}`, businessAcknowledged: true, confirmed: false };
      if (outcome === 'REJECTED') return { intentId: `intent-${p.proposalId}`, confirmed: false, verification_status: 'ORDER_REJECTED' };
      const beforeRows = rows.map(r => ({ positionId: r.positionId, units: r.units }));
      if (p.side === 'SELL') rows = rows.filter(r => r.positionId !== p.positionId);
      else if (rows.length) rows[0].units += 1;
      else rows = [row()];
      const result = { intentId: `intent-${p.proposalId}`, confirmed: true, data: { positionId: '101' }, verification: {
        beforeSnapshot: { instrumentId: 1, positionDetails: beforeRows }, afterSnapshot: { instrumentId: 1, positionDetails: rows.map(r => ({ positionId: r.positionId, units: r.units })) } } };
      result.orderProgress = progressFor(p, beforeRows, rows, outcome === 'PARTIAL' ? 'PARTIAL' : 'FILLED');
      if (outcome === 'AMBIGUOUS') result.verification.afterSnapshot.positionDetails.push({ positionId: '102', units: 1 });
      if (outcome === 'UNBOUND') delete result.data.positionId;
      return result;
    } });
  return { controller, calls, saves, get state() { return current; }, set state(s) { current = s; }, get positions() { return rows; }, set config(c) { config = c; }, queue(p) { current = b.enqueue(current, p); } };
}
test('disabled by default and initialization requires reviewed account/token context', async () => {
  assert.equal(b.initialState().recoveryRequired, true);
  assert.throws(() => b.initializeForContext(b.initialState(), { mode: 'LIVE' }));
  const h = harness({ configure: {} }); h.queue(buy()); assert.equal((await h.controller.drain()).status, 'AUTOMATION_DISABLED'); assert.equal(h.calls.length, 0);
});
test('buy uses only the normal executor, persists first and registers only an unambiguously linked confirmed position', async () => {
  const h = harness(); h.queue(buy()); assert.equal((await h.controller.drain()).status, 'CONFIRMED');
  assert.equal(h.calls.length, 1); assert.equal(h.state.managed['101'].units, 1); assert.equal(h.state.operations['proposal-1'].intentId, 'intent-proposal-1');
  assert.equal(h.state.managed['101'].scope, 'WHOLE_BROKER_POSITION_NOT_SIGNAL_LOTS');
});
test('reinforcement retains multiple signal references on one broker position without inventing lots', async () => {
  const h = harness(); h.queue(buy()); await h.controller.drain();
  const p = buy('reinforce-2'); p.traderSources = [{ traderId: 8, observationId: 'c'.repeat(64) }]; h.queue(p);
  assert.equal((await h.controller.drain()).status, 'CONFIRMED'); assert.equal(h.state.managed['101'].units, 2);
  assert.equal(h.state.managed['101'].operationIds.length, 2); assert.equal(h.state.managed['101'].traderSources.length, 2);
  assert.equal(Object.keys(h.state.managed).length, 1);
});
test('full managed exit is independent of BUY arming and entry vetoes', async () => {
  const h = harness(); h.queue(buy()); await h.controller.drain();
  h.config = { ...settings(), entriesEnabled: false };
  h.queue(sell()); assert.equal((await h.controller.drain()).status, 'CONFIRMED'); assert.equal(h.state.managed['101'], undefined);
  assert.equal(h.calls[1].positionId, '101'); assert.equal(h.calls[1].side, 'SELL');
  const s = initialized(); s.managed['101'] = { ...row(), accountRef: 'fixture-account', status: 'VERIFIED_MANAGED' };
  const e = evidence(sell(), [row()]); e.buyArmed = false;
  assert.deepEqual(b.preflight(s, sell(), e, { ...settings(), entriesEnabled: false }, NOW), []);
});
test('partial reductions are explicitly blocked, never replaced by a full liquidation or a short sale', async () => {
  const h = harness(); h.queue(buy()); await h.controller.drain();
  const p = { ...sell(), units: 0.25, quantityMode: 'UNITS' }; h.queue(p);
  const r = await h.controller.drain(); assert.ok(r.vetoes.includes('PARTIAL_CLOSE_NOT_RELIABLY_SUPPORTED')); assert.equal(h.calls.length, 1);
});
test('personal, old LEO, copy and changed-unit positions are never adopted or closed', async () => {
  for (const position of [row(), { ...row(), ownership: 'NATIVE_COPY' }, { ...row(), isBuy: false }, { ...row(), leverage: 2 }]) {
    const h = harness({ positions: [position] }); h.queue(sell()); assert.equal((await h.controller.drain()).status, 'VETOED'); assert.equal(h.calls.length, 0);
    assert.deepEqual(h.state.managed, {});
  }
  const state = initialized(); state.managed['101'] = { ...row(), accountRef: 'fixture-account', status: 'VERIFIED_MANAGED' };
  const h = harness({ state, positions: [row(2)] }); h.queue(sell()); assert.equal((await h.controller.drain()).status, 'VETOED');
});
test('a BUY cannot silently merge with an unmanaged pre-existing position', async () => {
  const h = harness({ positions: [row()] }); h.queue(buy()); assert.equal((await h.controller.drain()).status, 'VETOED'); assert.equal(h.calls.length, 0);
});
test('source opposition, unknown costs, stale quotes, minimums, cash, exposure and cadence all veto', async () => {
  const changes = [e => { e.sourceProof.opposed = true; }, e => { e.cost = null; }, e => { e.quote.asOf = '2020-01-01'; }, e => { e.eligibility.minimumUsd = 20; },
    e => { e.cashUsd = 205; }, e => { e.exposure.afterWithinLimits = false; }, e => { e.limits.cadenceAllowed = false; }, e => { e.limits.singleWriterVerified = false; },
    e => { e.tokenBindingVerified = false; }, e => { e.pendingComplete = false; }, e => { e.instrument.instrumentId = 99; }, e => { e.risk.amountUsd = 20; }, e => { e.quote.bid = 15; e.quote.ask = 15; }];
  for (const mutate of changes) { const h = harness({ mutate }); h.queue(buy()); assert.equal((await h.controller.drain()).status, 'VETOED'); assert.equal(h.calls.length, 0); }
});
test('no LIVE, DEMO or SHADOW order is sent without all explicit gates and release review', async () => {
  for (const mutate of [e => { e.mode = 'DEMO'; }, e => { e.mode = 'SHADOW'; }, e => { e.armed = false; }, e => { e.release.sampleStatus = 'INSUFFICIENT'; }, e => { e.release.policyId = 'f'.repeat(64); }]) {
    const h = harness({ mutate }); h.queue(buy()); assert.equal((await h.controller.drain()).status, 'VETOED'); assert.equal(h.calls.length, 0);
  }
});
test('duplicate proposals, reused decision IDs and corrected conflicting proposals cannot resend', async () => {
  const h = harness(); h.queue(buy()); h.queue(buy()); await h.controller.drain(); h.queue(buy()); await h.controller.drain(); assert.equal(h.calls.length, 1);
  assert.throws(() => h.queue({ ...buy(), amountUsd: 9 }));
  assert.throws(() => h.queue({ ...buy('different-id'), decisionId: buy().decisionId }));
});
test('network errors and acknowledgement-only responses survive restart without retry or scope adoption', async () => {
  for (const outcome of ['NETWORK', 'ACK', 'AMBIGUOUS']) {
    const h = harness({ outcome }); h.queue(buy()); assert.equal((await h.controller.drain()).status, 'NEEDS_RECONCILIATION');
    assert.deepEqual(h.state.managed, {}); assert.ok(!JSON.stringify(h.state).includes('SECRET_ERROR_NOT_RETAINED'));
    const restored = harness({ state: b.recover(JSON.parse(JSON.stringify(h.state))) }); await restored.controller.drain(); assert.equal(restored.calls.length, 0);
    restored.queue(buy('new-proposal')); const r = await restored.controller.drain(); assert.ok(r.vetoes.includes('PENDING_OR_UNCERTAIN_OPERATION')); assert.equal(restored.calls.length, 0);
  }
});
test('crash after durable reservation requires reconciliation even if no intent is found', async () => {
  const h = harness({ save: n => n === 1 }); h.queue(buy()); await h.controller.drain();
  const reserved = h.saves[0]; assert.equal(reserved.operations['proposal-1'].status, 'RESERVED');
  const restored = harness({ state: b.recover(reserved) }); assert.equal(restored.state.operations['proposal-1'].status, 'NEEDS_RECONCILIATION');
  await restored.controller.drain(); assert.equal(restored.calls.length, 0);
});
test('failed persistence prevents dispatch; emergency stop persists and blocks future operations', async () => {
  const h = harness({ save: () => false }); h.queue(buy()); assert.equal((await h.controller.drain()).status, 'PERSISTENCE_UNAVAILABLE'); assert.equal(h.calls.length, 0);
  const stop = initialized(); stop.emergencyStop = true; const x = harness({ state: stop }); x.queue(buy()); assert.ok((await x.controller.drain()).vetoes.includes('EMERGENCY_STOP'));
  assert.equal(x.calls.length, 0);
});
test('explicit rejection is terminal but is never automatically resent', async () => {
  const h = harness({ outcome: 'REJECTED' }); h.queue(buy()); assert.equal((await h.controller.drain()).status, 'REJECTED');
  await h.controller.drain(); assert.equal(h.calls.length, 1); assert.deepEqual(h.state.managed, {});
});
test('SELL is selected before an unrelated BUY and a blocked entry does not consume exit permission', () => {
  let state = initialized(); state = b.enqueue(state, buy()); state = b.enqueue(state, sell()); assert.equal(b.select(state).side, 'SELL');
});
test('reconciliation uses an exact intent and confirmed position proof, never cash or an acknowledgement', async () => {
  const h = harness({ outcome: 'ACK' }); h.queue(buy()); await h.controller.drain();
  const confirmed = { orderProgress: progressFor(buy(), [], [row()]), confirmed: true, intentId: 'intent-proposal-1', data: { positionId: '101' }, verification: { afterSnapshot: { instrumentId: 1, positionDetails: [{ positionId: '101', units: 1 }] } } };
  const r = b.reconcile(h.state, 'proposal-1', confirmed, NOW); assert.equal(r.operations['proposal-1'].status, 'CONFIRMED'); assert.equal(r.managed['101'].units, 1);
  const wrong = b.reconcile(h.state, 'proposal-1', { ...confirmed, intentId: 'other' }, NOW); assert.equal(wrong.operations['proposal-1'].status, 'NEEDS_RECONCILIATION'); assert.deepEqual(wrong.managed, {});
});
test('order caps also govern full exits; unsupported reductions cannot work around them', () => {
  const state = initialized(); state.managed['101'] = { ...row(10), accountRef: 'fixture-account', status: 'VERIFIED_MANAGED' };
  const p = sell('big-exit', 10), e = evidence(p, [row(10)]);
  assert.ok(b.preflight(state, p, e, { ...settings(), maxExitNotionalUsd: 10 }, NOW).includes('FULL_EXIT_EXCEEDS_ORDER_CAP_PARTIAL_CLOSE_UNSUPPORTED'));
});
test('bounded persistence disables the bridge without silently rebuilding idempotency or adopting positions', () => {
  const state = initialized(); state.queue = Array.from({ length: 20 }, (_, i) => buy(`proposal-${i}`));
  const c = b.compact(state, 100); assert.equal(c.emergencyStop, true); assert.ok(c.disabledReason); assert.equal(c.recoveryRequired, true);
});
test('simultaneous drains of the same controller dispatch at most once', async () => {
  const h = harness(); h.queue(buy()); const r = await Promise.all([h.controller.drain(), h.controller.drain()]); assert.equal(h.calls.length, 1); assert.ok(r.some(x => x.status === 'BUSY'));
});
test('arming changes during the durable reservation are checked again before invoking the executor', async () => {
  let h;
  h = harness({ save: n => { if (n === 1) h.config = { ...settings(), entriesEnabled: false }; return true; } });
  h.queue(buy()); const r = await h.controller.drain(); assert.equal(r.status, 'VETOED'); assert.equal(h.calls.length, 0);
});
test('actual persistence wrapper serializes writes so an earlier background save cannot finish after the order boundary', async () => {
  const source = require('node:fs').readFileSync(require.resolve('./index'), 'utf8');
  const wrapper = source.slice(source.indexOf('let persistentWriteChain ='), source.indexOf('async function savePersistentStateUnlocked()'));
  const vm = require('node:vm'), started = [], finished = []; let release;
  const sandbox = { savePersistentStateUnlocked: async () => { const n = started.length + 1; started.push(n); if (n === 1) await new Promise(r => { release = r; }); finished.push(n); return true; } };
  vm.createContext(sandbox); vm.runInContext(wrapper, sandbox);
  const first = sandbox.savePersistentState(), second = sandbox.savePersistentState();
  await Promise.resolve(); await Promise.resolve(); assert.deepEqual(started, [1]);
  release(); assert.equal(await first, true); assert.equal(await second, true); assert.deepEqual(finished, [1, 2]);
});
test('actual normal executor hooks remain disabled in SHADOW and partial close is blocked before network', async () => {
  const names = ['TRADING_MODE', 'BOT_SECRET']; const saved = Object.fromEntries(names.map(k => [k, process.env[k]])); const original = global.fetch;
  try {
    Object.assign(process.env, { TRADING_MODE: 'SHADOW', BOT_SECRET: 'BRIDGE_TEST' }); let calls = 0;
    global.fetch = () => { calls++; throw Error('NO_NETWORK'); };
    const leo = require('./index');
    assert.equal((await leo.executeBuy('SPY', 10, null, { strategyExecution: {} })).reason, 'STRATEGY_LIVE_ONLY');
    assert.equal((await leo.executeSell('SPY', null, { strategyExecution: {} })).reason, 'STRATEGY_LIVE_ONLY');
    assert.equal((await leo.executeSell('SPY', null, { partialUnits: 1 })).reason, 'PARTIAL_CLOSE_NOT_RELIABLY_SUPPORTED');
    assert.equal(calls, 0); assert.equal(leo.runtimeState.traderExecutionBridge.recoveryRequired, true);
    assert.equal(leo.buildPersistentState({ compact: false }).traderExecutionBridge.version, 1);
    assert.ok(leo.app._router.stack.some(r => r.route?.path === '/trader-execution-stop'));
  } finally { global.fetch = original; for (const k of names) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
test('real executor functions in an isolated VM use the existing BUY/close contracts, exact target and durable intent with a simulated broker', async () => {
  const source = require('node:fs').readFileSync(require.resolve('./index'), 'utf8');
  const functions = source.slice(source.indexOf('async function executeBuy('), source.indexOf('async function buildRuntimeContext('));
  const vm = require('node:vm');
  for (const side of ['BUY', 'SELL']) for (const scenario of ['CONFIRMED', 'NETWORK', 'ACK', 'PERSISTENCE']) for (const strategy of [true, false]) {
    const requests = [], events = [], intents = {};
    const positions = side === 'SELL' ? [{ positionId: '999', instrumentId: 1, units: 2 }, { positionId: '101', instrumentId: 1, units: 1 }] : [];
    const snap = () => ({ instrumentId: 1, positionIds: positions.map(r => r.positionId), positionDetails: positions.map(r => ({ positionId: r.positionId, units: r.units })) });
    const sandbox = { orderFinality: require('./etoro-order-finality'), TRADING_MODE: 'LIVE', TRADING_MODE_LABEL: 'LIVE', DEMO_TRADING_ENABLED: false, LIVE_TRADING_ENABLED: true, LIVE_EXECUTION_ARMED: true,
      LIVE_PORTFOLIO_PREFLIGHT_ENABLED: true, LIVE_BUY_MAX_ORDER_USD: 10, MIN_ORDER_USD: 1, MAX_OPEN_POSITIONS: 10,
      WATCHLIST: { AAPL: 1 }, ASSET_RULES: { AAPL: {} }, TRADE_ALLOWED_ASSETS: new Set(['AAPL']), TRADE_ALLOWED_CATEGORIES: new Set(['STOCK']),
      SELL_CLOSE_PROOF_VERSION: 'TEST', EXECUTION_STATUS: { SENT: 'ORDER_SENT', ACCEPTED: 'ORDER_ACCEPTED', NOT_FOUND: 'ORDER_ACCEPTED_NOT_CONFIRMED', CONFIRMED: 'POSITION_CONFIRMED', REJECTED: 'ORDER_REJECTED', UNCERTAIN: 'EXECUTION_UNCERTAIN' },
      process: { env: {} }, liveBuyReady: () => true, nowIso: () => at, classifyAsset: () => 'STOCK', evaluateBuyPolicy: () => ({ allowed: true }),
      verifyRealPortfolioBeforeExecution: async () => ({ ok: true, portfolio: { positions }, validation: { availableCash: 1000 }, summary: { totalTrackedValue: 1000 }, identity: { ok: true } }),
      getMarketRates: async () => ({}), isMarketRateTradable: () => ({ ok: true, rate: { mid: 10, bid: 10, ask: 10, date: at } }),
      getClientPortfolio: x => x, getPositionId: p => p.positionId, getInstrumentIdFromPosition: p => p.instrumentId, getFirstNumber: p => p.units,
      buildAssetExecutionSnapshot: snap, findOpenPosition: () => positions[0],
      guardTraderNormalExecution: (_options, _preflight, _market, request) => { assert.equal(request.side, side); if (side === 'SELL') assert.equal(request.positionId, '101'); return true; },
      createOrderIntent: (type, asset, amount, details) => { events.push('intent'); const intent = { id: 'intent-test', type, asset, amount, ...details }; intents[intent.id] = intent; return { ok: true, intent }; },
      updateOrderIntentStatus: (id, status, details) => Object.assign(intents[id], { status }, details),
      runtimeState: { orderIntents: intents, traderExecutionBridge: { operations: { 'proposal-1': {} } } },
      persistOrderIntentBeforeSend: async intent => { assert.ok(intent); events.push('durable-intent'); return scenario !== 'PERSISTENCE'; },
      persistTraderExecution: async () => { events.push('durable-intent'); return scenario !== 'PERSISTENCE'; }, traderExecutionSettings: () => ({ enabled: true }),
      etoroHeaders: () => ({ 'x-request-id': 'test-request' }),
      fetchJsonWithRetry: async (url, init, opts) => { assert.equal(events.at(-1), 'durable-intent'); assert.equal(opts.retries, 0); requests.push({ url, method: init.method, body: JSON.parse(init.body) });
        if (scenario === 'NETWORK') throw Error('MOCK_NETWORK'); return { response: { ok: true, status: 200 }, data: { orderId: 'order-test', positionId: '101' } }; },
      compactEtoroExecutionResponse: x => x, hasExecutionBusinessAcknowledgement: () => true,
      verifyPortfolioAfterExecution: async () => ({ confirmed: scenario === 'CONFIRMED', observed: scenario === 'CONFIRMED', status: scenario === 'CONFIRMED' ? 'POSITION_CONFIRMED' : 'ORDER_ACCEPTED_NOT_CONFIRMED', afterSnapshot: { instrumentId: 1, positionDetails: [] }, evidence: [] }),
      addAudit() {}, addExecutionHistory() {}, setCooldown() {}, recordExecutionVerification() {} };
    vm.createContext(sandbox); vm.runInContext(functions, sandbox);
    const options = { ...(strategy ? { strategyExecution: { operationId: 'proposal-1', proposalId: 'proposal-1', accountRef: 'fixture-account' } } : {}), expectedPositionId: '101', expectedUnits: 1 };
    const r = side === 'BUY' ? await sandbox.executeBuy('AAPL', 10, null, options) : await sandbox.executeSell('AAPL', null, options);
    if (!strategy) {
      assert.equal(r.reason, 'MANAGED_EXECUTION_REQUIRED');
      assert.equal(requests.length, 0);
      continue;
    }
    assert.equal(intents['intent-test'].proposalId, strategy ? 'proposal-1' : undefined);
    if (scenario === 'PERSISTENCE') { assert.equal(requests.length, 0); assert.equal(r.confirmed, false); continue; }
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'POST');
    if (side === 'BUY') { assert.equal(requests[0].url, 'https://public-api.etoro.com/api/v2/trading/execution/orders'); assert.equal(requests[0].body.transaction, 'buy'); assert.equal(requests[0].body.leverage, 1); }
    else { assert.ok(requests[0].url.endsWith('/positions/101')); assert.deepEqual(requests[0].body, { InstrumentId: 1, UnitsToDeduct: null }); }
    assert.equal(r.confirmed, scenario === 'CONFIRMED');
  }
});
