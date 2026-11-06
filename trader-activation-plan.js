'use strict';

const { resolveTradeAllowlist, resolveAllowedCategories, liveBuyMaxOrderUsd, resolveTradingMode } = require('./trade-universe-policy');
const { parseTraders } = require('./trader-observer');
const { audit } = require('./etoro-read-access-audit');

function buildPlan({ env = {}, universe = [], state = {}, readiness = null, now = Date.now(), revision = null, runtimeVerified = false } = {}) {
  const watchlist = Object.fromEntries(universe.filter(r => r.tradable === true).map(r => [r.symbol, r.instrumentId]));
  const allowed = new Set(resolveTradeAllowlist(watchlist, env)), categories = new Set(resolveAllowedCategories(env));
  const instruments = universe.filter(r => allowed.has(r.symbol) && categories.has(r.category)).map(r => ({ symbol: r.symbol, instrumentId: r.instrumentId, category: r.category, accountEligibility: 'REQUIRES_CURRENT_ACCOUNT_EVIDENCE' }));
  let traders;
  try { traders = parseTraders(env.TRADER_OBSERVER_TRADERS_JSON || '[]').map((_, i) => ({ alias: 'trader-' + String(i + 1).padStart(2, '0'), identityStatus: 'CONFIGURED_REQUIRES_OFFICIAL_COLLECTION' })); }
  catch { traders = null; }
  const finite = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const changes = [
    { key: 'ETORO_CREDENTIAL_REVISION', proposed: null, reason: 'IDENTIFY_THE_EXACT_SECRET_PROVISIONING_VERSION_WITHOUT_EXPORTING_IT' },
    { key: 'TRADER_PROVISIONING_PUBLIC_KEY', proposed: null, reason: 'APPROVE_THE_OPERATORS_PUBLIC_ED25519_VERIFICATION_KEY' },
    { key: 'TRADING_MODE', proposed: 'LIVE', requiresExplicitApproval: true },
    { key: 'LIVE_EXECUTION_ARMED', proposed: true, requiresExplicitApproval: true },
    { key: 'LIVE_BUY_CONFIRMATION', proposed: 'I_UNDERSTAND_LIVE_BUY_ORDERS', requiresExplicitApproval: true },
    { key: 'TRADER_EXECUTION_ENABLED', proposed: true, requiresExplicitApproval: true },
    { key: 'TRADER_EXECUTION_ENTRIES_ENABLED', proposed: true, requiresExplicitApproval: true },
    { key: 'TRADER_EXECUTION_EXITS_ENABLED', proposed: true, requiresExplicitApproval: true },
    { key: 'TRADER_EXECUTION_CONFIRMATION', proposed: 'I_UNDERSTAND_TRADER_STRATEGY_REAL_ORDERS', requiresExplicitApproval: true },
    { key: 'TRADER_EXECUTION_MAX_COST_USD', proposed: null, reason: 'APPROVE_OBSERVED_OR_DOCUMENTED_COST_BUDGET_WITHOUT_RAISING_CAPS_AUTOMATICALLY' },
    { key: 'TRADER_EXECUTION_MAX_EXIT_NOTIONAL_USD', proposed: null, reason: 'APPROVE_INDEPENDENT_EXIT_CAP_BEFORE_ENTRY' }
  ];
  return { status: readiness?.status === 'READY_FOR_REVIEW' && runtimeVerified ? 'READY_FOR_REVIEW' : 'BLOCKED', generatedAt: new Date(now).toISOString(),
    account: { alias: state.accountRef ? 'account-01' : 'ACCOUNT_UNVERIFIED', identityStatus: 'SEE_AUTHENTICATED_RUNTIME_EVIDENCE', namedTokenApiBinding: 'TOKEN_BINDING_UNVERIFIED' },
    provenance: { runtimeVerified, source: 'CURRENT_PROCESS_ENVIRONMENT_DEPLOYMENT_REQUIRES_SEPARATE_PROOF', revision: typeof revision === 'string' && /^[a-f0-9]{40}$/.test(revision) ? revision : null, configuredMode: resolveTradingMode(env).mode },
    traders, instruments,
    managedPositions: Object.values(state.managed || {}).filter(p => p.status === 'VERIFIED_MANAGED').map((p, i) => ({
      alias: 'position-' + String(i + 1).padStart(2, '0'), instrumentId: Number.isSafeInteger(p.instrumentId) ? p.instrumentId : null,
      units: Number.isFinite(p.units) && p.units > 0 ? p.units : null, permission: 'EXACT_FULL_CLOSE_SUBJECT_TO_FRESH_PREFLIGHT' })),
    instrumentUniverseAvailable: universe.length > 0,
    limits: { buyCapUsd: liveBuyMaxOrderUsd(env.LIVE_BUY_MAX_ORDER_USD), exitCapUsd: finite(env.TRADER_EXECUTION_MAX_EXIT_NOTIONAL_USD || 0),
      costCapUsd: finite(env.TRADER_EXECUTION_MAX_COST_USD || 0), leverage: 1, maximumOrdersPerScan: 1, maximumOrdersPer24h: 4,
      maximumBuysPer24h: 3, maximumSellsPer24h: 2, minimumHoursBetweenExecutions: 2,
      cashReserve: 'STRICTER_OF_NORMAL_AND_ADVISORY_POLICY_WITH_ABSOLUTE_RESERVE', managedPositionsOnly: true, partialClose: 'UNSUPPORTED' },
    readiness, requiredConfigurationChanges: changes,
    requiredRecords: ['SIGNED_PROVISIONING_RECEIPT_AND_NONSECRET_CREDENTIAL_REVISION', 'CURRENT_OFFICIAL_CLOSE_TERMS_AND_FEE_MODEL',
      'REVIEWED_MANAGED_REGISTRY', 'CHRONOLOGICAL_RELEASE_APPROVAL_FOR_EXACT_INPUT_AND_POLICY_VERSION'],
    remainingProofs: runtimeVerified ? [...new Set([...(readiness?.entries?.reasons || []), ...(readiness?.exits?.reasons || [])])] : ['DEPLOYED_COMMIT_NOT_VERIFIED', 'AUTHENTICATED_ACCOUNT_AND_TOKEN_NOT_VERIFIED', 'TRADER_COLLECTION_NOT_VERIFIED', 'SHADOW_RESULTS_NOT_VERIFIED'],
    activationPerformed: false, deploymentPerformed: false, executionAttempted: false };
}

module.exports = { buildPlan };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--read-only-audit') || args.length > 1) {
    process.stdout.write('{"status":"BLOCKED","reason":"ONLY_READ_ONLY_AUDIT_OPTION_ALLOWED"}\n'); process.exitCode = 1;
  } else {
    (async () => {
      const access = args.length ? await audit({ env: process.env }) : { status: 'NOT_TESTED', requests: 0 };
      const plan = buildPlan({ env: process.env, revision: process.env.RENDER_GIT_COMMIT });
      process.stdout.write(JSON.stringify({ ...plan, access }, null, 2) + '\n');
    })().catch(() => { process.stdout.write('{"status":"BLOCKED","reason":"ACTIVATION_PLAN_UNAVAILABLE"}\n'); process.exitCode = 1; });
  }
}
