'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENDPOINT, validateRequest, createEligibilityClient, createEligibilityRegistry } = require('./etoro-instrument-eligibility');
const configuration = { minPositionExposure: 50, maxUnitsPerOrder: 10000, allowOpenPosition: true, allowClosePosition: true, allowPartialClosePosition: true, allowMitOrders: true, allowEntryOrders: false, allowedOrderQuantityType: 'Both', requiresW8Ben: null,
  leverageConfigs: [{ settlementType: 'CFD', direction: 'LONG', leverageValues: [1, 2], isPotential: false, minPositionAmount: 50 }] };
const row = { instrumentId: 1001, symbol: 'AAPL', ...configuration };
const payload = overrides => ({ currency: 'USD', eligibilities: [structuredClone(row)], notFoundInstrumentIds: [], notFoundSymbols: [], ...overrides });
const request = { instrumentIds: [1001] };
const operation = { action: 'OPEN', currency: 'USD', amount: 50, units: 1, direction: 'LONG', settlementType: 'CFD', leverage: 1, orderType: 'MARKET' };
function setup({ respond = () => new Response(JSON.stringify(payload())), ttlMs = 1000, timeoutMs } = {}) {
  let time = Date.parse('2026-10-30T12:00:00Z'); const calls = [];
  const env = { ETORO_API_KEY: 'SECRET_API_KEY', ETORO_USER_KEY: 'SECRET_USER_KEY' };
  const client = createEligibilityClient({ env, clock: () => time, timeoutMs, fetchImpl: async (url, init) => { calls.push({ url, init }); return respond(url, init); } });
  const registry = createEligibilityRegistry({ client, clock: () => time, ttlMs });
  return { env, client, registry, calls, advance: ms => { time += ms; }, inspect: extras => registry.inspect({ instrumentId: 1001, symbol: 'AAPL', category: 'STOCK', operation, ...extras }) };
}
test('only fixed informational POST and documented request keys reach transport', async () => {
  const s = setup();
  for (const bad of [{}, { instrumentIds: [0] }, { instrumentIds: ['1001'] }, { symbols: ['bad?url'] }, { ...request, endpoint: '/orders' }, { ...request, currency: 'EUR' }, { instrumentIds: Array(101).fill(1001) }]) await assert.rejects(s.client.check(bad));
  assert.equal(s.calls.length, 0);
  await s.client.check(request);
  assert.equal(s.calls[0].url, ENDPOINT);
  assert.equal(s.calls[0].init.method, 'POST');
  assert.equal(s.calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(s.calls[0].init.body), { instrumentIds: [1001], symbols: [], currency: 'USD' });
  assert.deepEqual(validateRequest({ symbols: ['AAPL', 'AAPL'] }).symbols, ['AAPL']);
});
test('absent credentials and DEMO do not send requests to REAL endpoint', async () => {
  const s = setup(); delete s.env.ETORO_USER_KEY;
  assert.equal((await s.registry.refresh(request)).status, 'NOT_TESTED');
  s.env.ETORO_ACCOUNT_ENV = 'DEMO';
  assert.equal((await s.registry.refresh(request)).reason, 'REAL_ENDPOINT_ONLY');
  assert.equal(s.calls.length, 0);
});
test('configuration does not grant LEO authorization or prove account identity', async () => {
  const s = setup(); await s.registry.refresh(request);
  const result = s.inspect();
  assert.equal(result.technicalEligibility, 'ALLOWED_CONFIGURATION');
  assert.equal(result.leoAuthorization, 'NOT_AUTHORIZED');
  assert.equal(result.context.identityVerification, 'UNVERIFIED');
  assert.equal(result.dataAvailability.quote, 'UNKNOWN');
  assert.equal(s.inspect({ allowedAssets: ['AAPL'], allowedCategories: ['STOCK'], quoteFresh: true }).leoAuthorization, 'AUTHORIZED_BY_CALLER_POLICY');
  assert.equal(result.executionAttempted, false);
  assert.equal(result.configuration.allowPartialClosePosition, true);
});
test('minimum amounts, max units, leverage, settlement, direction and currency are checked separately', async () => {
  const s = setup(); await s.registry.refresh(request);
  for (const [patch, expected] of [
    [{ amount: 10 }, 'BELOW_MINIMUM'], [{ units: 20000 }, 'ABOVE_MAX_UNITS'], [{ leverage: 5 }, 'BLOCKED'],
    [{ settlementType: 'Underlying' }, 'REQUESTED_CONFIGURATION_NOT_REPORTED'], [{ direction: 'SHORT' }, 'REQUESTED_CONFIGURATION_NOT_REPORTED'],
    [{ currency: 'EUR' }, 'CURRENCY_UNKNOWN_OR_MISMATCH'], [{ units: undefined }, 'INCOMPLETE'], [{ orderType: 'LIMIT' }, 'ORDER_TYPE_NOT_EVALUATED']
  ]) assert.equal(s.inspect({ operation: { ...operation, ...patch } }).technicalEligibility, expected);
  assert.equal(s.inspect({ operation: { action: 'CLOSE', currency: 'USD', partial: true } }).technicalEligibility, 'ALLOWED_CONFIGURATION');
  assert.equal(s.inspect({ operation: { action: 'CLOSE', currency: 'USD' } }).technicalEligibility, 'INCOMPLETE');
});
test('partial response retains known rows and explicitly marks omitted instruments', async () => {
  const s = setup(); const result = await s.registry.refresh({ instrumentIds: [1001, 1002] });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(s.registry.inspect({ instrumentId: 1002 }).technicalEligibility, 'INCOMPLETE');
  assert.equal(s.inspect().technicalEligibility, 'ALLOWED_CONFIGURATION');
});
test('missing fields and explicit null are preserved as unknown, never zero or permission', async () => {
  const s = setup({ respond: () => new Response(JSON.stringify(payload({ eligibilities: [{ instrumentId: 1001, symbol: 'AAPL', allowOpenPosition: null }] }))) });
  await s.registry.refresh(request); const result = s.inspect();
  assert.equal(result.technicalEligibility, 'INCOMPLETE');
  assert.equal(result.configuration.allowOpenPosition, null);
  assert.equal(Object.hasOwn(result.configuration, 'minPositionExposure'), false);
});
test('duplicate, contradictory identities and currency mismatch fail closed', async () => {
  for (const [overrides, expected] of [[{ eligibilities: [row, row] }, 'CONTRADICTORY'], [{ notFoundInstrumentIds: [1001] }, 'CONTRADICTORY'], [{ currency: 'EUR' }, 'INCOMPLETE'], [{ eligibilities: [{ ...row, instrumentId: 999 }] }, 'INCOMPLETE']]) {
    const s = setup({ respond: () => new Response(JSON.stringify(payload(overrides))) });
    assert.equal((await s.registry.refresh(request)).status, expected);
    assert.notEqual(s.inspect().technicalEligibility, 'ALLOWED_CONFIGURATION');
  }
  const s = setup(); await s.registry.refresh(request);
  assert.equal(s.inspect({ symbol: 'WRONG' }).identification, 'CONTRADICTORY');
});
test('not-found rows stay explicit and do not confer identification', async () => {
  const s = setup({ respond: () => new Response(JSON.stringify(payload({ eligibilities: [], notFoundInstrumentIds: [1001] }))) });
  await s.registry.refresh(request);
  assert.equal(s.inspect().technicalEligibility, 'NOT_FOUND');
  assert.equal(s.inspect().identification, 'UNVERIFIED');
});
test('cache expires, coalesces calls and isolates returned objects', async () => {
  const s = setup();
  const [first] = await Promise.all([s.registry.refresh(request), s.registry.refresh(request)]);
  assert.equal(s.calls.length, 1); first.records[0].configuration.allowOpenPosition = false;
  assert.equal(s.inspect().configuration.allowOpenPosition, true);
  await s.registry.refresh(request); assert.equal(s.calls.length, 1);
  s.advance(1001); assert.equal(s.inspect().technicalEligibility, 'STALE');
  await s.registry.refresh(request); assert.equal(s.calls.length, 2);
});
test('credential rotation and every configured context selector invalidate cache without secret hashes', async () => {
  const s = setup();
  for (const name of ['ETORO_USER_KEY', 'ETORO_API_KEY', 'ETORO_PORTFOLIO_CONTEXT', 'ETORO_EXPECTED_USER_TOKEN_ID', 'ETORO_EXPECTED_AGENT_PORTFOLIO_ID', 'ETORO_EXPECTED_AGENT_PORTFOLIO_GCID', 'ETORO_EXPECTED_MIRROR_ID', 'ETORO_EXPECTED_PORTFOLIO_ID']) {
    await s.registry.refresh(request); s.env[name] = name === 'ETORO_PORTFOLIO_CONTEXT' ? 'AGENT' : 'NEW_VALUE';
    assert.equal(s.inspect().technicalEligibility, 'UNAVAILABLE');
  }
});
test('context changes during request discard the old-account response', async () => {
  const s = setup({ respond: () => { s.env.ETORO_USER_KEY = 'ROTATED'; return new Response(JSON.stringify(payload())); } });
  const result = await s.registry.refresh(request);
  assert.equal(result.reason, 'CONTEXT_CHANGED_DURING_REQUEST');
  assert.equal(s.inspect().technicalEligibility, 'UNAVAILABLE');
});
test('batching stays within 100 and validates all batches before network', async () => {
  const s = setup({ respond: (_url, init) => { const ids = JSON.parse(init.body).instrumentIds; return new Response(JSON.stringify(payload({ eligibilities: [], notFoundInstrumentIds: ids }))); } });
  await assert.rejects(s.registry.refreshMany({ instrumentIds: [...Array.from({ length: 100 }, (_, i) => i + 1), -1] }));
  assert.equal(s.calls.length, 0);
  const results = await s.registry.refreshMany({ instrumentIds: Array.from({ length: 201 }, (_, i) => i + 1) });
  assert.equal(results.length, 3);
  assert.deepEqual(s.calls.map(c => JSON.parse(c.init.body).instrumentIds.length), [100, 100, 1]);
});
test('401,403,429 and provider errors never retry or leak response/error secrets', async () => {
  for (const [code, status] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [500, 'UNAVAILABLE']]) {
    const s = setup({ respond: () => new Response('SECRET_USER_KEY PRIVATE', { status: code }) });
    const result = await s.registry.refresh(request);
    assert.equal(result.status, status); assert.equal(s.calls.length, 1);
    assert.equal(JSON.stringify(result).includes('SECRET_'), false);
  }
  const s = setup({ respond: () => { throw Error('SECRET_USER_KEY'); } });
  assert.equal((await s.registry.refresh(request)).reason, 'NETWORK_OR_TIMEOUT_FAILURE');
});
test('429 stops batched requests and establishes a cooldown', async () => {
  const s = setup({ respond: () => new Response('{}', { status: 429 }) });
  assert.equal((await s.registry.refreshMany({ instrumentIds: Array.from({ length: 201 }, (_, i) => i + 1) })).length, 1);
  assert.equal((await s.client.check({ instrumentIds: [1002] })).reason, 'PROVIDER_COOLDOWN');
  assert.equal(s.calls.length, 1);
});
test('local sliding quota counts actual requests and survives credential rotation', async () => {
  const s = setup(); for (let i = 0; i < 20; i++) await s.client.check(request);
  s.env.ETORO_USER_KEY = 'ROTATE';
  assert.equal((await s.client.check(request)).reason, 'LOCAL_QUOTA');
  assert.equal(s.calls.length, 20);
  s.advance(60000); await s.client.check(request); assert.equal(s.calls.length, 21);
});
test('unknown fields and secret-like known values are excluded from records', async () => {
  const s = setup({ respond: () => new Response(JSON.stringify(payload({ userToken: 'SECRET_USER_KEY', eligibilities: [{ ...row, userToken: 'SECRET_USER_KEY', allowedOrderQuantityType: 'SECRET_USER_KEY' }] }))) });
  const result = await s.registry.refresh(request);
  assert.equal(JSON.stringify(result).includes('SECRET_USER_KEY'), false);
  assert.equal(s.inspect().technicalEligibility, 'INCOMPLETE');
});
test('latest failure cannot fall back to old successful evidence from another batch', async () => {
  let code = 200;
  const s = setup({ respond: () => new Response(JSON.stringify(payload()), { status: code }) });
  await s.registry.refresh(request); code = 403;
  await s.registry.refresh({ symbols: ['AAPL'] });
  assert.equal(s.inspect().technicalEligibility, 'FORBIDDEN');
});
test('timeout and inconsistent leverage config limits fail closed', async () => {
  const s = setup({ timeoutMs: 10, respond: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('SECRET_USER_KEY')))) });
  assert.equal((await s.registry.refresh(request)).reason, 'NETWORK_OR_TIMEOUT_FAILURE');
  const bad = setup({ respond: () => new Response(JSON.stringify(payload({ eligibilities: [{ ...row, leverageConfigs: [{ ...configuration.leverageConfigs[0], minStopLossPercentage: 50, maxStopLossPercentage: 5 }] }] }))) });
  await bad.registry.refresh(request); assert.equal(bad.inspect().technicalEligibility, 'INCOMPLETE');
});
test('missing transaction selectors and false permissions cannot become an eligible open', async () => {
  const s = setup(); await s.registry.refresh(request);
  assert.equal(s.inspect({ operation: {} }).technicalEligibility, 'CONFIGURATION_AVAILABLE_NOT_EVALUATED');
  assert.equal(s.inspect({ operation: { ...operation, direction: undefined } }).technicalEligibility, 'INCOMPLETE');
  const blocked = setup({ respond: () => new Response(JSON.stringify(payload({ eligibilities: [{ ...row, allowOpenPosition: false, allowClosePosition: false }] }))) });
  await blocked.registry.refresh(request);
  assert.equal(blocked.inspect().technicalEligibility, 'BLOCKED');
  assert.equal(blocked.inspect({ operation: { action: 'CLOSE', currency: 'USD', partial: false } }).technicalEligibility, 'BLOCKED');
});
test('symbol resolution cannot silently replace a configured instrument ID', async () => {
  const s = setup({ respond: () => new Response(JSON.stringify(payload({ eligibilities: [{ ...row, instrumentId: 2002 }], notFoundInstrumentIds: [1001] }))) });
  await s.registry.refresh({ instrumentIds: [1001], symbols: ['AAPL'] });
  assert.equal(s.inspect().identification, 'CONTRADICTORY');
  assert.equal(s.inspect().technicalEligibility, 'CONTRADICTORY');
});
test('authenticated HTTP views never execute orders; status is cache-only and refresh is explicit', async () => {
  const names = ['BOT_SECRET', 'ETORO_API_KEY', 'ETORO_USER_KEY', 'ETORO_ACCOUNT_ENV', 'TRADING_MODE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = global.fetch; const calls = [];
  try {
    Object.assign(process.env, { BOT_SECRET: 'TEST_AUTH', ETORO_API_KEY: 'TEST_API', ETORO_USER_KEY: 'TEST_USER', ETORO_ACCOUNT_ENV: 'REAL', TRADING_MODE: 'SHADOW' });
    global.fetch = async (url, init) => { calls.push({ url, method: init.method }); assert.equal(url, ENDPOINT); return new Response(JSON.stringify(payload())); };
    // Importing app does not start its server, scheduler or production preloads.
    const { app } = require('./index');
    const invoke = async (path, method, authenticated, body) => {
      const layer = app._router.stack.find(l => l.route?.path === path && l.route.methods[method]);
      assert.ok(layer);
      let code = 200, output, permitted = false;
      const req = { headers: authenticated ? { 'x-bot-secret': 'TEST_AUTH' } : {}, query: {}, body };
      const res = { status(v) { code = v; return this; }, json(v) { output = v; }, setHeader() {} };
      layer.route.stack[0].handle(req, res, () => { permitted = true; });
      if (permitted) await layer.route.stack[1].handle(req, res);
      return { code, output };
    };
    assert.equal((await invoke('/instrument-eligibility-refresh', 'post', false, request)).code, 401);
    assert.equal(calls.length, 0);
    const view = await invoke('/instrument-eligibility-status', 'get', true);
    assert.equal(view.output.executionAttempted, false);
    assert.ok(view.output.instruments.length > 0);
    assert.equal(calls.length, 0);
    assert.equal((await invoke('/instrument-eligibility-refresh', 'post', true, { ...request, endpoint: '/orders' })).code, 400);
    assert.equal(calls.length, 0);
    const result = await invoke('/instrument-eligibility-refresh', 'post', true, request);
    assert.equal(result.output.result.status, 'AVAILABLE');
    assert.equal(result.output.executionAttempted, false);
    assert.deepEqual(calls, [{ url: ENDPOINT, method: 'POST' }]);
    await invoke('/instrument-eligibility-status', 'get', true);
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = originalFetch;
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
});
