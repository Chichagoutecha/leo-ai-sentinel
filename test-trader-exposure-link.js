'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./trader-exposure-link');
const now = Date.parse('2026-11-02T12:00:00Z');
const universe = [{ symbol: 'AAPL', instrumentId: 1, category: 'STOCK' }, { symbol: 'MSFT', instrumentId: 2, category: 'STOCK' }, { symbol: 'FUND', instrumentId: 3, category: 'ETF' }];
const pos = (positionId = 10, instrumentId = 1, amount = 100) => ({ positionId, instrumentId, amount, unrealizedPnL: { pnL: 0 }, units: 10, isBuy: true, leverage: 1, settlementType: 'Underlying' });
const response = overrides => ({ ok: true, accountEnvironment: 'REAL', fetchedAt: new Date(now).toISOString(), data: { clientPortfolio: { positions: [pos()], mirrors: [], ordersForOpen: [], orders: [], ordersForClose: [], credit: 100, ...overrides } } });
const build = overrides => m.buildTraderExposureView({ portfolioResponse: response(), universe, now, ...overrides });
const buy = (instrumentId = 1, amount = 10) => ({ instrumentId, side: 'BUY', amount, currency: 'USD', traderSources: [] });
const preview = (proposal, view = build(), options = {}) => m.previewProposal(proposal, view, { now, proposalId: () => '00000000-0000-4000-8000-000000000001', ...options });
const hash = n => String(n).repeat(64);
const trader = (realCID = 7, positions = [{ key: 'DIRECT:70', instrumentId: 1, investmentPct: 80 }]) => ({ realCID, observationId: hash('a'), status: 'PARTIAL', historicalSnapshot: false,
  snapshot: { realCID, identity: { realCID, gcid: realCID + 100 }, collectedAt: new Date(now).toISOString(), portfolio: { status: 'PARTIAL', positions }, sources: { portfolio: 'https://public-api.etoro.com/public-fixture' } } });
test('actual direct and mirror child positions count once; wrapper capital and observed portfolios are not added', () => {
  const p = pos();
  const r = build({ portfolioResponse: response({ positions: [p], mirrors: [{ mirrorId: 8, amount: 900, availableAmount: 20, closedPositionsNetProfit: 5, positions: [p] }] }), observerView: { traders: [trader()] } });
  assert.deepEqual(r.owned.knownValuesByInstrument, { 1: 100 });
  assert.equal(r.owned.direct.positions.length, 0);
  assert.equal(r.owned.nativeCopies.positions.length, 1);
  assert.equal(r.owned.nativeCopies.positions[0].representationsDeduplicated, 2);
  assert.equal(r.owned.nativeCopies.containers[0].idleAllocationUsd, 15);
  assert.equal(r.observedOnly.valueAddedToOurPortfolioUsd, null);
});
test('distinct broker positions on same instrument add, identical repeats deduplicate', () => {
  const r = build({ portfolioResponse: response({ positions: [pos(), pos(), pos(11)] }) });
  assert.equal(r.owned.knownValuesByInstrument[1], 200);
  assert.equal(r.owned.direct.positions.length, 2);
});
test('conflicting position identity, value or ownership does not select an optimistic representation', () => {
  for (const other of [{ ...pos(), instrumentId: 2 }, { ...pos(), amount: 200 }, { ...pos(), mirrorId: 9 }]) {
    const r = build({ portfolioResponse: response({ positions: [pos(), other] }) });
    assert.notEqual(r.owned.coverage, 'COMPLETE');
    assert.equal(r.owned.combinedValuesByInstrument, null);
  }
  const explicitDirect = build({ portfolioResponse: response({ positions: [{ ...pos(), mirrorId: 0 }], mirrors: [{ mirrorId: 8, positions: [pos()] }] }) });
  assert.equal(explicitDirect.owned.rows.length, 0);
});
test('missing copy containers stay unknown, while explicit empty copies are distinguishable', () => {
  const raw = response(); delete raw.data.clientPortfolio.mirrors;
  assert.equal(build({ portfolioResponse: raw }).owned.nativeCopies.absent, null);
  assert.equal(build().owned.nativeCopies.absent, true);
  const unknownParent = build({ portfolioResponse: response({ mirrors: [{ mirrorId: 8, positions: [pos(11, 2)] }] }) });
  assert.equal(unknownParent.owned.nativeCopies.containers[0].parentIdentityStatus, 'UNVERIFIED');
  assert.equal(unknownParent.owned.nativeCopies.containers[0].parentTraderId, null);
});
test('unknown positions, aliases, missing PnL and non-USD amounts do not become zero', () => {
  for (const p of [{ ...pos(), instrumentId: null }, { ...pos(), instrumentID: 2 }, { ...pos(), unrealizedPnL: undefined }, { ...pos(), currency: 'EUR' }, { ...pos(), profit: 99 }]) {
    const r = build({ portfolioResponse: response({ positions: [p] }) });
    assert.equal(r.owned.combinedValuesByInstrument, null);
    assert.equal(preview(buy(), r).marginal.afterAssumingAllKnownPendingBuysFillUsd, null);
  }
  const unknown = build({ portfolioResponse: response({ positions: [pos(10, 999)] }) });
  assert.equal(unknown.owned.rows[0].asset, 'INSTRUMENT:999');
  assert.equal(unknown.owned.knownValuesByInstrument[999], 100);
});
test('leveraged, short and unknown products explicitly retain unreconstructed risk', () => {
  for (const p of [{ ...pos(), leverage: 2 }, { ...pos(), isBuy: false }, { ...pos(), settlementType: 'CFD' }, { ...pos(), settlementType: undefined }]) assert.equal(build({ portfolioResponse: response({ positions: [p] }) }).owned.unreconstructedRisk.length, 1);
});
test('stale/foreign-environment reads cannot produce reliable marginal totals', () => {
  const raw = response(); raw.fetchedAt = '2020-01-01T00:00:00Z';
  assert.equal(build({ portfolioResponse: raw }).owned.coverage, 'STALE');
  assert.equal(preview(buy(), build({ portfolioResponse: raw })).status, 'INCOMPLETE');
  assert.equal(build({ portfolioResponse: { ...response(), accountEnvironment: 'DEMO' } }).owned.combinedValuesByInstrument, null);
});
test('pending broker orders deduplicate across arrays and exact intent links count once', () => {
  const order = { orderId: 20, instrumentId: 1, amount: 30, isBuy: true, leverage: 1 };
  const r = build({ portfolioResponse: response({ ordersForOpen: [order], orders: [order] }), intents: [{ id: 'intent-1', type: 'BUY', status: 'ORDER_SENT', amount: 30, brokerResponse: { orderId: 20 } }] });
  assert.equal(r.pending.orders.length, 1);
  assert.equal(r.pending.knownBuyUpperBoundByInstrument[1], 30);
  const p = preview(buy(), r);
  assert.equal(p.marginal.beforeKnownHeldValueUsd, 100);
  assert.equal(p.marginal.afterAssumingAllKnownPendingBuysFillUsd, 140);
});
test('unresolved intents and pending sells cannot reduce held exposure or yield exact totals', () => {
  const r = build({ intents: [{ id: 'uncertain', asset: 'AAPL', amount: 100, type: 'SELL', status: 'EXECUTION_UNCERTAIN' }] });
  assert.equal(r.owned.knownValuesByInstrument[1], 100);
  assert.equal(r.pending.allBuyUpperBoundByInstrument, null);
  assert.equal(preview(buy(), r).marginal.afterAssumingAllKnownPendingBuysFillUsd, null);
  assert.equal(r.pending.orders[0].instrumentId, null);
});
test('conflicting orders and unmatched analysis instrument mappings stay incomplete', () => {
  const order = { orderId: 20, instrumentId: 1, amount: 30, isBuy: true, leverage: 1 };
  const r = build({ portfolioResponse: response({ orders: [order], ordersForOpen: [{ ...order, amount: 40 }] }) });
  assert.equal(r.pending.status, 'INCOMPLETE');
  assert.deepEqual(r.pending.knownBuyUpperBoundByInstrument, {});
  assert.equal(build({ intents: [{ id: 'a', type: 'BUY', asset: 'FUND', amount: 10, status: 'ORDER_SENT' }] }).pending.status, 'INCOMPLETE');
});
test('close descriptors are not pending SELL proof and confirmed intents do not reserve again', () => {
  const r = build({ portfolioResponse: response({ ordersForClose: [{ positionId: 10 }] }), intents: [{ id: 'done', type: 'BUY', status: 'POSITION_CONFIRMED', amount: 100 }] });
  assert.equal(r.pending.orders.length, 0); assert.equal(r.owned.ordersForCloseIgnored, 1);
});
test('BUY and full or partial SELL scenarios use broker position identity without synthetic lots', () => {
  assert.equal(preview(buy()).marginal.afterAssumingAllKnownPendingBuysFillUsd, 110);
  const full = preview({ instrumentId: 1, side: 'SELL', currency: 'USD', positionId: 10, quantityMode: 'FULL_POSITION', traderSources: [] });
  assert.equal(full.marginal.proposedDeltaUsd, -100); assert.equal(full.marginal.afterAssumingAllKnownPendingBuysFillUsd, 0);
  const partial = preview({ instrumentId: 1, side: 'SELL', currency: 'USD', positionId: '10', quantityMode: 'UNITS', units: 4, traderSources: [] });
  assert.equal(partial.marginal.proposedDeltaUsd, -40);
  assert.match(partial.trace.lotModel, /NOT_AN_INDEPENDENT/);
});
test('selling cannot invent units, short the account or target a native-copy position', () => {
  const sell = { instrumentId: 1, side: 'SELL', currency: 'USD', positionId: 10, quantityMode: 'UNITS', units: 11, traderSources: [] };
  assert.equal(preview(sell).marginal.proposedDeltaUsd, null);
  const withoutUnits = build({ portfolioResponse: response({ positions: [{ ...pos(), units: undefined }] }) });
  assert.equal(preview({ ...sell, units: 1 }, withoutUnits).marginal.proposedDeltaUsd, null);
  const copied = build({ portfolioResponse: response({ positions: [], mirrors: [{ mirrorId: 8, positions: [pos()] }] }) });
  assert.equal(preview({ ...sell, quantityMode: 'FULL_POSITION', units: undefined }, copied).marginal.proposedDeltaUsd, null);
});
test('observed traders remain distinct, repeated holdings count one source, independence is unknown', () => {
  const r = build({ observerView: { traders: [trader(7, [{ instrumentId: 1 }, { instrumentId: 1 }]), trader(8)] } });
  assert.equal(r.observedOnly.instruments[0].observedTraderCount, 2);
  assert.deepEqual(r.owned.knownValuesByInstrument, { 1: 100 });
  assert.match(r.observedOnly.instruments[0].independence, /NOT_ESTABLISHED/);
  const duplicate = build({ observerView: { traders: [trader(), trader()] } });
  assert.equal(duplicate.observedOnly.instruments.length, 0);
});
test('stale and unavailable trader snapshots do not establish common concentration', () => {
  for (const status of ['STALE', 'PRIVATE', 'UNAVAILABLE']) assert.equal(build({ observerView: { traders: [{ ...trader(), status }] } }).observedOnly.instruments.length, 0);
});
test('dimensions require dated complete verified metadata and keep economic currency distinct', () => {
  const row = { instrumentId: 1, sourceVerified: true, complete: true, sourceType: 'OFFICIAL_ISSUER', sourceUrl: 'https://issuer.example/fixture', asOf: new Date(now).toISOString(), sector: 'Technology', issuer: 'Issuer', geography: 'US', currency: 'USD' };
  const good = build({ taxonomy: [row] });
  assert.equal(good.dimensions.sector.combinedValuesUsd.Technology, 100);
  for (const invalid of [{ ...row, asOf: '2020-01-01' }, { ...row, complete: false }, { ...row, sourceVerified: false }]) assert.equal(build({ taxonomy: [invalid] }).dimensions.sector.combinedValuesUsd, null);
  assert.equal(build().dimensions.currency.status, 'UNAVAILABLE');
  assert.match(good.dimensions.currency.definition, /NOT_USD_VALUATION/);
});
test('proposal references must exist, match the instrument and be current, not superseded', () => {
  const t = trader(), ref = { traderId: 7, observationId: hash('a') }, state = { traders: { 7: { observationId: hash('a') } }, observations: [{ id: hash('a'), realCID: 7, collectedAt: new Date(now).toISOString() }], events: [] };
  const p = preview({ ...buy(), traderSources: [ref] }, build(), { observerState: state, observerView: { traders: [t] } });
  assert.equal(p.trace.traderSources[0].status, 'REFERENCE_FOUND_NOT_TRANSACTION_PROOF');
  assert.equal(p.trace.traderSources[0].transactionProven, false);
  assert.equal(preview({ ...buy(2), traderSources: [ref] }, build(), { observerState: state, observerView: { traders: [t] } }).status, 'INCOMPLETE');
  state.observations.push({ id: hash('b'), corrects: hash('a') });
  assert.equal(preview({ ...buy(), traderSources: [ref] }, build(), { observerState: state, observerView: { traders: [t] } }).status, 'INCOMPLETE');
});
test('trace linking requires explicit proposal reference; symbol/time matching never links an order', () => {
  const proposal = preview(buy()).trace;
  const r = build({ proposals: [proposal], intents: [{ id: 'same-symbol', asset: 'AAPL', status: 'POSITION_CONFIRMED', brokerResponse: { orderId: 20 } }] });
  assert.equal(r.proposalsNotExecuted[0].brokerOrderLinks.length, 0);
  const linked = build({ proposals: [proposal], intents: [{ id: 'explicit', proposalId: proposal.proposalId, status: 'POSITION_CONFIRMED', brokerResponse: { orderId: 20 } }] });
  assert.equal(linked.proposalsNotExecuted[0].brokerOrderLinks[0].brokerOrderId, '20');
  assert.deepEqual(linked.proposalsNotExecuted[0].positionLinks, []);
});
test('sizing is unavailable without verified complete equity/cash/look-through and unreconstructed risk vetoes', () => {
  assert.equal(preview(buy()).sizing.headroomUsd, null);
  const evidence = { verified: true, sourceType: 'OFFICIAL_ETORO_API', sourceUrl: 'https://public-api.etoro.com/fixture', asOf: new Date(now).toISOString(), currency: 'USD', equityUsd: 1000, availableCashUsd: 50, lookThroughCoverage: 'COMPLETE' };
  const policy = { maxInstrumentWeightPct: 15, maxOrderUsd: 10, minimumCashReserveUsd: 20 };
  assert.equal(preview(buy(), build(), { sizingEvidence: evidence, policy }).sizing.headroomUsd, 10);
  assert.equal(preview(buy(), build(), { sizingEvidence: { ...evidence, currency: 'EUR' }, policy }).sizing.headroomUsd, null);
  const leveraged = build({ portfolioResponse: response({ positions: [{ ...pos(), leverage: 2 }] }) });
  assert.equal(preview(buy(), leveraged, { sizingEvidence: evidence, policy }).sizing.headroomUsd, null);
});
test('values and previews are reproducible under reordered positions and mirror representations', () => {
  const one = build({ portfolioResponse: response({ positions: [pos(10), pos(11, 2)], mirrors: [{ mirrorId: 8, positions: [pos(12)] }] }) });
  const two = build({ portfolioResponse: response({ positions: [pos(11, 2), pos(10)], mirrors: [{ mirrorId: 8, positions: [pos(12), pos(12)] }] }) });
  assert.deepEqual(one.owned.knownValuesByInstrument, two.owned.knownValuesByInstrument);
  assert.deepEqual(preview(buy(), one).marginal, preview(buy(), two).marginal);
});
test('proposal validation rejects currencies, arbitrary links and invalid amounts before any read', () => {
  for (const b of [{ ...buy(), currency: 'EUR' }, { ...buy(), amount: null }, { ...buy(), orderId: 'injected' }, { ...buy(), traderSources: [{ traderId: 7, observationId: 'fake' }] }]) assert.throws(() => m.validateProposal(b));
});
test('issuer/sector metadata about a wrapper does not substitute for its unknown constituents', () => {
  const tax = { instrumentId: 3, sourceVerified: true, complete: true, sourceType: 'OFFICIAL_ISSUER', sourceUrl: 'https://issuer.example/fixture', asOf: new Date(now).toISOString(), sector: 'Technology', issuer: 'Fund provider', geography: 'US', currency: 'USD' };
  const r = build({ portfolioResponse: response({ positions: [pos(10, 3)] }), taxonomy: [tax] });
  assert.equal(r.dimensions.issuer.combinedValuesUsd, null);
});
test('legacy valuation fields are estimates rather than proof of complete exposure coverage', () => {
  const p = pos(); delete p.unrealizedPnL; p.profit = 5;
  const r = build({ portfolioResponse: response({ positions: [p] }) });
  assert.equal(r.owned.knownValuesByInstrument[1], 105);
  assert.equal(r.owned.combinedValuesByInstrument, null);
  assert.ok(r.owned.problems.includes('LEGACY_VALUATION_ESTIMATE_UNVERIFIED'));
});
test('paper portfolios never become actual owned evidence and previews leave inputs unchanged', () => {
  const paper = build({ portfolioResponse: response({ paperMode: true }) });
  assert.equal(paper.owned.combinedValuesByInstrument, null);
  const original = build(), snapshot = JSON.stringify(original);
  preview(buy(), original); assert.equal(JSON.stringify(original), snapshot);
});
test('integrated universe view reads PnL once, includes native children and never refreshes social/eligibility or executes', async () => {
  const names = ['BOT_SECRET', 'ETORO_API_KEY', 'ETORO_USER_KEY', 'TRADING_MODE'];
  const saved = Object.fromEntries(names.map(k => [k, process.env[k]])), originalFetch = global.fetch;
  try {
    Object.assign(process.env, { BOT_SECRET: 'EXPOSURE_TEST_AUTH', ETORO_API_KEY: 'TEST_API', ETORO_USER_KEY: 'TEST_USER', TRADING_MODE: 'SHADOW' });
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, method: init.method });
      assert.equal(url, 'https://public-api.etoro.com/api/v1/trading/info/real/pnl'); assert.equal(init.method, 'GET');
      return new Response(JSON.stringify({ clientPortfolio: response({ positions: [pos(10, 8760)], mirrors: [{ mirrorId: 8, positions: [pos(11, 8760, 50)] }] }).data.clientPortfolio }));
    };
    const { app } = require('./index');
    async function invoke(path, method, auth, body) {
      const route = app._router.stack.find(r => r.route?.path === path && r.route.methods[method]).route;
      let status = 200, output, allowed = false;
      const req = { query: {}, headers: auth ? { 'x-bot-secret': 'EXPOSURE_TEST_AUTH' } : {}, body };
      const res = { status(v) { status = v; return this; }, json(v) { output = v; }, setHeader() {} };
      route.stack[0].handle(req, res, () => { allowed = true; });
      if (allowed) await route.stack[1].handle(req, res);
      return { status, output };
    }
    assert.equal((await invoke('/trader-exposure-proposal-preview', 'post', false, buy())).status, 401);
    assert.equal((await invoke('/trader-exposure-proposal-preview', 'post', true, { ...buy(), currency: 'EUR' })).status, 400);
    assert.equal(calls.length, 0);
    const result = await invoke('/portfolio-universe-status', 'get', true);
    assert.equal(result.status, 200);
    assert.equal(result.output.directExposure.NVDA, 100);
    assert.equal(result.output.nativeCopyExposure.NVDA, 50);
    assert.equal(result.output.ownershipAndTraderExposure.owned.knownValuesByInstrument[8760], 150);
    assert.equal(calls.length, 1);
    await invoke('/trader-exposure-proposals', 'get', true);
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = originalFetch;
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});
