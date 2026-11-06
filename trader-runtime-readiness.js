'use strict';

const { VERSION, writerVerified } = require('./trader-scan-inputs');

function report({ credentials, settings, mode, armed, buyArmed, state, writer, inputs, now }) {
  const common = [];
  if (!credentials.etoro) common.push('ETORO_CREDENTIALS_ABSENT');
  if (!credentials.persistence) common.push('SHARED_PERSISTENCE_NOT_CONFIGURED');
  if (!writerVerified(writer, now)) common.push('SINGLE_WRITER_NOT_VERIFIED');
  if (writer?.suspended) common.push('EXECUTION_SUSPENDED');
  if (writer?.inFlight || Object.values(state.operations || {}).some(o => ['RESERVED', 'DISPATCHING', 'NEEDS_RECONCILIATION', 'PARTIALLY_FILLED', 'FILLED_AWAITING_PORTFOLIO'].includes(o.status))) common.push('PENDING_OR_UNCERTAIN_EXECUTION');
  if (mode !== 'LIVE' || armed !== true) common.push('LIVE_MODE_AND_ARMING_REQUIRED');
  if (!settings.enabled) common.push('STRATEGY_DISABLED');
  if (settings.confirmation !== 'I_UNDERSTAND_TRADER_STRATEGY_REAL_ORDERS') common.push('STRATEGY_CONFIRMATION_REQUIRED');
  if (state.emergencyStop || settings.emergencyStop || state.disabledReason) common.push('STRATEGY_STOPPED_OR_ARCHIVE_REQUIRED');
  if (state.recoveryRequired) common.push('MANAGED_REGISTRY_REVIEW_REQUIRED');
  // The current runtime has no authenticated token-binding or cost/sizing adapter.
  // Keep these concrete integration gaps visible even when switches are enabled.
  common.push('TOKEN_BINDING_ADAPTER_UNAVAILABLE', 'ACCOUNT_BOUND_COST_ADAPTER_UNAVAILABLE');
  if (state.releaseApproval?.status !== 'APPROVED_CHRONOLOGICAL_EVALUATION') common.push('EVALUATION_RELEASE_UNVERIFIED');
  const entries = [...common];
  if (state.releaseApproval?.inputVersion !== VERSION) entries.push('STRATEGY_INPUT_VERSION_NOT_REVIEWED');
  if (!settings.entriesEnabled || !buyArmed || writer?.entriesBlocked) entries.push('ENTRIES_DISABLED_OR_UNARMED');
  if (!inputs?.candidates?.length) entries.push('NO_CURRENT_TRADER_RESEARCH_CANDIDATE');
  entries.push('ACCOUNT_BOUND_ELIGIBILITY_ADAPTER_UNAVAILABLE', 'EXPOSURE_SIZING_ADAPTER_UNAVAILABLE', 'ENTRY_EXIT_CAPACITY_EVIDENCE_REQUIRED');
  const exits = [...common];
  if (!settings.exitsEnabled) exits.push('EXITS_DISABLED');
  if (!Object.values(state.managed || {}).some(p => p.status === 'VERIFIED_MANAGED')) exits.push('NO_VERIFIED_MANAGED_POSITION');
  return { status: 'BLOCKED', verifiedAt: new Date(now).toISOString(),
    scope: 'INDIVIDUAL_ORDERS_FROM_TRADER_CONTEXT', nativeCopy: 'NOT_ENABLED_BY_THIS_STRATEGY',
    credentials: { etoroPresent: Boolean(credentials.etoro), sharedPersistencePresent: Boolean(credentials.persistence) },
    writerVerified: writerVerified(writer, now),
    entries: { status: 'BLOCKED', reasons: [...new Set(entries)].sort() },
    exits: { status: 'BLOCKED', reasons: [...new Set(exits)].sort() },
    permissions: 'NOT_VERIFIED_BY_THIS_REPORT', authenticatedBrokerCalls: 0, executionAttempted: false };
}

module.exports = { report };
