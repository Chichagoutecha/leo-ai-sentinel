'use strict';

const fs = require('fs');
const { createHash } = require('crypto');
const {
  LEGACY_BUY_URL,
  CURRENT_V2_BUY_URL,
  countOccurrences,
  migrationSafetySnapshot,
  transformIndexForV2BuyDraft
} = require('./etoro-v2-buy-production-migration-draft');

const VERSION = 'v10.22.10.8-v2-buy-runtime-draft-audit';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function auditRuntimeMigration(beforeSource, currentSource) {
  const before = String(beforeSource || '');
  const current = String(currentSource || '');
  if (!before.trim() || !current.trim()) fail('Missing runtime source.', 'EMPTY_RUNTIME_SOURCE');

  const expectedResult = transformIndexForV2BuyDraft(before);
  const expected = expectedResult.output;
  if (current !== expected) {
    fail('Tracked index.js is not byte-identical to the exact v10.22.10.7 validated transform.', 'RUNTIME_NOT_EXACT_VALIDATED_TRANSFORM');
  }

  const beforeSafety = migrationSafetySnapshot(before);
  const currentSafety = migrationSafetySnapshot(current);
  if (JSON.stringify(beforeSafety) !== JSON.stringify(currentSafety)) {
    fail('Protected execution-safety markers changed.', 'RUNTIME_SAFETY_MARKERS_CHANGED');
  }

  const sellMarker = 'async function executeSell(';
  const beforeSellStart = before.indexOf(sellMarker);
  const currentSellStart = current.indexOf(sellMarker);
  if (beforeSellStart < 0 || currentSellStart < 0) fail('executeSell boundary missing.', 'SELL_BOUNDARY_MISSING');
  if (before.slice(beforeSellStart) !== current.slice(currentSellStart)) {
    fail('SELL path or later runtime changed.', 'SELL_PATH_CHANGED');
  }

  if (countOccurrences(current, LEGACY_BUY_URL) !== 0) fail('Legacy BUY v1 route remains.', 'LEGACY_BUY_ROUTE_REMAINS');
  if (countOccurrences(current, CURRENT_V2_BUY_URL) !== 1) fail('Expected exactly one current v2 BUY route.', 'V2_BUY_ROUTE_COUNT_MISMATCH');
  if (!current.includes('{ label: `eToro LIVE BUY ${asset}`, retries: 0 }')) fail('One-shot retries:0 invariant missing.', 'BUY_RETRY_INVARIANT_MISSING');
  if (!current.includes('verifyRealPortfolioBeforeExecution({ asset, side: "BUY", amount: safeAmount })')) fail('REAL portfolio preflight missing.', 'BUY_PREFLIGHT_MISSING');
  if (!current.includes('createOrderIntent("BUY", asset, safeAmount, {')) fail('Persistent BUY intent creation missing.', 'BUY_INTENT_MISSING');
  if (!current.includes('updateOrderIntentStatus(intent.id, EXECUTION_STATUS.SENT, {')) fail('ORDER_SENT persistence missing.', 'BUY_SENT_STATUS_MISSING');
  if (!current.includes('verifyPortfolioAfterExecution({')) fail('Post-order portfolio verification missing.', 'BUY_VERIFICATION_MISSING');
  if (!current.includes('if (businessAcknowledged || verification.observed) setCooldown(asset);')) fail('Cooldown evidence rule missing.', 'BUY_COOLDOWN_RULE_MISSING');

  return {
    ok: true,
    version: VERSION,
    status: 'EXACT_V2_BUY_RUNTIME_DRAFT_CONFIRMED',
    beforeSha256: sha256(before),
    currentSha256: sha256(current),
    expectedSha256: expectedResult.outputSha256,
    exactValidatedTransform: true,
    replacementCount: expectedResult.replacementCount,
    legacyBuyRouteCount: countOccurrences(current, LEGACY_BUY_URL),
    currentV2BuyRouteCount: countOccurrences(current, CURRENT_V2_BUY_URL),
    sellPathByteIdentical: true,
    safetyMarkersIdentical: true,
    automaticRetryAdded: false,
    dualSubmitAdded: false,
    renderChanged: false,
    liveActivationAuthorized: false
  };
}

if (require.main === module) {
  const beforePath = process.argv[2];
  const currentPath = process.argv[3];
  if (!beforePath || !currentPath) {
    console.error('Usage: node etoro-v2-buy-runtime-draft-audit.js <validated-before-index.js> <current-index.js>');
    process.exit(2);
  }
  const result = auditRuntimeMigration(
    fs.readFileSync(beforePath, 'utf8'),
    fs.readFileSync(currentPath, 'utf8')
  );
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { VERSION, auditRuntimeMigration };
