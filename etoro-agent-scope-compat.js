'use strict';

/**
 * eToro agent-token scope compatibility + exact-token binding.
 *
 * Why this preload exists:
 * - eToro's Agent Portfolios response has existed with legacy scope ids 200/202.
 * - Current docs also expose modern scope ids 211/212 plus scopeNames.
 * - Sentinel's current index.js still understands 200/202 only.
 * - Sentinel historically aggregated scopes across every token in one agent portfolio,
 *   which can overstate the permissions of the specific secret loaded in Render.
 *
 * This preload does NOT send orders. It only normalizes GET /api/v1/agent-portfolios
 * responses before index.js reads them.
 */

const API_ORIGIN = 'https://public-api.etoro.com';
const AGENT_PORTFOLIOS_PATH = '/api/v1/agent-portfolios';
const LEGACY_REAL_READ_ID = 200;
const LEGACY_REAL_WRITE_ID = 202;
const MODERN_REAL_READ_ID = 211;
const MODERN_REAL_WRITE_ID = 212;
const REAL_READ_NAMES = new Set([
  'etoro-public:real:read',
  'etoro-public:trade.real:read'
]);
const REAL_WRITE_NAMES = new Set([
  'etoro-public:real:write',
  'etoro-public:trade.real:write'
]);

const originalFetch = global.fetch;
if (typeof originalFetch !== 'function') {
  throw new Error('LEO eToro scope compatibility requires Node.js >= 18 with global fetch.');
}

function nowIso() {
  return new Date().toISOString();
}

function isAgentPortfoliosListRequest(input, init = {}) {
  const url = typeof input === 'string' || input instanceof URL
    ? String(input)
    : String(input && input.url ? input.url : input);
  const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
  if (method !== 'GET') return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === API_ORIGIN && parsed.pathname === AGENT_PORTFOLIOS_PATH;
  } catch {
    return false;
  }
}

function normalizeScopeNames(token) {
  return Array.isArray(token?.scopeNames)
    ? [...new Set(token.scopeNames.map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
}

function normalizeScopeIds(token) {
  const ids = new Set(
    Array.isArray(token?.scopeIds)
      ? token.scopeIds.map(Number).filter(Number.isFinite)
      : []
  );
  const names = normalizeScopeNames(token).map((value) => value.toLowerCase());

  const hasRealRead = ids.has(LEGACY_REAL_READ_ID) ||
    ids.has(MODERN_REAL_READ_ID) ||
    names.some((name) => REAL_READ_NAMES.has(name));
  const hasRealWrite = ids.has(LEGACY_REAL_WRITE_ID) ||
    ids.has(MODERN_REAL_WRITE_ID) ||
    names.some((name) => REAL_WRITE_NAMES.has(name));

  // Add legacy aliases so the existing Sentinel preflight remains compatible.
  if (hasRealRead) ids.add(LEGACY_REAL_READ_ID);
  if (hasRealWrite) ids.add(LEGACY_REAL_WRITE_ID);

  return {
    scopeIds: [...ids].sort((a, b) => a - b),
    scopeNames: normalizeScopeNames(token),
    hasRealRead,
    hasRealWrite
  };
}

function sanitizeTokenMetadata(token) {
  const normalized = normalizeScopeIds(token);
  return {
    userTokenId: token?.userTokenId || null,
    userTokenName: token?.userTokenName || null,
    externalApplicationName: token?.externalApplicationName || null,
    expiresAt: token?.expiresAt || null,
    scopeIds: normalized.scopeIds,
    scopeNames: normalized.scopeNames,
    hasRealRead: normalized.hasRealRead,
    hasRealWrite: normalized.hasRealWrite
  };
}

function bindingConfig(env = process.env) {
  const live = String(env.TRADING_MODE || '').trim().toUpperCase() === 'LIVE';
  const armed = String(env.LIVE_EXECUTION_ARMED || '').toLowerCase() === 'true';
  const expectedUserTokenId = String(env.ETORO_EXPECTED_USER_TOKEN_ID || '').trim();
  const strictFromEnv = String(env.ETORO_REQUIRE_EXACT_USER_TOKEN || '').trim().toLowerCase();
  const strict = strictFromEnv === 'true' || (strictFromEnv !== 'false' && live && armed);
  return { live, armed, strict, expectedUserTokenId };
}

function transformAgentPortfoliosPayload(payload, env = process.env) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.agentPortfolios)) {
    return { payload, audit: { transformed: false, reason: 'UNEXPECTED_PAYLOAD' } };
  }

  const config = bindingConfig(env);
  let exactTokenMatched = false;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;
  const availableTokens = [];

  const agentPortfolios = payload.agentPortfolios.map((portfolio) => {
    const tokens = Array.isArray(portfolio?.userTokens) ? portfolio.userTokens : [];
    totalTokensBefore += tokens.length;

    const normalizedTokens = tokens.map((token) => {
      const normalized = normalizeScopeIds(token);
      availableTokens.push(sanitizeTokenMetadata(token));
      return {
        ...token,
        scopeIds: normalized.scopeIds,
        scopeNames: normalized.scopeNames
      };
    });

    let selectedTokens = normalizedTokens;
    if (config.expectedUserTokenId) {
      selectedTokens = normalizedTokens.filter(
        (token) => String(token?.userTokenId || '') === config.expectedUserTokenId
      );
      if (selectedTokens.length > 0) exactTokenMatched = true;
    } else if (config.strict) {
      // Fail closed in armed LIVE mode: do not let index.js aggregate unrelated tokens.
      selectedTokens = [];
    }

    totalTokensAfter += selectedTokens.length;
    return { ...portfolio, userTokens: selectedTokens };
  });

  const bindingState = config.expectedUserTokenId
    ? (exactTokenMatched ? 'EXACT_TOKEN_MATCHED' : 'EXPECTED_TOKEN_NOT_FOUND')
    : (config.strict ? 'EXPECTED_TOKEN_ID_REQUIRED' : 'AGGREGATE_COMPAT_MODE');

  return {
    payload: { ...payload, agentPortfolios },
    audit: {
      transformed: true,
      bindingState,
      strict: config.strict,
      live: config.live,
      armed: config.armed,
      expectedUserTokenConfigured: Boolean(config.expectedUserTokenId),
      exactTokenMatched,
      totalTokensBefore,
      totalTokensAfter,
      availableTokens
    }
  };
}

function logAudit(audit) {
  const level = ['EXPECTED_TOKEN_NOT_FOUND', 'EXPECTED_TOKEN_ID_REQUIRED'].includes(audit?.bindingState)
    ? 'warn'
    : 'log';
  const logger = console[level] || console.log;
  logger.call(console, `[LEO_ETORO_AGENT_TOKEN_SCOPE] ${JSON.stringify({
    at: nowIso(),
    ...audit
  })}`);
  global.__LEO_ETORO_AGENT_TOKEN_SCOPE_STATE__ = { at: nowIso(), ...audit };
}

async function rewriteAgentPortfolioResponse(response) {
  if (!response || !response.ok) return response;
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  const transformed = transformAgentPortfoliosPayload(payload);
  if (!transformed.audit.transformed) return response;
  logAudit(transformed.audit);

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');

  return new Response(JSON.stringify(transformed.payload), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

global.fetch = async function leoEtoroAgentScopeFetch(input, init = {}) {
  const response = await originalFetch(input, init);
  if (!isAgentPortfoliosListRequest(input, init)) return response;
  return rewriteAgentPortfolioResponse(response);
};

console.log(JSON.stringify({
  component: 'LEO_ETORO_AGENT_TOKEN_SCOPE_COMPAT',
  enabled: true,
  legacyRealReadId: LEGACY_REAL_READ_ID,
  legacyRealWriteId: LEGACY_REAL_WRITE_ID,
  modernRealReadId: MODERN_REAL_READ_ID,
  modernRealWriteId: MODERN_REAL_WRITE_ID,
  strictExactTokenBinding: bindingConfig().strict,
  expectedUserTokenConfigured: Boolean(bindingConfig().expectedUserTokenId),
  sendsOrders: false
}));

module.exports = {
  bindingConfig,
  isAgentPortfoliosListRequest,
  normalizeScopeIds,
  sanitizeTokenMetadata,
  transformAgentPortfoliosPayload
};
