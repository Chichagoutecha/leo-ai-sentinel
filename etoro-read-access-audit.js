'use strict';
// Standalone: never import index.js or production fetch preloads.
const { randomUUID } = require('node:crypto');
const ORIGIN = 'https://public-api.etoro.com';
const PATHS = Object.freeze(['/api/v1/me', '/api/v1/agent-portfolios', '/api/v1/trading/info/real/pnl', '/api/v1/trading/info/demo/pnl']);
const id = value => (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ? String(value).trim() : null;
const match = (actual, expected) => !id(actual) || !id(expected) ? 'UNVERIFIED' : id(actual) === id(expected) ? 'MATCH' : 'MISMATCH';
function permissionEvidence(token = {}) {
  const names = Array.isArray(token.scopeNames) ? token.scopeNames : Array.isArray(token.scopes) ? token.scopes : null;
  const ids = Array.isArray(token.scopeIds) ? token.scopeIds : null;
  const result = {};
  for (const [key, aliases, numeric] of [
    ['realRead', ['etoro-public:real:read', 'etoro-public:trade.real:read'], [200, 211]],
    ['realWrite', ['etoro-public:real:write', 'etoro-public:trade.real:write'], [202, 212]]
  ]) {
    const byName = names === null ? null : aliases.some(x => names.includes(x));
    const byId = ids === null ? null : numeric.some(x => ids.includes(x));
    result[key] = byName !== null && byId !== null && byName !== byId ? 'CONTRADICTORY'
      : byName === true || byId === true ? 'REPORTED' : names === null && ids === null ? 'UNKNOWN' : 'NOT_REPORTED';
  }
  return result;
}
function createReadClient({ env = {}, fetchImpl = global.fetch, timeoutMs = 8000, maxRequests = 6 } = {}) {
  let count = 0;
  const timeout = Number.isFinite(timeoutMs) ? Math.max(10, Math.min(10000, timeoutMs)) : 8000;
  const budget = Number.isSafeInteger(maxRequests) ? Math.max(0, Math.min(6, maxRequests)) : 6;
  return {
    get count() { return count; },
    async read(path, { method = 'GET' } = {}) {
      if (method !== 'GET' || !PATHS.includes(path)) return { status: 'UNAVAILABLE', reason: 'REQUEST_NOT_ALLOWLISTED', httpStatus: null, data: null };
      if (!env.ETORO_API_KEY || !env.ETORO_USER_KEY) return { status: 'NOT_TESTED', reason: 'CREDENTIALS_ABSENT', httpStatus: null, data: null };
      for (let attempt = 0; attempt < 2; attempt++) {
        if (count >= budget) return { status: 'NOT_TESTED', reason: 'REQUEST_BUDGET_EXHAUSTED', httpStatus: null, data: null };
        count++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetchImpl(ORIGIN + path, { method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { 'x-api-key': env.ETORO_API_KEY, 'x-user-key': env.ETORO_USER_KEY, 'x-request-id': randomUUID() } });
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            return { status: response.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', reason: 'ACCESS_DENIED', httpStatus: response.status, data: null };
          }
          if (response.status === 429 || response.status >= 500) {
            await response.body?.cancel();
            // No immediate retry on quota responses: respect server limits by stopping.
            if (response.status !== 429 && attempt === 0) continue;
            return { status: 'UNAVAILABLE', reason: 'TRANSIENT_HTTP_FAILURE', httpStatus: response.status, data: null };
          }
          if (!response.ok) { await response.body?.cancel(); return { status: 'UNAVAILABLE', reason: 'HTTP_FAILURE', httpStatus: response.status, data: null }; }
          const reader = response.body?.getReader();
          if (!reader) return { status: 'UNAVAILABLE', reason: 'EMPTY_BODY', httpStatus: response.status, data: null };
          let bytes = 0; const chunks = [];
          while (true) {
            const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 2 * 1024 * 1024) { await reader.cancel(); return { status: 'UNAVAILABLE', reason: 'BODY_LIMIT', httpStatus: response.status, data: null }; }
            chunks.push(Buffer.from(part.value));
          }
          let data;
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return { status: 'UNAVAILABLE', reason: 'INVALID_JSON', httpStatus: response.status, data: null }; }
          return { status: 'VERIFIED_READ', reason: null, httpStatus: response.status, data };
        } catch {
          // Never return provider error messages, URLs, headers, or response bodies.
          if (attempt === 1) return { status: 'UNAVAILABLE', reason: 'NETWORK_OR_TIMEOUT_FAILURE', httpStatus: null, data: null };
        } finally { clearTimeout(timer); }
      }
    }
  };
}
async function audit({ env = {}, fetchImpl = global.fetch, timeoutMs, maxRequests } = {}) {
  const client = createReadClient({ env, fetchImpl, timeoutMs, maxRequests });
  const requestedEnvironment = String(env.ETORO_ACCOUNT_ENV || 'REAL').toUpperCase();
  if (!['REAL', 'DEMO'].includes(requestedEnvironment)) return { status: 'NOT_TESTED', reason: 'INVALID_ACCOUNT_ENVIRONMENT', requests: 0 };
  const paths = [PATHS[0], PATHS[1], `/api/v1/trading/info/${requestedEnvironment.toLowerCase()}/pnl`];
  const results = [];
  for (const path of paths) results.push(await client.read(path));
  const [identity, agents, pnl] = results;
  const identityValid = identity.status === 'VERIFIED_READ' && id(identity.data?.gcid) !== null;
  const agentsValid = agents.status === 'VERIFIED_READ' && Array.isArray(agents.data?.agentPortfolios);
  const pnlValid = pnl.status === 'VERIFIED_READ' && pnl.data?.clientPortfolio && typeof pnl.data.clientPortfolio === 'object' && !Array.isArray(pnl.data.clientPortfolio) && Array.isArray(pnl.data.clientPortfolio.positions) &&
    typeof pnl.data.clientPortfolio.credit === 'number' && Number.isFinite(pnl.data.clientPortfolio.credit);
  const expectedAgent = id(env.ETORO_EXPECTED_AGENT_PORTFOLIO_ID || env.ETORO_EXPECTED_PORTFOLIO_ID);
  const expectedGcid = id(env.ETORO_EXPECTED_AGENT_PORTFOLIO_GCID);
  const expectedMirror = id(env.ETORO_EXPECTED_MIRROR_ID);
  const expectedToken = id(env.ETORO_EXPECTED_USER_TOKEN_ID);
  const hasSelector = Boolean(expectedAgent || expectedGcid || expectedMirror);
  const candidates = agentsValid && hasSelector ? agents.data.agentPortfolios.filter(p => p &&
    (!expectedAgent || id(p.agentPortfolioId) === expectedAgent) &&
    (!expectedGcid || id(p.agentPortfolioGcid) === expectedGcid) &&
    (!expectedMirror || id(p.mirrorId) === expectedMirror)) : [];
  const selected = candidates.length === 1 ? candidates[0] : null;
  const tokens = selected && expectedToken && Array.isArray(selected.userTokens) ? selected.userTokens.filter(t => id(t?.userTokenId) === expectedToken) : [];
  const token = tokens.length === 1 ? tokens[0] : null;
  const accountMatch = selected && identityValid ? match(identity.data.gcid, selected.agentPortfolioGcid) : 'UNVERIFIED';
  const report = {
    generatedAt: new Date().toISOString(), readOnly: true, requests: client.count,
    credentials: { apiKeyPresent: Boolean(env.ETORO_API_KEY), userKeyPresent: Boolean(env.ETORO_USER_KEY), provenance: 'CALLER_PROCESS_ENVIRONMENT' },
    configuredContext: ['AGENT', 'ACCOUNT', 'AUTO'].includes(env.ETORO_PORTFOLIO_CONTEXT) ? env.ETORO_PORTFOLIO_CONTEXT : 'AUTO',
    contextEvidence: accountMatch === 'MATCH' ? 'AGENT_IDENTITY_MATCHED_TO_SELECTED_METADATA' : 'UNVERIFIED',
    agentMetadataMatch: !agentsValid || !hasSelector ? 'UNVERIFIED' : candidates.length > 1 ? 'AMBIGUOUS' : selected ? 'MATCH' : 'MISMATCH',
    authenticatedIdentityToAgent: accountMatch,
    tokenMetadataMatch: !selected || !expectedToken ? 'UNVERIFIED' : tokens.length > 1 ? 'AMBIGUOUS' : token ? 'MATCH' : 'MISMATCH',
    tokenBinding: 'TOKEN_BINDING_UNVERIFIED',
    currentCredentialReportedPermissions: identityValid ? permissionEvidence(identity.data) : permissionEvidence(),
    selectedTokenMetadataPermissions: token ? permissionEvidence(token) : permissionEvidence(),
    provenWriteAccess: 'NOT_TESTED',
    pnlAttribution: 'UNVERIFIED_NO_DOCUMENTED_IDENTITY_FIELD_COMPARED',
    checks: results.map((r, i) => {
      const valid = [identityValid, agentsValid, Boolean(pnlValid)][i];
      return { capability: ['AUTHENTICATED_IDENTITY', 'AGENT_DISCOVERY', 'PNL_READ'][i], endpoint: ORIGIN + paths[i], method: 'GET',
        environment: i === 2 ? requestedEnvironment : 'IDENTITY_OR_METADATA', checkedAt: new Date().toISOString(),
        status: r.status === 'VERIFIED_READ' && !valid ? 'UNAVAILABLE' : r.status, httpStatus: r.httpStatus,
        expectedStructure: r.status === 'VERIFIED_READ' ? valid ? 'PRESENT' : 'ABSENT' : 'NOT_TESTED',
        reason: r.status === 'VERIFIED_READ' && !valid ? 'UNEXPECTED_SCHEMA' : r.reason };
    }),
    limitations: ['METADATA_MATCH_DOES_NOT_BIND_LOADED_SECRET', 'READ_SUCCESS_DOES_NOT_PROVE_WRITE_ACCESS', 'PNL_READ_DOES_NOT_PROVE_SOCIAL_OR_COPY_ACCESS', 'CONFIGURED_CONTEXT_IS_NOT_IDENTITY_PROOF']
  };
  return report;
}
module.exports = { audit, createReadClient, permissionEvidence, PATHS };
if (require.main === module) {
  audit({ env: process.env }).then(report => process.stdout.write(JSON.stringify(report, null, 2) + '\n'))
    .catch(() => { process.stdout.write('{"status":"UNAVAILABLE","reason":"AUDIT_FAILED"}\n'); process.exitCode = 1; });
}
