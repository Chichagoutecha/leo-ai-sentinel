'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { createEligibilityClient, createEligibilityRegistry } = require('./etoro-instrument-eligibility');
const { buildTraderExposureView } = require('./trader-exposure-link');
const { createRuntimeEvidence, verifyReceipt } = require('./trader-runtime-evidence');
const costs = require('./etoro-trading-costs');
const readiness = require('./trader-runtime-readiness');
const { VERSION } = require('./trader-scan-inputs');
const f = require('./activation-review-fixtures');

function setup() {
  const key = generateKeyPairSync('ed25519');
  const env = { ETORO_API_KEY: 'TEST_API_SECRET', ETORO_USER_KEY: 'TEST_USER_SECRET', ETORO_ACCOUNT_ENV: 'REAL',
    ETORO_PORTFOLIO_CONTEXT: 'ACCOUNT', ETORO_CREDENTIAL_REVISION: 'revision-1', ETORO_EXPECTED_USER_TOKEN_ID: '17',
    TRADER_PROVISIONING_PUBLIC_KEY: key.publicKey.export({ type: 'spki', format: 'pem' }) };
  let now = f.NOW, identityStatus = 200;
  const at = () => new Date(now).toISOString(), calls = [];
  const quote = { bid: 10, ask: 10, date: at() };
  const payload = { kind: 'ETORO_CREDENTIAL_PROVISIONING', accountRef: 'fixture-account', gcid: 12, realCid: 34, tokenId: 17,
    environment: 'REAL', contextKind: 'ACCOUNT', credentialRevision: 'revision-1', issuedAt: at(), expiresAt: new Date(now + 3600000).toISOString(),
    closeTerms: [{ instrumentId: 1, currency: 'USD', sourceUrl: 'https://www.etoro.com/trading/fees/', sourceAsOf: at(), sourceCheckedAt: at(), feeComponentsComplete: true,
      minimumUsd: 0, maximumUsd: 1000, minimumUnits: 0, maximumUnits: 100, fixedFeeUsd: 0.1, feeBps: 0 }] };
  const receipt = { payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), key.privateKey).toString('base64') };
  const portfolio = { ok: true, accountEnvironment: 'REAL', fetchedAt: at(), data: { clientPortfolio: {
    portfolioId: 'fixture-account', positions: [], mirrors: [], credit: 1000, orders: [], ordersForOpen: [], ordersForClose: [] } } };
  const universe = [{ instrumentId: 1, symbol: 'AAPL', category: 'STOCK' }];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/me')) return new Response(JSON.stringify({ gcid: 12, realCid: 34, scopes: ['etoro-public:real:read', 'etoro-public:real:write'], firstName: 'PRIVATE_NAME' }), { status: identityStatus });
    if (url.endsWith('/eligibility')) return new Response(JSON.stringify({ currency: 'USD', eligibilities: [{ instrumentId: 1, symbol: 'AAPL', allowOpenPosition: true, allowClosePosition: true,
      minPositionExposure: 1, maxUnitsPerOrder: 100, allowedOrderQuantityType: 'Both', requiresW8Ben: false,
      leverageConfigs: [{ settlementType: 'Underlying', direction: 'LONG', leverageValues: [1], isPotential: false, minPositionAmount: 1 }] }], notFoundInstrumentIds: [], notFoundSymbols: [] }));
    if (url === costs.ENDPOINT) {
      assert.deepEqual(JSON.parse(init.body), { action: 'open', transaction: 'buy', instrumentId: 1, settlementType: 'real', orderType: 'mkt', leverage: 1, amount: 10, orderCurrency: 'usd' });
      return new Response(JSON.stringify({ instrumentId: 1, costs: [{ costType: 'transactionFee', value: 0.1, currency: 'USD' }], lastUpdated: at(), secret: env.ETORO_USER_KEY }));
    }
    assert.fail('Unexpected endpoint ' + url);
  };
  const registry = createEligibilityRegistry({ client: createEligibilityClient({ env, fetchImpl, clock: () => now }), clock: () => now, ttlMs: 300000 });
  const provider = createRuntimeEvidence({ env, fetchImpl, registry, clock: () => now });
  const options = proposal => ({ proposal, portfolio, accountRef: 'fixture-account', quote, receipt, instrument: universe[0],
    view: buildTraderExposureView({ portfolioResponse: portfolio, universe, now }), allowedAssets: ['AAPL'], allowedCategories: ['STOCK'] });
  return { env, calls, provider, options, portfolio, receipt, quote, resign: () => { receipt.signature = sign(null, Buffer.from(JSON.stringify(receipt.payload)), key.privateKey).toString('base64'); }, now: () => now, advance: n => { now += n; }, setIdentityStatus: n => { identityStatus = n; } };
}

test('signed provisioning and actual identity produce session-bound eligibility, cost and sizing evidence', async () => {
  const s = setup(), result = await s.provider.collect(s.options(f.buy()));
  assert.equal(result.status, 'AVAILABLE', JSON.stringify(result.issues));
  assert.equal(s.provider.valid(result.binding, 'fixture-account'), true);
  assert.equal(s.provider.valid({ ...result.binding }, 'fixture-account'), false);
  assert.equal(result.cost.totalUsd, 0.1);
  assert.equal(result.cost.observedFeesUsd, null);
  assert.equal(result.eligibility.minimumUsd, 1);
  assert.equal(result.sizing.equityUsd, 1000);
  assert.equal(s.calls.length, 3);
  const output = JSON.stringify(result);
  for (const value of ['PRIVATE_NAME', 'TEST_USER_SECRET', 'TEST_API_SECRET']) assert.ok(!output.includes(value));
  s.env.ETORO_USER_KEY = 'ROTATED_SECRET';
  assert.equal(s.provider.valid(result.binding, 'fixture-account'), false);
});

test('missing receipts, wrong signatures, changed account or revision cannot be replaced by configured token IDs', async () => {
  for (const change of [s => { s.receipt.signature = 'invalid'; }, s => { s.receipt.payload.tokenId = 18; }, s => { s.env.ETORO_CREDENTIAL_REVISION = 'revision-2'; }, s => { delete s.env.TRADER_PROVISIONING_PUBLIC_KEY; }]) {
    const s = setup(); change(s);
    assert.equal((await s.provider.collect(s.options(f.buy()))).binding, null);
    assert.equal(s.calls.length, 0);
  }
  const s = setup(); s.advance(3600001);
  assert.notEqual(verifyReceipt(s.receipt, s.env, s.now()).status, 'VERIFIED_OPERATOR_ATTESTATION');
});

test('401 and 403 identity refusals are not retried or bypassed by a receipt', async () => {
  for (const status of [401, 403]) {
    const s = setup(); s.setIdentityStatus(status);
    const result = await s.provider.collect(s.options(f.buy()));
    assert.equal(result.binding, null);
    assert.equal(s.calls.length, 1);
    await s.provider.collect(s.options(f.buy()));
    assert.equal(s.calls.length, 1);
  }
});

test('unknown, duplicate, stale, foreign and time-dependent costs stay unavailable', () => {
  const input = { instrumentId: 1, amountUsd: 10 }, good = { instrumentId: 1, lastUpdated: f.evidence(f.buy()).asOf,
    costs: [{ costType: 'transactionFee', value: 0.1, currency: 'USD' }] };
  assert.equal(costs.normalize(good, input, f.NOW).status, 'AVAILABLE');
  for (const data of [{ ...good, costs: [] }, { ...good, instrumentId: 2 }, { ...good, lastUpdated: new Date(f.NOW - 300001).toISOString() },
    { ...good, costs: [...good.costs, ...good.costs] }, { ...good, costs: [{ costType: 'overnightFee', value: 1, currency: 'USD' }] },
    { ...good, costs: [{ costType: 'transactionFee', value: 1, currency: 'EUR' }] }, { ...good, costs: [{ costType: 'unknown', value: 1, currency: 'USD' }] }]) assert.equal(costs.normalize(data, input, f.NOW).status, 'UNAVAILABLE');
  for (const input of [{ instrumentId: 1, amountUsd: 10, action: 'close' }, { instrumentId: 1, amountUsd: 10, endpoint: '/orders' }]) assert.throws(() => costs.request(input));
});

test('normal BUY and exact managed SELL accept complete collected evidence, with entries disabled for the exit', async () => {
  const s = setup(), buy = f.buy(), result = await s.provider.collect(s.options(buy));
  const apply = (e, data) => { e.identityVerified = s.provider.valid(data.binding, 'fixture-account'); e.tokenBindingVerified = e.identityVerified;
    e.eligibility = data.eligibility; e.cost = data.cost; e.closeTerms = { ...data.closeTerms, proposalId: e.risk.proposalId }; };
  const h = f.harness({ mutate: e => apply(e, result) }); h.queue(buy);
  const first = await h.controller.drain();
  assert.equal(first.executionAttempted, true, JSON.stringify(first));
  assert.equal(h.calls.length, 1);
  const sell = f.sell();
  s.portfolio.data.clientPortfolio.positions = [{ positionId: '101', instrumentId: 1, amount: 10, unrealizedPnL: { pnL: 0 }, units: 1, isBuy: true, leverage: 1, settlementType: 'Underlying' }];
  const close = await s.provider.collect(s.options(sell));
  const exit = f.harness({ state: h.state, positions: h.positions, configure: { ...f.settings(), entriesEnabled: false }, mutate: e => apply(e, close) });
  exit.queue(sell);
  const second = await exit.controller.drain();
  assert.equal(second.executionAttempted, true, JSON.stringify(second));
  assert.equal(exit.calls[0].positionId, '101');
  assert.equal(s.calls.filter(c => c.url === costs.ENDPOINT).length, 1);
  assert.ok(s.calls.every(c => !c.url.includes('/execution/')));
});

test('satisfied candidate checks remove adapter blockers while missing evidence keeps its concrete resolution', () => {
  const state = f.initialized(); state.releaseApproval = { status: 'APPROVED_CHRONOLOGICAL_EVALUATION', inputVersion: VERSION };
  const inputs = { candidates: [{ asset: 'AAPL' }] };
  const r = readiness.report({ credentials: { etoro: true, persistence: true }, settings: f.settings(), mode: 'LIVE', armed: true, buyArmed: true,
    state, inputs, now: f.NOW, writer: { ownLease: true, checkedAt: f.NOW, leaseRemainingMs: 10000 }, candidateChecks: { BUY: [] }, evidenceIssues: [] });
  assert.equal(r.entries.status, 'AVAILABLE_TO_NORMAL_EXECUTOR');
  assert.deepEqual(r.entries.reasons, []);
  assert.equal(r.status, 'READY_FOR_REVIEW');
  assert.equal(readiness.detail('PROVISIONING_RECEIPT_REQUIRED', 'BUY').resolution.includes('signed receipt'), true);
});

test('agent discovery requires one account and one token with consistent permissions', async () => {
  for (const scenario of ['DUPLICATE_ACCOUNT', 'DUPLICATE_TOKEN', 'CONTRADICTORY_SCOPES', 'MATCH']) {
    const s = setup();
    s.env.ETORO_PORTFOLIO_CONTEXT = 'AGENT'; s.receipt.payload.contextKind = 'AGENT'; s.resign();
    const token = { userTokenId: 17, scopeNames: ['etoro-public:real:write'] };
    if (scenario === 'CONTRADICTORY_SCOPES') token.scopeIds = [];
    const row = { agentPortfolioId: 'fixture-account', agentPortfolioGcid: 12, userTokens: scenario === 'DUPLICATE_TOKEN' ? [token, token] : [token] };
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/me')) return new Response(JSON.stringify({ gcid: 12, realCid: 34, scopes: ['etoro-public:real:read', 'etoro-public:real:write'] }));
      if (url.endsWith('/agent-portfolios')) return new Response(JSON.stringify({ agentPortfolios: scenario === 'DUPLICATE_ACCOUNT' ? [row, row] : [row] }));
      if (url === costs.ENDPOINT) return new Response(JSON.stringify({ instrumentId: 1, lastUpdated: new Date(s.now()).toISOString(), costs: [{ costType: 'transactionFee', value: 0, currency: 'USD' }] }));
      assert.fail('Unexpected request');
    };
    // The real informational registry normalizer is covered in the other tests.
    const registry = { refresh: async () => ({ status: 'AVAILABLE' }), inspect: () => ({ identification: 'IDENTIFIED', configurationFreshness: 'AVAILABLE', configurationIssues: [],
      fetchedAt: new Date(s.now()).toISOString(), context: { environment: 'REAL' }, currency: 'USD', leoAuthorization: 'AUTHORIZED_BY_CALLER_POLICY',
      configuration: { requiresW8Ben: false, minPositionExposure: 1, maxUnitsPerOrder: 100, allowOpenPosition: true, allowClosePosition: true, allowedOrderQuantityType: 'Both',
        leverageConfigs: [{ settlementType: 'Underlying', direction: 'LONG', leverageValues: [1], isPotential: false, minPositionAmount: 1 }] } }) };
    const provider = createRuntimeEvidence({ env: s.env, fetchImpl, registry, clock: s.now });
    const result = await provider.collect(s.options(f.buy()));
    if (scenario === 'MATCH') assert.equal(result.status, 'AVAILABLE', JSON.stringify(result.issues));
    else { assert.equal(result.binding, null); assert.deepEqual(result.issues, ['AGENT_OR_TOKEN_METADATA_AMBIGUOUS_OR_UNAVAILABLE']); }
    assert.ok(calls.every(url => !url.includes('/execution/')));
  }
});

test('cost client never sends a close or an execution request and stops repeated 401, 403 and 429 attempts', async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const client = costs.createCostClient({ env: { ETORO_API_KEY: 'FAKE', ETORO_USER_KEY: 'FAKE2', ETORO_ACCOUNT_ENV: 'REAL' }, clock: () => f.NOW,
      fetchImpl: async (url, init) => { calls++; assert.equal(url, costs.ENDPOINT); assert.equal(init.method, 'POST'); return new Response('', { status }); } });
    await assert.rejects(client.check({ instrumentId: 1, amountUsd: 10, action: 'close' }));
    await client.check({ instrumentId: 1, amountUsd: 10 });
    await client.check({ instrumentId: 1, amountUsd: 10 });
    assert.equal(calls, 1);
  }
});

test('loss of close or sizing data affects their specific evidence and never turns a missing cost into zero', async () => {
  const s = setup(); s.receipt.payload.closeTerms = []; s.resign();
  const result = await s.provider.collect(s.options(f.buy()));
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.closeTerms, null);
  assert.ok(result.issues.includes('REVIEWED_OFFICIAL_CLOSE_TERMS_REQUIRED'));
  s.portfolio.data.clientPortfolio.mirrors = [{ mirrorId: 7, positions: [], availableAmount: 100, closedPositionsNetProfit: 0 }];
  const next = await s.provider.collect(s.options(f.buy()));
  assert.equal(next.sizing, null);
  assert.ok(next.issues.includes('COMPLETE_EQUITY_AND_INSTRUMENT_EXPOSURE_REQUIRED'));
});

test('activation planning exposes caps and missing production evidence without identifiers or secrets', () => {
  const { buildPlan } = require('./trader-activation-plan');
  const p = buildPlan({ env: { ETORO_API_KEY: 'PRIVATE_API', ETORO_USER_KEY: 'PRIVATE_USER', TRADE_ALLOWED_ASSETS: 'AAPL',
    TRADE_ALLOWED_CATEGORIES: 'STOCK', TRADER_OBSERVER_TRADERS_JSON: '[{"realCID":987654321}]' },
    universe: [{ instrumentId: 1, symbol: 'AAPL', category: 'STOCK', tradable: true }], state: { accountRef: 'PRIVATE_ACCOUNT',
      managed: { 123456789: { status: 'VERIFIED_MANAGED', instrumentId: 1, units: 2 } } }, now: f.NOW });
  assert.equal(p.status, 'BLOCKED');
  assert.equal(p.limits.buyCapUsd, 10);
  assert.equal(p.limits.exitCapUsd, 0);
  assert.equal(p.instruments[0].symbol, 'AAPL');
  assert.equal(p.traders[0].alias, 'trader-01');
  for (const secret of ['PRIVATE_API', 'PRIVATE_USER', 'PRIVATE_ACCOUNT', '987654321', '123456789']) assert.ok(!JSON.stringify(p).includes(secret));
  assert.equal(p.activationPerformed, false);
});

test('a full close is not blocked by opening minimums, W8 prerequisites or amount-order support', () => {
  const { eligibilityEvidence } = require('./trader-runtime-evidence');
  const cached = { identification: 'IDENTIFIED', configurationFreshness: 'AVAILABLE', configurationIssues: [], context: { environment: 'REAL' }, currency: 'USD',
    fetchedAt: new Date(f.NOW).toISOString(), configuration: { allowClosePosition: true, allowOpenPosition: false, requiresW8Ben: true, allowedOrderQuantityType: 'Units' },
    leoAuthorization: 'AUTHORIZED_BY_CALLER_POLICY' };
  const result = eligibilityEvidence(cached, f.sell(), { bid: 10, ask: 10 }, 'fixture-account', f.NOW);
  assert.equal(result.allowed, true);
  assert.equal(result.minimumUsd, undefined);
  assert.equal(eligibilityEvidence(cached, f.buy(), { bid: 10, ask: 10 }, 'fixture-account', f.NOW).status, 'UNAVAILABLE');
});

test('an agent-discovery 403 remains local to that read and never causes retries or borrowed credentials', async () => {
  const s = setup(); s.env.ETORO_PORTFOLIO_CONTEXT = 'AGENT'; s.receipt.payload.contextKind = 'AGENT'; s.resign();
  let discovery = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers['x-user-key'], s.env.ETORO_USER_KEY);
    if (url.endsWith('/me')) return new Response(JSON.stringify({ gcid: 12, realCid: 34, scopes: ['etoro-public:real:read', 'etoro-public:real:write'] }));
    if (url.endsWith('/agent-portfolios')) { discovery++; return new Response('', { status: 403 }); }
    if (url === costs.ENDPOINT) return new Response(JSON.stringify({ instrumentId: 1, lastUpdated: new Date(s.now()).toISOString(), costs: [{ costType: 'transactionFee', value: 0, currency: 'USD' }] }));
    assert.fail('Unexpected request');
  };
  const registry = { refresh: async () => ({ status: 'AVAILABLE' }), inspect: () => ({ identification: 'IDENTIFIED', configurationFreshness: 'AVAILABLE', configurationIssues: [],
    fetchedAt: new Date(s.now()).toISOString(), context: { environment: 'REAL' }, currency: 'USD', leoAuthorization: 'AUTHORIZED_BY_CALLER_POLICY', configuration: {
      requiresW8Ben: false, minPositionExposure: 1, maxUnitsPerOrder: 100, allowOpenPosition: true, allowClosePosition: true, allowedOrderQuantityType: 'Both',
      leverageConfigs: [{ settlementType: 'Underlying', direction: 'LONG', leverageValues: [1], isPotential: false, minPositionAmount: 1 }] } }) };
  const provider = createRuntimeEvidence({ env: s.env, fetchImpl, registry, clock: s.now });
  const result = await provider.collect(s.options(f.buy()));
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.binding.agentMetadata, 'FORBIDDEN');
  assert.equal(result.binding.namedTokenApiBinding, 'TOKEN_BINDING_UNVERIFIED');
  assert.equal(discovery, 1);
});
