'use strict';

/**
 * LEO-AI SENTINEL v10.22.10.7 — deterministic production migration DRAFT.
 *
 * This file NEVER edits index.js in place. It transforms an input string (or writes
 * a separate output file in CLI mode) so CI can compile/test the exact prospective
 * production patch before any runtime change is committed.
 */
const fs = require('fs');
const { createHash } = require('crypto');

const VERSION = 'v10.22.10.7-v2-buy-production-migration-draft';
const LEGACY_BUY_URL = 'https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-amount';
const CURRENT_V2_BUY_URL = 'https://public-api.etoro.com/api/v2/trading/execution/orders';

const OLD_COMPACT_ANCHOR = `    positionId: first?.positionID ?? first?.positionId ?? first?.PositionID ?? first?.PositionId ?? null,
    statusId: first?.statusID ?? first?.statusId ?? first?.StatusID ?? first?.StatusId ?? null,`;
const NEW_COMPACT_ANCHOR = `    positionId: first?.positionID ?? first?.positionId ?? first?.PositionID ?? first?.PositionId ?? null,
    token: first?.token ?? first?.Token ?? data?.token ?? data?.Token ?? null,
    referenceId: first?.referenceId ?? first?.referenceID ?? first?.ReferenceId ?? first?.ReferenceID ?? data?.referenceId ?? data?.referenceID ?? data?.ReferenceId ?? data?.ReferenceID ?? null,
    statusId: first?.statusID ?? first?.statusId ?? first?.StatusID ?? first?.StatusId ?? null,`;

const OLD_ACK_ANCHOR = `  if (response.positionId !== null && response.positionId !== undefined) return true;
  if (response.statusId !== null && response.statusId !== undefined) return true;`;
const NEW_ACK_ANCHOR = `  if (response.positionId !== null && response.positionId !== undefined) return true;
  if (response.token !== null && response.token !== undefined) return true;
  if (response.referenceId !== null && response.referenceId !== undefined) return true;
  if (response.statusId !== null && response.statusId !== undefined) return true;`;

const OLD_BUY_URL_LITERAL = `      "${LEGACY_BUY_URL}",`;
const NEW_BUY_URL_LITERAL = `      "${CURRENT_V2_BUY_URL}",`;

const OLD_BUY_BODY = `        body: JSON.stringify({ InstrumentId: instrumentId, IsBuy: true, Leverage: 1, Amount: safeAmount })`;
const NEW_BUY_BODY = `        body: JSON.stringify({
          action: "open",
          transaction: "buy",
          instrumentId,
          orderType: "mkt",
          amount: safeAmount,
          orderCurrency: "usd",
          leverage: 1
        })`;

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function countOccurrences(source, needle) {
  if (!needle) return 0;
  return String(source).split(needle).length - 1;
}

function replaceExactlyOnce(source, before, after, label) {
  const count = countOccurrences(source, before);
  if (count !== 1) {
    const error = new Error(`${label}: expected exactly one source match, found ${count}`);
    error.code = 'DRAFT_SOURCE_CONTRACT_MISMATCH';
    error.label = label;
    error.matches = count;
    throw error;
  }
  return String(source).replace(before, after);
}

function migrationSafetySnapshot(source) {
  const text = String(source || '');
  const markers = [
    'verifyRealPortfolioBeforeExecution({ asset, side: "BUY", amount: safeAmount })',
    'createOrderIntent("BUY", asset, safeAmount, {',
    'updateOrderIntentStatus(intent.id, EXECUTION_STATUS.SENT, {',
    '{ label: `eToro LIVE BUY ${asset}`, retries: 0 }',
    'verifyPortfolioAfterExecution({',
    'if (businessAcknowledged || verification.observed) setCooldown(asset);',
    'EXECUTION_STATUS.DUPLICATE_BLOCKED',
    'LIVE_EXECUTION_ARMED',
    'LIVE_PORTFOLIO_PREFLIGHT_ENABLED'
  ];
  return Object.fromEntries(markers.map((marker) => [marker, countOccurrences(text, marker)]));
}

function transformIndexForV2BuyDraft(source) {
  const original = String(source || '');
  if (!original.trim()) {
    const error = new Error('index source is empty');
    error.code = 'EMPTY_SOURCE';
    throw error;
  }

  const beforeSafety = migrationSafetySnapshot(original);
  let output = original;
  output = replaceExactlyOnce(output, OLD_COMPACT_ANCHOR, NEW_COMPACT_ANCHOR, 'v2 response compaction');
  output = replaceExactlyOnce(output, OLD_ACK_ANCHOR, NEW_ACK_ANCHOR, 'v2 business acknowledgement');
  output = replaceExactlyOnce(output, OLD_BUY_URL_LITERAL, NEW_BUY_URL_LITERAL, 'BUY execution endpoint');
  output = replaceExactlyOnce(output, OLD_BUY_BODY, NEW_BUY_BODY, 'BUY execution payload');
  const afterSafety = migrationSafetySnapshot(output);

  if (JSON.stringify(beforeSafety) !== JSON.stringify(afterSafety)) {
    const error = new Error('A protected execution-safety marker changed during the DRAFT transform');
    error.code = 'SAFETY_MARKER_CHANGED';
    error.beforeSafety = beforeSafety;
    error.afterSafety = afterSafety;
    throw error;
  }

  if (countOccurrences(output, LEGACY_BUY_URL) !== 0) {
    const error = new Error('Legacy BUY URL remains after DRAFT transform');
    error.code = 'LEGACY_ROUTE_REMAINS';
    throw error;
  }
  if (countOccurrences(output, CURRENT_V2_BUY_URL) !== 1) {
    const error = new Error('Expected exactly one v2 BUY URL after DRAFT transform');
    error.code = 'V2_ROUTE_COUNT_MISMATCH';
    throw error;
  }

  return {
    ok: true,
    version: VERSION,
    output,
    sourceSha256: sha256(original),
    outputSha256: sha256(output),
    replacements: [
      'COMPACT_TOKEN_REFERENCE_ID',
      'ACK_TOKEN_REFERENCE_ID',
      'BUY_V1_TO_V2_ENDPOINT',
      'BUY_V1_TO_V2_PAYLOAD'
    ],
    replacementCount: 4,
    safetyMarkers: afterSafety,
    productionFileMutated: false,
    liveAuthorityGranted: false,
    automaticRetryAdded: false,
    dualSubmitAdded: false
  };
}

function draftReadiness() {
  return {
    version: VERSION,
    status: 'PRODUCTION_MIGRATION_DRAFT_READY_FOR_CI',
    target: 'executeBuy transport + v2 response evidence compatibility',
    safety: {
      transformsCopyOnly: true,
      productionFileMutated: false,
      liveAuthorityGranted: false,
      automaticRetryAdded: false,
      dualSubmitAdded: false,
      sellPathModified: false,
      strategyModified: false,
      sizingModified: false
    }
  };
}

if (require.main === module) {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    console.error('Usage: node etoro-v2-buy-production-migration-draft.js <input-index.js> <output-copy.js>');
    process.exit(2);
  }
  if (inputPath === outputPath) {
    console.error('Refusing in-place mutation: input and output paths must differ.');
    process.exit(3);
  }
  const source = fs.readFileSync(inputPath, 'utf8');
  const result = transformIndexForV2BuyDraft(source);
  fs.writeFileSync(outputPath, result.output, 'utf8');
  console.log(JSON.stringify({
    ok: result.ok,
    version: result.version,
    sourceSha256: result.sourceSha256,
    outputSha256: result.outputSha256,
    replacements: result.replacements,
    replacementCount: result.replacementCount,
    productionFileMutated: result.productionFileMutated,
    liveAuthorityGranted: result.liveAuthorityGranted,
    automaticRetryAdded: result.automaticRetryAdded,
    dualSubmitAdded: result.dualSubmitAdded,
    outputPath
  }, null, 2));
}

module.exports = {
  VERSION,
  LEGACY_BUY_URL,
  CURRENT_V2_BUY_URL,
  OLD_BUY_BODY,
  NEW_BUY_BODY,
  countOccurrences,
  migrationSafetySnapshot,
  transformIndexForV2BuyDraft,
  draftReadiness
};
