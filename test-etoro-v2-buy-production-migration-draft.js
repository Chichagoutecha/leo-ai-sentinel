'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const {
  LEGACY_BUY_URL,
  CURRENT_V2_BUY_URL,
  countOccurrences,
  migrationSafetySnapshot,
  transformIndexForV2BuyDraft,
  draftReadiness
} = require('./etoro-v2-buy-production-migration-draft');

const indexPath = path.join(__dirname, 'index.js');

function currentIndex() {
  return fs.readFileSync(indexPath, 'utf8');
}

function extractExecutionEvidenceHelpers(source) {
  const start = source.indexOf('function compactEtoroExecutionResponse(data) {');
  const end = source.indexOf('function executionCashDelta(', start);
  assert.ok(start >= 0, 'compactEtoroExecutionResponse must exist');
  assert.ok(end > start, 'executionCashDelta boundary must exist');
  const block = source.slice(start, end);
  const sandbox = {};
  vm.runInNewContext(`${block}\nthis.compact = compactEtoroExecutionResponse; this.ack = hasExecutionBusinessAcknowledgement;`, sandbox);
  return { compact: sandbox.compact, ack: sandbox.ack };
}

test('current production source still has the legacy BUY route before any migration is applied', () => {
  const source = currentIndex();
  assert.equal(countOccurrences(source, LEGACY_BUY_URL), 1);
  assert.equal(countOccurrences(source, CURRENT_V2_BUY_URL), 0);
});

test('draft transformer performs exactly four targeted replacements on a copy', () => {
  const source = currentIndex();
  const result = transformIndexForV2BuyDraft(source);
  assert.equal(result.ok, true);
  assert.equal(result.replacementCount, 4);
  assert.deepEqual(result.replacements, [
    'COMPACT_TOKEN_REFERENCE_ID',
    'ACK_TOKEN_REFERENCE_ID',
    'BUY_V1_TO_V2_ENDPOINT',
    'BUY_V1_TO_V2_PAYLOAD'
  ]);
  assert.notEqual(result.sourceSha256, result.outputSha256);
  assert.equal(result.productionFileMutated, false);
  assert.equal(result.liveAuthorityGranted, false);
  assert.equal(result.automaticRetryAdded, false);
  assert.equal(result.dualSubmitAdded, false);
  assert.equal(currentIndex(), source, 'transform must not mutate index.js');
});

test('candidate copy uses exact unified v2 BUY route and lowercase payload', () => {
  const result = transformIndexForV2BuyDraft(currentIndex());
  assert.equal(countOccurrences(result.output, LEGACY_BUY_URL), 0);
  assert.equal(countOccurrences(result.output, CURRENT_V2_BUY_URL), 1);
  assert.match(result.output, /action: "open"/);
  assert.match(result.output, /transaction: "buy"/);
  assert.match(result.output, /instrumentId,/);
  assert.match(result.output, /orderType: "mkt"/);
  assert.match(result.output, /amount: safeAmount/);
  assert.match(result.output, /orderCurrency: "usd"/);
  assert.match(result.output, /leverage: 1/);
  assert.doesNotMatch(result.output, /InstrumentId: instrumentId, IsBuy: true, Leverage: 1, Amount: safeAmount/);
});

test('v2 token and referenceId survive compaction and count as business acknowledgement', () => {
  const result = transformIndexForV2BuyDraft(currentIndex());
  const helpers = extractExecutionEvidenceHelpers(result.output);
  const compact = helpers.compact({ token: 'tok-v2', orderId: 123, referenceId: 'ref-v2' });
  assert.equal(compact.token, 'tok-v2');
  assert.equal(compact.orderId, 123);
  assert.equal(compact.referenceId, 'ref-v2');
  assert.equal(helpers.ack(compact), true);

  const referenceOnly = helpers.compact({ referenceId: 'ref-only' });
  assert.equal(referenceOnly.referenceId, 'ref-only');
  assert.equal(helpers.ack(referenceOnly), true);

  const tokenOnlyNested = helpers.compact({ data: { token: 'tok-only' } });
  assert.equal(tokenOnlyNested.token, 'tok-only');
  assert.equal(helpers.ack(tokenOnlyNested), true);
});

test('empty 2xx-style payload still has no business acknowledgement', () => {
  const result = transformIndexForV2BuyDraft(currentIndex());
  const helpers = extractExecutionEvidenceHelpers(result.output);
  assert.equal(helpers.ack(helpers.compact({})), false);
});

test('all critical preflight, persistent-intent, one-shot and reconciliation markers remain unchanged', () => {
  const source = currentIndex();
  const result = transformIndexForV2BuyDraft(source);
  assert.deepEqual(migrationSafetySnapshot(result.output), migrationSafetySnapshot(source));
  assert.ok(result.output.includes('{ label: `eToro LIVE BUY ${asset}`, retries: 0 }'));
  assert.ok(result.output.includes('verifyPortfolioAfterExecution({'));
  assert.ok(result.output.includes('createOrderIntent("BUY", asset, safeAmount, {'));
  assert.ok(result.output.includes('updateOrderIntentStatus(intent.id, EXECUTION_STATUS.SENT, {'));
});

test('SELL path and everything after executeSell remain byte-identical', () => {
  const source = currentIndex();
  const result = transformIndexForV2BuyDraft(source);
  const sellStart = source.indexOf('async function executeSell(');
  const candidateSellStart = result.output.indexOf('async function executeSell(');
  assert.ok(sellStart >= 0);
  assert.ok(candidateSellStart >= 0);
  assert.equal(result.output.slice(candidateSellStart), source.slice(sellStart));
});

test('generated candidate index remains valid JavaScript syntax', () => {
  const result = transformIndexForV2BuyDraft(currentIndex());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leo-v2-draft-'));
  const candidate = path.join(dir, 'index-v2-draft.js');
  fs.writeFileSync(candidate, result.output, 'utf8');
  execFileSync(process.execPath, ['--check', candidate], { stdio: 'pipe' });
});

test('transform is intentionally non-idempotent to prevent accidental double migration', () => {
  const first = transformIndexForV2BuyDraft(currentIndex());
  assert.throws(
    () => transformIndexForV2BuyDraft(first.output),
    (error) => error && error.code === 'DRAFT_SOURCE_CONTRACT_MISMATCH'
  );
});

test('readiness explicitly grants no production or retry authority', () => {
  const ready = draftReadiness();
  assert.equal(ready.status, 'PRODUCTION_MIGRATION_DRAFT_READY_FOR_CI');
  assert.equal(ready.safety.transformsCopyOnly, true);
  assert.equal(ready.safety.productionFileMutated, false);
  assert.equal(ready.safety.liveAuthorityGranted, false);
  assert.equal(ready.safety.automaticRetryAdded, false);
  assert.equal(ready.safety.dualSubmitAdded, false);
  assert.equal(ready.safety.sellPathModified, false);
  assert.equal(ready.safety.strategyModified, false);
  assert.equal(ready.safety.sizingModified, false);
});
