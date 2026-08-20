'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bindingConfig,
  normalizeScopeIds,
  transformAgentPortfoliosPayload
} = require('./etoro-agent-scope-compat');

test('legacy 200/202 remain valid', () => {
  const result = normalizeScopeIds({ scopeIds: [200, 202] });
  assert.equal(result.hasRealRead, true);
  assert.equal(result.hasRealWrite, true);
  assert.ok(result.scopeIds.includes(200));
  assert.ok(result.scopeIds.includes(202));
});

test('modern 211/212 are aliased to legacy 200/202', () => {
  const result = normalizeScopeIds({ scopeIds: [211, 212] });
  assert.equal(result.hasRealRead, true);
  assert.equal(result.hasRealWrite, true);
  assert.ok(result.scopeIds.includes(200));
  assert.ok(result.scopeIds.includes(202));
  assert.ok(result.scopeIds.includes(211));
  assert.ok(result.scopeIds.includes(212));
});

test('modern scope names are recognized even without ids', () => {
  const result = normalizeScopeIds({
    scopeNames: [
      'etoro-public:trade.real:read',
      'etoro-public:trade.real:write'
    ]
  });
  assert.equal(result.hasRealRead, true);
  assert.equal(result.hasRealWrite, true);
  assert.ok(result.scopeIds.includes(200));
  assert.ok(result.scopeIds.includes(202));
});

test('armed LIVE defaults to strict exact-token binding', () => {
  const config = bindingConfig({ TRADING_MODE: 'LIVE', LIVE_EXECUTION_ARMED: 'true' });
  assert.equal(config.strict, true);
  assert.equal(config.expectedUserTokenId, '');
});

test('strict LIVE without expected token id fails closed', () => {
  const input = {
    agentPortfolios: [{
      agentPortfolioId: 'portfolio-1',
      userTokens: [
        { userTokenId: 'read-only', scopeIds: [211] },
        { userTokenId: 'write-token', scopeIds: [211, 212] }
      ]
    }]
  };
  const result = transformAgentPortfoliosPayload(input, {
    TRADING_MODE: 'LIVE',
    LIVE_EXECUTION_ARMED: 'true'
  });
  assert.equal(result.audit.bindingState, 'EXPECTED_TOKEN_ID_REQUIRED');
  assert.equal(result.payload.agentPortfolios[0].userTokens.length, 0);
});

test('exact token binding prevents scope aggregation from another token', () => {
  const input = {
    agentPortfolios: [{
      agentPortfolioId: 'portfolio-1',
      userTokens: [
        { userTokenId: 'render-token', scopeIds: [211] },
        { userTokenId: 'other-write-token', scopeIds: [211, 212] }
      ]
    }]
  };
  const result = transformAgentPortfoliosPayload(input, {
    TRADING_MODE: 'LIVE',
    LIVE_EXECUTION_ARMED: 'true',
    ETORO_EXPECTED_USER_TOKEN_ID: 'render-token'
  });
  const tokens = result.payload.agentPortfolios[0].userTokens;
  assert.equal(result.audit.bindingState, 'EXACT_TOKEN_MATCHED');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].userTokenId, 'render-token');
  assert.ok(tokens[0].scopeIds.includes(200));
  assert.equal(tokens[0].scopeIds.includes(202), false);
});

test('missing expected token fails closed', () => {
  const input = {
    agentPortfolios: [{
      agentPortfolioId: 'portfolio-1',
      userTokens: [{ userTokenId: 'other-token', scopeIds: [211, 212] }]
    }]
  };
  const result = transformAgentPortfoliosPayload(input, {
    TRADING_MODE: 'LIVE',
    LIVE_EXECUTION_ARMED: 'true',
    ETORO_EXPECTED_USER_TOKEN_ID: 'render-token'
  });
  assert.equal(result.audit.bindingState, 'EXPECTED_TOKEN_NOT_FOUND');
  assert.equal(result.payload.agentPortfolios[0].userTokens.length, 0);
});
