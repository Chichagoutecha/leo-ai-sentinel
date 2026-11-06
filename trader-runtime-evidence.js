'use strict';

const { createPublicKey, verify } = require('node:crypto');
const { createReadClient, permissionEvidence } = require('./etoro-read-access-audit');
const { createCostClient } = require('./etoro-trading-costs');

const positive = n => Number.isFinite(n) && n > 0;
const nonnegative = n => Number.isFinite(n) && n >= 0;
const fresh = (at, now, max = 300000) => Number.isFinite(Date.parse(at)) && now >= Date.parse(at) && now - Date.parse(at) <= max;
const id = value => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)) || (Number.isSafeInteger(value) && value > 0) ? String(value) : null;
const trustedUrl = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && ['www.etoro.com', 'api-portal.etoro.com'].includes(u.hostname) && !u.search && !u.hash && !u.username && !u.password; } catch { return false; }
};

function verifyReceipt(envelope, env, now) {
  const p = envelope?.payload;
  if (!p || !env.TRADER_PROVISIONING_PUBLIC_KEY || !env.ETORO_CREDENTIAL_REVISION) return { status: 'UNAVAILABLE', reason: 'PROVISIONING_RECEIPT_REQUIRED' };
  if (Object.keys(envelope).some(k => !['payload', 'signature'].includes(k)) ||
      Object.keys(p).some(k => !['kind', 'environment', 'contextKind', 'accountRef', 'gcid', 'realCid', 'tokenId', 'credentialRevision', 'issuedAt', 'expiresAt', 'closeTerms'].includes(k)) ||
      p.closeTerms !== undefined && (!Array.isArray(p.closeTerms) || p.closeTerms.length > 100 || p.closeTerms.some(r => !r || Object.keys(r).some(k =>
        !['instrumentId', 'currency', 'sourceUrl', 'sourceAsOf', 'sourceCheckedAt', 'feeComponentsComplete', 'minimumUsd', 'maximumUsd', 'minimumUnits', 'maximumUnits', 'fixedFeeUsd', 'feeBps'].includes(k))))) return { status: 'UNAVAILABLE', reason: 'PROVISIONING_SCHEMA_INVALID' };
  if ([env.ETORO_API_KEY, env.ETORO_USER_KEY].some(secret => typeof secret === 'string' && secret.length && JSON.stringify(p).includes(secret))) return { status: 'UNAVAILABLE', reason: 'PROVISIONING_SCHEMA_INVALID' };
  const expectedAccount = p.contextKind === 'AGENT' ? env.ETORO_EXPECTED_AGENT_PORTFOLIO_ID || env.ETORO_EXPECTED_PORTFOLIO_ID : env.ETORO_EXPECTED_PORTFOLIO_ID;
  if (expectedAccount && String(expectedAccount) !== String(p.accountRef) || p.contextKind === 'AGENT' && env.ETORO_EXPECTED_AGENT_PORTFOLIO_GCID && String(env.ETORO_EXPECTED_AGENT_PORTFOLIO_GCID) !== String(p.gcid)) return { status: 'UNAVAILABLE', reason: 'PROVISIONING_ACCOUNT_SELECTOR_MISMATCH' };
  if (p.kind !== 'ETORO_CREDENTIAL_PROVISIONING' || p.environment !== 'REAL' || !['ACCOUNT', 'AGENT'].includes(p.contextKind) ||
      !id(p.accountRef) || !id(p.gcid) || !id(p.realCid) || !id(p.tokenId) || p.credentialRevision !== env.ETORO_CREDENTIAL_REVISION ||
      !fresh(p.issuedAt, now, 86400000) || !(Date.parse(p.expiresAt) > now) || Date.parse(p.expiresAt) - Date.parse(p.issuedAt) > 86400000 ||
      env.ETORO_EXPECTED_USER_TOKEN_ID && String(p.tokenId) !== String(env.ETORO_EXPECTED_USER_TOKEN_ID) ||
      env.ETORO_PORTFOLIO_CONTEXT && env.ETORO_PORTFOLIO_CONTEXT !== 'AUTO' && env.ETORO_PORTFOLIO_CONTEXT !== p.contextKind) return { status: 'UNAVAILABLE', reason: 'PROVISIONING_RECEIPT_MISMATCH_OR_EXPIRED' };
  try {
    const key = createPublicKey(env.TRADER_PROVISIONING_PUBLIC_KEY);
    if (key.asymmetricKeyType !== 'ed25519' || typeof envelope.signature !== 'string' || envelope.signature.length > 128 ||
        !verify(null, Buffer.from(JSON.stringify(p)), key, Buffer.from(envelope.signature, 'base64'))) throw Error('INVALID_RECEIPT');
  } catch { return { status: 'UNAVAILABLE', reason: 'PROVISIONING_SIGNATURE_UNVERIFIED' }; }
  return { status: 'VERIFIED_OPERATOR_ATTESTATION', payload: p };
}

function eligibilityEvidence(cached, proposal, quote, accountRef, now) {
  const unavailable = { status: 'UNAVAILABLE', reason: 'ELIGIBILITY_PRODUCT_OR_LIMITS_UNAVAILABLE' };
  if (cached.identification !== 'IDENTIFIED' || cached.configurationFreshness !== 'AVAILABLE' || cached.configurationIssues?.length ||
      cached.context?.environment !== 'REAL' || cached.currency !== 'USD' || !fresh(cached.fetchedAt, now)) return unavailable;
  const c = cached.configuration;
  if (proposal.side === 'SELL') {
    if (typeof c?.allowClosePosition !== 'boolean') return unavailable;
    return { status: 'AVAILABLE', instrumentId: proposal.instrumentId, side: 'SELL', accountRef, asOf: cached.fetchedAt,
      contextBinding: 'VERIFIED_SAME_ACCOUNT', technicalEligible: c.allowClosePosition, allowed: c.allowClosePosition,
      leoPolicyAllowed: cached.leoAuthorization === 'AUTHORIZED_BY_CALLER_POLICY', currency: 'USD', leverage: 1,
      orderType: 'MARKET', settlementType: 'Underlying', productBasis: 'EXACT_MANAGED_POSITION_CHECK_REQUIRED', source: cached.source };
  }
  const configs = c?.leverageConfigs?.filter(r => ['Underlying', 'real'].includes(r.settlementType) && r.direction === 'LONG' && r.isPotential === false && r.leverageValues?.includes(1));
  if (configs?.length !== 1 || !positive(c.maxUnitsPerOrder) || !nonnegative(c.minPositionExposure) || !nonnegative(configs[0].minPositionAmount) ||
      c.requiresW8Ben !== false || !['Amount', 'Both'].includes(c.allowedOrderQuantityType) || !positive(quote.bid) || !positive(quote.ask)) return unavailable;
  const minimumUsd = Math.max(c.minPositionExposure, configs[0].minPositionAmount);
  const maximumUsd = c.maxUnitsPerOrder * quote.bid * (1 - proposal.priceDriftLimitPct / 100);
  if (!positive(maximumUsd) || maximumUsd < minimumUsd) return unavailable;
  return { status: 'AVAILABLE', instrumentId: proposal.instrumentId, side: proposal.side, accountRef, asOf: cached.fetchedAt,
    contextBinding: 'VERIFIED_SAME_ACCOUNT', technicalEligible: proposal.side === 'BUY' ? c.allowOpenPosition === true : c.allowClosePosition === true,
    allowed: proposal.side === 'BUY' ? c.allowOpenPosition === true : c.allowClosePosition === true,
    leoPolicyAllowed: cached.leoAuthorization === 'AUTHORIZED_BY_CALLER_POLICY', minimumUsd, maximumUsd, maximumUnits: c.maxUnitsPerOrder,
    currency: 'USD', leverage: 1, orderType: 'MARKET', settlementType: 'Underlying', source: cached.source };
}

function sizingEvidence(view, binding, now) {
  if (!binding || !fresh(view?.owned?.fetchedAt, now) || view?.owned?.coverage !== 'COMPLETE' || !view.owned.fresh || view.owned.unreconstructedRisk.length ||
      view.pending?.status !== 'COMPLETE_KNOWN_BUY_UPPER_BOUND' || view.pending.orders.length || view.owned.nativeCopies?.absent !== true ||
      !nonnegative(view.owned.creditUsd) || view.owned.rows.some(r => r.ownership !== 'DIRECT' || !['STOCK', 'CRYPTO'].includes(r.category) ||
        r.pnlBasis !== 'DOCUMENTED_UNREALIZED_PNL' || !nonnegative(r.estimatedValueUsd))) return null;
  const equityUsd = view.owned.creditUsd + view.owned.rows.reduce((sum, row) => sum + row.estimatedValueUsd, 0);
  if (!positive(equityUsd)) return null;
  return { verified: true, accountRef: binding.accountRef, sourceType: 'OFFICIAL_ETORO_API',
    sourceUrl: 'https://public-api.etoro.com/api/v1/trading/info/real/pnl', asOf: view.owned.fetchedAt, currency: 'USD',
    lookThroughCoverage: 'COMPLETE', equityUsd, availableCashUsd: view.owned.creditUsd,
    coverageBasis: 'COMPLETE_DIRECT_STOCK_OR_CRYPTO_INSTRUMENT_VALUES; DIMENSION_TAXONOMY_REMAINS_SEPARATE' };
}

function closeEvidence(receipt, cached, proposal, quote, positions, accountRef, now) {
  const terms = receipt?.closeTerms?.filter(r => r.instrumentId === proposal.instrumentId);
  const raw = terms?.length === 1 ? terms[0] : null;
  if (!raw || !trustedUrl(raw.sourceUrl) || !fresh(raw.sourceCheckedAt, now, 86400000) || !Number.isFinite(Date.parse(raw.sourceAsOf)) || Date.parse(raw.sourceAsOf) > now || raw.currency !== 'USD' || raw.feeComponentsComplete !== true ||
      !nonnegative(raw.minimumUsd) || !positive(raw.maximumUsd) || !nonnegative(raw.minimumUnits) || !positive(raw.maximumUnits) ||
      raw.maximumUsd < raw.minimumUsd || raw.maximumUnits < raw.minimumUnits || !nonnegative(raw.fixedFeeUsd) || !nonnegative(raw.feeBps) ||
      cached.configuration?.allowClosePosition !== true || !fresh(cached.fetchedAt, now) || !positive(quote.bid) || !positive(quote.ask) || quote.ask < quote.bid) return null;
  const entry = proposal.side === 'BUY', drift = entry ? proposal.priceDriftLimitPct / 100 : 0;
  if (!(drift >= 0 && drift < 1)) return null;
  const minUnits = entry ? proposal.amountUsd / (quote.ask * (1 + drift)) : proposal.units;
  const maxUnits = entry ? proposal.amountUsd / (quote.bid * (1 - drift)) : proposal.units;
  const held = entry ? positions.filter(r => r.instrumentId === proposal.instrumentId).reduce((sum, r) => sum + r.units, 0) : 0;
  const stressedUsd = (maxUnits + held) * quote.ask * (1 + drift);
  const maximumCostUsd = raw.fixedFeeUsd + raw.feeBps / 10000 * stressedUsd + (quote.ask - quote.bid) * (maxUnits + held);
  if (!positive(minUnits) || !positive(maxUnits) || !nonnegative(held) || !nonnegative(maximumCostUsd)) return null;
  return { accountRef, proposalId: proposal.proposalId, instrumentId: proposal.instrumentId, asOf: new Date(now).toISOString(),
    sourceAsOf: raw.sourceAsOf, sourceCheckedAt: raw.sourceCheckedAt, source: raw.sourceUrl, sourceType: 'OPERATOR_REVIEWED_OFFICIAL_TERMS', currency: 'USD',
    settlementType: 'Underlying', leverage: 1, fullCloseAllowed: true, minimumUsd: raw.minimumUsd, maximumUsd: raw.maximumUsd,
    minimumUnits: raw.minimumUnits, maximumUnits: positive(cached.configuration.maxUnitsPerOrder) ? Math.min(raw.maximumUnits, cached.configuration.maxUnitsPerOrder) : raw.maximumUnits,
    costCoverage: 'COMPLETE_ESTIMATE', maximumCostUsd, entryAmountUsd: proposal.amountUsd,
    projectedMinUnits: minUnits, projectedMaxUnits: maxUnits, positionId: proposal.positionId, units: proposal.units,
    futureAvailabilityGuaranteed: false };
}

function createRuntimeEvidence({ env = process.env, fetchImpl = global.fetch, registry, clock = Date.now } = {}) {
  let credentials = [], generation = 0, identity = null, identityAt = 0, refusalUntil = 0;
  const bindings = new WeakMap(), costs = createCostClient({ env, fetchImpl, clock });
  function sync() {
    const next = [env.ETORO_API_KEY, env.ETORO_USER_KEY, env.ETORO_CREDENTIAL_REVISION, env.ETORO_EXPECTED_USER_TOKEN_ID, env.ETORO_PORTFOLIO_CONTEXT, env.TRADER_PROVISIONING_PUBLIC_KEY, env.ETORO_ACCOUNT_ENV, env.ETORO_EXPECTED_AGENT_PORTFOLIO_ID, env.ETORO_EXPECTED_PORTFOLIO_ID, env.ETORO_EXPECTED_AGENT_PORTFOLIO_GCID, env.ETORO_EXPECTED_MIRROR_ID];
    if (!generation || next.some((v, i) => v !== credentials[i])) { credentials = next; generation++; identity = null; }
    return generation;
  }
  function valid(binding, accountRef) {
    const record = binding && bindings.get(binding);
    return Boolean(record && record.generation === sync() && record.accountRef === accountRef && binding.accountRef === accountRef && clock() >= record.at && clock() - record.at < 60000 && clock() < record.expiresAt);
  }
  return { valid,
    async collect({ proposal, portfolio, accountRef, view, quote, receipt, allowedAssets, allowedCategories, instrument }) {
      const current = sync(), now = clock(), issues = [];
      const result = { status: 'UNAVAILABLE', issues, binding: null, eligibility: null, cost: null, sizing: null, closeTerms: null };
      const fail = reason => { issues.push(reason); return result; };
      if (!env.ETORO_API_KEY || !env.ETORO_USER_KEY) return fail('CREDENTIALS_ABSENT');
      if ((env.ETORO_ACCOUNT_ENV || 'REAL') !== 'REAL' || portfolio?.accountEnvironment !== 'REAL' || !portfolio?.ok || !fresh(portfolio.fetchedAt, now)) return fail('REAL_PORTFOLIO_UNVERIFIED');
      if (!allowedAssets.includes(instrument.symbol) || !allowedCategories.includes(instrument.category)) return fail('INSTRUMENT_NOT_ALLOWED');
      if (!fresh(quote?.date, now) || !positive(quote?.bid) || !positive(quote?.ask) || quote.ask < quote.bid) return fail('QUOTE_STALE_OR_INVALID');
      const attested = verifyReceipt(receipt, env, now);
      if (attested.status !== 'VERIFIED_OPERATOR_ATTESTATION') return fail(attested.reason);
      const expected = attested.payload;
      if (String(expected.accountRef) !== accountRef) return fail('ACCOUNT_IDENTITY_MISMATCH');
      if (clock() < refusalUntil) return fail('IDENTITY_REFUSAL_COOLDOWN');
      if (!identity || clock() - identityAt >= 60000 || clock() < identityAt) {
        const client = createReadClient({ env: { ETORO_API_KEY: env.ETORO_API_KEY, ETORO_USER_KEY: env.ETORO_USER_KEY }, fetchImpl, maxRequests: 2 });
        const read = await client.read('/api/v1/me');
        if (read.status !== 'VERIFIED_READ') {
          identity = null;
          if (['UNAUTHORIZED', 'FORBIDDEN'].includes(read.status)) refusalUntil = clock() + 60000;
          return fail(read.status === 'NOT_TESTED' ? 'IDENTITY_NOT_TESTED' : 'IDENTITY_READ_' + read.status);
        }
        const data = read.data;
        identity = { gcid: id(data?.gcid), realCid: id(data?.realCid), permissions: permissionEvidence(data) };
        identityAt = clock();
      }
      if (current !== sync()) return fail('CREDENTIAL_CONTEXT_CHANGED');
      if (identity.gcid !== String(expected.gcid) || identity.realCid !== String(expected.realCid)) return fail('AUTHENTICATED_IDENTITY_MISMATCH');
      if (identity.permissions.realRead !== 'REPORTED' || identity.permissions.realWrite !== 'REPORTED') return fail('CURRENT_CREDENTIAL_SCOPES_UNVERIFIED');
      let agentMetadata = 'NOT_REQUIRED_FOR_OWNER_CONTEXT';
      if (expected.contextKind === 'AGENT') {
        const read = await createReadClient({ env, fetchImpl, maxRequests: 1 }).read('/api/v1/agent-portfolios');
        if (read.status === 'UNAUTHORIZED') { identity = null; refusalUntil = clock() + 60000; return fail('AGENT_DISCOVERY_UNAUTHORIZED'); }
        agentMetadata = read.status;
        const matches = read.status === 'VERIFIED_READ' && Array.isArray(read.data?.agentPortfolios) ? read.data.agentPortfolios.filter(r =>
          String(r?.agentPortfolioId) === accountRef && String(r?.agentPortfolioGcid) === identity.gcid && (!env.ETORO_EXPECTED_MIRROR_ID || String(r?.mirrorId) === String(env.ETORO_EXPECTED_MIRROR_ID))) : [];
        const tokens = matches.length === 1 && Array.isArray(matches[0].userTokens) ? matches[0].userTokens.filter(t => String(t?.userTokenId) === String(expected.tokenId)) : [];
        if (read.status === 'VERIFIED_READ' && (matches.length !== 1 || tokens.length !== 1 || permissionEvidence(tokens[0]).realWrite !== 'REPORTED')) return fail('AGENT_OR_TOKEN_METADATA_AMBIGUOUS_OR_UNAVAILABLE');
      }
      const binding = Object.freeze({ accountRef, identityVerified: true, tokenBindingVerified: true, agentMetadata, namedTokenApiBinding: 'TOKEN_BINDING_UNVERIFIED', tokenProvisioning: 'VERIFIED_OPERATOR_ATTESTATION', writeExecutionProof: 'NOT_TESTED', evidenceBasis: 'OFFICIAL_IDENTITY_AND_SIGNED_PROVISIONING_RECEIPT' });
      bindings.set(binding, { generation: current, accountRef, at: now, expiresAt: Date.parse(expected.expiresAt) });
      result.binding = binding;
      const refreshed = await registry.refresh({ instrumentIds: [proposal.instrumentId], currency: 'USD' });
      if (['UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED', 'NOT_TESTED'].includes(refreshed.status)) return fail('ELIGIBILITY_READ_' + refreshed.status);
      const cached = registry.inspect({ instrumentId: proposal.instrumentId, symbol: instrument.symbol, category: instrument.category, allowedAssets, allowedCategories });
      result.eligibility = eligibilityEvidence(cached, proposal, quote, accountRef, clock());
      if (result.eligibility.status !== 'AVAILABLE') issues.push(result.eligibility.reason);
      result.sizing = ['STOCK', 'CRYPTO'].includes(instrument.category) ? sizingEvidence(view, binding, clock()) : null;
      if (!result.sizing) issues.push('COMPLETE_EQUITY_AND_INSTRUMENT_EXPOSURE_REQUIRED');
      result.closeTerms = closeEvidence(expected, cached, proposal, quote, view.owned.rows, accountRef, clock());
      if (!result.closeTerms) issues.push('REVIEWED_OFFICIAL_CLOSE_TERMS_REQUIRED');
      if (proposal.side === 'BUY') {
        result.cost = await costs.check({ instrumentId: proposal.instrumentId, amountUsd: proposal.amountUsd });
      } else if (result.closeTerms) {
        result.cost = { status: 'AVAILABLE', coverage: 'COMPLETE_ESTIMATE', totalUsd: result.closeTerms.maximumCostUsd, currency: 'USD',
          asOf: result.closeTerms.asOf, units: proposal.units, side: 'SELL', instrumentId: proposal.instrumentId, unresolvedComponents: [],
          allInCostPct: result.closeTerms.maximumCostUsd / (proposal.units * quote.bid) * 100, source: result.closeTerms.source, observedFeesUsd: null };
      }
      if (result.cost?.status !== 'AVAILABLE') issues.push(result.cost?.reason || 'CLOSE_COST_MODEL_REQUIRED');
      else result.cost = { ...result.cost, accountRef, contextBinding: 'VERIFIED_SAME_ACCOUNT' };
      if (!valid(binding, accountRef)) return { ...result, binding: null, eligibility: null, cost: null, sizing: null, closeTerms: null, issues: ['CREDENTIAL_CONTEXT_CHANGED_OR_EXPIRED'], status: 'UNAVAILABLE' };
      result.status = issues.length ? 'PARTIAL' : 'AVAILABLE';
      return result;
    }
  };
}

module.exports = { verifyReceipt, eligibilityEvidence, sizingEvidence, closeEvidence, createRuntimeEvidence };
