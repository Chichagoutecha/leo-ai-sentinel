'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, createReadClient, PATHS } = require('./etoro-read-access-audit');
const env = { ETORO_API_KEY: 'SECRET_API_ABC', ETORO_USER_KEY: 'SECRET_USER_DEF', ETORO_EXPECTED_AGENT_PORTFOLIO_ID: 'agent-1', ETORO_EXPECTED_AGENT_PORTFOLIO_GCID: '123', ETORO_EXPECTED_USER_TOKEN_ID: 'token-1' };
const token = { userTokenId: 'token-1', scopeIds: [211], scopeNames: ['etoro-public:trade.real:read'] };
const agent = { agentPortfolioId: 'agent-1', agentPortfolioGcid: 123, userTokens: [token] };
function transport({ me = { gcid: 123, scopes: ['etoro-public:trade.real:read'] }, agents = [agent], codes = {}, calls = [] } = {}) {
  return async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method, redirect: options.redirect });
    const status = codes[path] || 200;
    const body = status >= 400 ? { error: env.ETORO_USER_KEY } : path === PATHS[0] ? me : path === PATHS[1] ? { agentPortfolios: agents } : { clientPortfolio: { credit: 987654, positions: [{ secret: env.ETORO_USER_KEY }] } };
    return new Response(JSON.stringify(body), { status });
  };
}
test('missing keys produce three NOT_TESTED checks and zero network calls', async () => {
  const report = await audit({ fetchImpl: () => { throw Error('must not call'); } });
  assert.equal(report.requests, 0);
  assert.ok(report.checks.every(c => c.status === 'NOT_TESTED'));
});
test('exact metadata match never proves binding of loaded secret or PnL ownership', async () => {
  const report = await audit({ env, fetchImpl: transport() });
  assert.equal(report.agentMetadataMatch, 'MATCH');
  assert.equal(report.authenticatedIdentityToAgent, 'MATCH');
  assert.equal(report.tokenMetadataMatch, 'MATCH');
  assert.equal(report.tokenBinding, 'TOKEN_BINDING_UNVERIFIED');
  assert.equal(report.provenWriteAccess, 'NOT_TESTED');
  assert.match(report.pnlAttribution, /^UNVERIFIED/);
});
test('multiple accounts and tokens are never selected by first-row heuristic', async () => {
  const report = await audit({ env: { ...env, ETORO_EXPECTED_AGENT_PORTFOLIO_ID: '', ETORO_EXPECTED_AGENT_PORTFOLIO_GCID: '' }, fetchImpl: transport({ agents: [agent, { ...agent, agentPortfolioId: 'agent-2' }] }) });
  assert.equal(report.agentMetadataMatch, 'UNVERIFIED');
  assert.equal(report.tokenMetadataMatch, 'UNVERIFIED');
  const duplicate = await audit({ env, fetchImpl: transport({ agents: [agent, agent] }) });
  assert.equal(duplicate.agentMetadataMatch, 'AMBIGUOUS');
  const duplicateTokens = await audit({ env, fetchImpl: transport({ agents: [{ ...agent, userTokens: [token, token] }] }) });
  assert.equal(duplicateTokens.tokenMetadataMatch, 'AMBIGUOUS');
});
test('conflicting selectors and authenticated identity mismatches are explicit', async () => {
  const mismatch = await audit({ env: { ...env, ETORO_EXPECTED_AGENT_PORTFOLIO_GCID: '999' }, fetchImpl: transport() });
  assert.equal(mismatch.agentMetadataMatch, 'MISMATCH');
  const identity = await audit({ env, fetchImpl: transport({ me: { gcid: 999 } }) });
  assert.equal(identity.authenticatedIdentityToAgent, 'MISMATCH');
});
test('permissions belong only to selected token; conflicting names and ids are flagged', async () => {
  const report = await audit({ env, fetchImpl: transport({ agents: [{ ...agent, userTokens: [{ ...token, scopeIds: [212] }, { userTokenId: 'other', scopeIds: [211, 212] }] }] }) });
  assert.equal(report.selectedTokenMetadataPermissions.realRead, 'CONTRADICTORY');
  assert.equal(report.selectedTokenMetadataPermissions.realWrite, 'CONTRADICTORY');
  assert.equal(report.currentCredentialReportedPermissions.realWrite, 'NOT_REPORTED');
});
test('401 and 403 are not retried, and denied discovery does not suppress PnL read', async () => {
  const calls = [];
  const report = await audit({ env, fetchImpl: transport({ calls, codes: { [PATHS[0]]: 401, [PATHS[1]]: 403 } }) });
  assert.equal(report.requests, 3);
  assert.deepEqual(report.checks.map(c => c.status), ['UNAUTHORIZED', 'FORBIDDEN', 'VERIFIED_READ']);
});
test('unexpected successful schemas do not claim a verified read', async () => {
  const report = await audit({ env, fetchImpl: async () => new Response('{"error":"SECRET_USER_DEF"}') });
  assert.ok(report.checks.every(c => c.status === 'UNAVAILABLE' && c.expectedStructure === 'ABSENT'));
});
test('response secrets, personal details, ids, balances and provider errors never escape report', async () => {
  const report = await audit({ env, fetchImpl: transport({ me: { gcid: 123, username: 'PRIVATE_NAME', userToken: env.ETORO_USER_KEY } }) });
  const output = JSON.stringify(report);
  for (const secret of [...Object.values(env), 'PRIVATE_NAME', '987654']) assert.equal(output.includes(secret), false);
  const failure = await audit({ env, fetchImpl: async () => { throw Error('LEAK ' + env.ETORO_USER_KEY); } });
  assert.equal(JSON.stringify(failure).includes(env.ETORO_USER_KEY), false);
  assert.equal(failure.requests, 6);
});
test('guard rejects methods, hosts, queries, writes and guessed endpoints before transport', async () => {
  let calls = 0;
  const client = createReadClient({ env, fetchImpl: () => { calls++; throw Error('unexpected'); } });
  for (const [path, method] of [[PATHS[0], 'POST'], [PATHS[0], 'DELETE'], ['/api/v2/trading/copy', 'GET'], ['https://evil.example/api/v1/me', 'GET'], [PATHS[0] + '?secret=x', 'GET'], ['/api/v1/agent-portfolios/x', 'GET']]) {
    assert.equal((await client.read(path, { method })).reason, 'REQUEST_NOT_ALLOWLISTED');
  }
  assert.equal(calls, 0);
});
test('transient retries and request budget are bounded; rate limits stop immediately', async () => {
  const report = await audit({ env, maxRequests: 4, fetchImpl: async () => new Response('{}', { status: 500 }) });
  assert.equal(report.requests, 4);
  assert.equal(report.checks[2].reason, 'REQUEST_BUDGET_EXHAUSTED');
  const quota = await audit({ env, fetchImpl: async () => new Response('{}', { status: 429 }) });
  assert.equal(quota.requests, 3);
});
test('redirects are forbidden and selected environment is never silently changed', async () => {
  const calls = [];
  const report = await audit({ env: { ...env, ETORO_ACCOUNT_ENV: 'DEMO' }, fetchImpl: transport({ calls }) });
  assert.equal(report.checks[2].environment, 'DEMO');
  assert.ok(calls.every(c => c.redirect === 'error' && c.method === 'GET'));
  assert.equal(calls[2].path, PATHS[3]);
  const bad = await audit({ env: { ...env, ETORO_ACCOUNT_ENV: 'bad' }, fetchImpl: transport() });
  assert.equal(bad.requests, 0);
});
test('deadline aborts stalled reads without printing the error', async () => {
  const client = createReadClient({ env, timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('PRIVATE TIMEOUT')))) });
  assert.equal((await client.read(PATHS[0])).reason, 'NETWORK_OR_TIMEOUT_FAILURE');
  assert.equal(client.count, 2);
});
