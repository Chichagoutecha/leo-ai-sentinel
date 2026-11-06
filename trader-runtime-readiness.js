'use strict';

const { VERSION, writerVerified } = require('./trader-scan-inputs');
const { describeVeto, CATALOG } = require('./trading-availability');

const RESOLUTIONS = Object.freeze({
  ETORO_CREDENTIALS_ABSENT: 'Run the read-only diagnostic inside the authorized runtime containing the eToro keys.',
  SHARED_PERSISTENCE_NOT_CONFIGURED: 'Provide the existing shared Upstash runtime connection and verify its atomic coordination.',
  SINGLE_WRITER_NOT_VERIFIED: 'Restore the latest durable state and obtain a current writer lease.',
  EXECUTION_SUSPENDED: 'Reconcile transmitted intents and obtain an explicit operator decision about resuming sends.',
  PENDING_OR_UNCERTAIN_EXECUTION: 'Read official order finality and reconcile the existing intent without resending it.',
  STRATEGY_DISABLED: 'Review the concrete activation dossier before enabling TRADER_EXECUTION_ENABLED.',
  STRATEGY_CONFIRMATION_REQUIRED: 'Supply the strategy confirmation only after activation approval.',
  STRATEGY_STOPPED_OR_ARCHIVE_REQUIRED: 'Review the durable stop or archive condition and unresolved intents.',
  MANAGED_REGISTRY_REVIEW_REQUIRED: 'Review execution history and initialize the empty managed registry for the verified account.',
  STRATEGY_INPUT_VERSION_NOT_REVIEWED: 'Evaluate and approve the exact trader input version and policy configuration.',
  ENTRIES_DISABLED_OR_UNARMED: 'Review entry authorization and its independent armament after activation approval.',
  NO_CURRENT_TRADER_RESEARCH_CANDIDATE: 'Configure stable trader identities, collect current holdings and satisfy the selection policy.',
  EXITS_DISABLED: 'Review and authorize protective exits separately from new entries.',
  NO_VERIFIED_MANAGED_POSITION: 'Identify confirmed positions created by the strategy. Personal positions require separate review.',
  CANDIDATE_EVIDENCE_NOT_COLLECTED: 'Run a normal strategy scan in the authorized runtime and inspect its evidence and vetoes.',
  PROVISIONING_SCHEMA_INVALID: 'Rebuild the receipt with only documented nonsecret provisioning and close-term fields, then sign it again.',
  PROVISIONING_ACCOUNT_SELECTOR_MISMATCH: 'Reconcile the configured expected portfolio and GCID with the signed account record.',
  CREDENTIAL_CONTEXT_CHANGED_OR_EXPIRED: 'Collect fresh identity and proposal evidence after credential rotation or proof expiry.',
  CREDENTIAL_CONTEXT_CHANGED: 'Discard the interrupted collection and verify the new credential revision before reevaluation.',
  REAL_PORTFOLIO_UNVERIFIED: 'Read the REAL PnL with the authorized credentials and verify the complete account snapshot.',
  IDENTITY_REFUSAL_COOLDOWN: 'Wait for the bounded cooldown and resolve the identity endpoint refusal without bypassing it.',
  IDENTITY_READ_UNAUTHORIZED: 'Review the loaded credential provisioning and its expiry in the secured runtime.',
  IDENTITY_READ_FORBIDDEN: 'Inspect the current credential permissions for the official identity read. Do not infer access to other endpoints.',
  IDENTITY_READ_UNAVAILABLE: 'Restore the official identity read and verify its documented account fields.',
  ELIGIBILITY_PRODUCT_OR_LIMITS_UNAVAILABLE: 'Inspect the current eligibility response for the exact product, side, leverage and size. Unknown opening limits prevent entries only.',
  COST_IDENTITY_TIMESTAMP_OR_COMPONENTS_UNVERIFIED: 'Refresh the official cost query for the exact instrument and amount and verify its timestamp and component list.',
  UNKNOWN_CONTRADICTORY_OR_FOREIGN_COST: 'Resolve duplicate, undocumented or non-USD cost components using official cost documentation.',
  HOLDING_COST_HORIZON_UNVERIFIED: 'Specify and validate a holding-cost model before accepting nonzero periodic fees.',
  COST_QUOTA_OR_COOLDOWN: 'Wait for the dedicated cost quota window and collect a new estimate without retrying execution.',
  COST_READ_REFUSED: 'Resolve the cost endpoint HTTP refusal in the authorized runtime before another estimate.',
  COST_READ_FAILED: 'Restore the informational cost transport and collect a new bounded estimate.',
  ELIGIBILITY_READ_UNAUTHORIZED: 'Review credential provisioning for the official eligibility endpoint.',
  ELIGIBILITY_READ_FORBIDDEN: 'Verify the credential permissions for the informational eligibility operation.',
  ELIGIBILITY_READ_RATE_LIMITED: 'Wait for the eligibility quota window before refreshing the same account context.',
  RUNTIME_EVIDENCE_COLLECTION_FAILED: 'Run the isolated diagnostic to identify the failed evidence component without starting execution.',
  PROVISIONING_RECEIPT_REQUIRED: 'Provision a signed receipt for the exact credential revision and a trusted Ed25519 public key.',
  PROVISIONING_RECEIPT_MISMATCH_OR_EXPIRED: 'Review and renew the provisioning receipt for the current account, token and credential revision.',
  PROVISIONING_SIGNATURE_UNVERIFIED: 'Verify the receipt signature with the public key controlled by the provisioning operator.',
  REVIEWED_OFFICIAL_CLOSE_TERMS_REQUIRED: 'Document current full-close constraints and an exhaustive fee model from official sources in the signed receipt.',
  CLOSE_COST_MODEL_REQUIRED: 'Provide an operator-reviewed official close-cost model. The what-if API currently accepts openings only.',
  COMPLETE_EQUITY_AND_INSTRUMENT_EXPOSURE_REQUIRED: 'Refresh complete account values and pending orders and resolve embedded or unclassified holdings.',
  CURRENT_CREDENTIAL_SCOPES_UNVERIFIED: 'Inspect scopes returned for the loaded credentials by the official identity endpoint.',
  AUTHENTICATED_IDENTITY_MISMATCH: 'Suspend execution and reconcile the authenticated identity with the signed provisioning record.',
  ACCOUNT_IDENTITY_MISMATCH: 'Verify the PnL account identifier against the provisioning record before any execution.',
  AGENT_OR_TOKEN_METADATA_AMBIGUOUS_OR_UNAVAILABLE: 'Resolve the exact agent and token through official metadata without selecting the first result.'
});
function detail(code, side) {
  return { code, action: side, resolution: RESOLUTIONS[code] || (CATALOG[code] ? describeVeto(code, { side }).resolution :
    'Refresh the named evidence using the isolated diagnostic and resolve its reported refusal, missing field or context mismatch before reevaluation.'), automaticOrderRetryAllowed: false };
}
function report({ credentials, settings, mode, armed, buyArmed, state, writer, inputs, now, candidateChecks = {}, evidenceIssues = [] }) {
  const common = [];
  if (!credentials.etoro) common.push('ETORO_CREDENTIALS_ABSENT');
  if (!credentials.persistence) common.push('SHARED_PERSISTENCE_NOT_CONFIGURED');
  if (!writerVerified(writer, now)) common.push('SINGLE_WRITER_NOT_VERIFIED');
  if (writer?.suspended) common.push('EXECUTION_SUSPENDED');
  if (writer?.inFlight || Object.values(state.operations || {}).some(o => !['CONFIRMED', 'PARTIALLY_FILLED_TERMINAL', 'CANCELED', 'REJECTED', 'VETOED'].includes(o.status))) common.push('PENDING_OR_UNCERTAIN_EXECUTION');
  if (mode !== 'LIVE' || armed !== true) common.push('LIVE_MODE_AND_ARMING_REQUIRED');
  if (!settings.enabled) common.push('STRATEGY_DISABLED');
  if (settings.confirmation !== 'I_UNDERSTAND_TRADER_STRATEGY_REAL_ORDERS') common.push('STRATEGY_CONFIRMATION_REQUIRED');
  if (state.emergencyStop || settings.emergencyStop || state.disabledReason) common.push('STRATEGY_STOPPED_OR_ARCHIVE_REQUIRED');
  if (state.recoveryRequired) common.push('MANAGED_REGISTRY_REVIEW_REQUIRED');
  if (state.releaseApproval?.status !== 'APPROVED_CHRONOLOGICAL_EVALUATION') common.push('EVALUATION_RELEASE_UNVERIFIED');
  const entries = [...common, ...(candidateChecks.BUY || ['CANDIDATE_EVIDENCE_NOT_COLLECTED'])];
  if (state.releaseApproval?.inputVersion !== VERSION) entries.push('STRATEGY_INPUT_VERSION_NOT_REVIEWED');
  if (!settings.entriesEnabled || !buyArmed || writer?.entriesBlocked) entries.push('ENTRIES_DISABLED_OR_UNARMED');
  if (!candidateChecks.BUY && !inputs?.candidates?.length) entries.push('NO_CURRENT_TRADER_RESEARCH_CANDIDATE');
  const exits = [...common, ...(candidateChecks.SELL || ['CANDIDATE_EVIDENCE_NOT_COLLECTED'])];
  if (!settings.exitsEnabled) exits.push('EXITS_DISABLED');
  if (!Object.values(state.managed || {}).some(p => p.status === 'VERIFIED_MANAGED')) exits.push('NO_VERIFIED_MANAGED_POSITION');
  const action = (reasons, side) => ({ status: reasons.length ? 'BLOCKED' : 'AVAILABLE_TO_NORMAL_EXECUTOR', reasons: [...new Set(reasons)].sort(),
    resolutions: [...new Set(reasons)].sort().map(code => detail(code, side)) });
  return { status: entries.length && exits.length ? 'BLOCKED' : 'READY_FOR_REVIEW', verifiedAt: new Date(now).toISOString(),
    scope: 'INDIVIDUAL_ORDERS_FROM_TRADER_CONTEXT', nativeCopy: 'NOT_ENABLED_BY_THIS_STRATEGY',
    credentials: { etoroPresent: Boolean(credentials.etoro), sharedPersistencePresent: Boolean(credentials.persistence) },
    writerVerified: writerVerified(writer, now), entries: action(entries, 'BUY'), exits: action(exits, 'SELL'),
    evidenceIssues: [...new Set(evidenceIssues)].map(code => detail(code, 'EVIDENCE_COLLECTION')),
    permissions: 'SEE_CURRENT_CANDIDATE_EVIDENCE', authenticatedBrokerCalls: 0, executionAttempted: false };
}

module.exports = { report, detail };
