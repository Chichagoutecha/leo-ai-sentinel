'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DECISION_OBSERVABILITY_AUTO_INSTALL = 'false';
const mod = require('./decision-observability.js');

test('fresh scan diagnostics are appended without changing the original decision fields', () => {
  const now = Date.parse('2026-09-02T20:00:30.000Z');
  const result = {
    event: 'SCAN_COMPLETED', source: 'auto-trade-cron',
    decision: { action: 'HOLD', asset: 'NONE', amount_usd: 0, confidence: 58 },
    risk: { approved: false, reason: 'HOLD choisi' }
  };
  const diagnostics = {
    generatedAt: '2026-09-02T20:00:20.000Z', completedAt: '2026-09-02T20:00:25.000Z', source: 'auto-trade-cron',
    council: { approvedBuys: ['SPY'], topCandidates: [{ asset: 'SPY', status: 'APPROVED_BUY' }] },
    executionWindow: { closedMappedAssets: ['SPY'] },
    providerDecision: { action: 'HOLD', asset: 'NONE', confidence: 58 }
  };
  const enriched = mod.enrichScanResult(result, diagnostics, now);
  assert.deepEqual(enriched.decision, result.decision);
  assert.deepEqual(enriched.risk, result.risk);
  assert.equal(enriched.decision_diagnostics.council.approvedBuys[0], 'SPY');
  assert.equal(enriched.decision_diagnostics.governance.logOnly, true);
  assert.equal(enriched.decision_diagnostics.governance.orderModified, false);
});

test('stale or mismatched diagnostics are not attached', () => {
  const result = { event: 'SCAN_COMPLETED', source: 'auto-trade-cron', decision: { action: 'HOLD' } };
  const stale = { generatedAt: '2026-09-02T19:00:00.000Z', source: 'auto-trade-cron' };
  assert.equal(mod.enrichScanResult(result, stale, Date.parse('2026-09-02T20:00:00.000Z')), result);
  const other = { generatedAt: '2026-09-02T20:00:00.000Z', source: 'manual-scan' };
  assert.equal(mod.enrichScanResult(result, other, Date.parse('2026-09-02T20:00:10.000Z')), result);
});

test('sanitizer strips secret-like fields recursively', () => {
  const clean = mod.sanitize({
    ok: true,
    token: 'secret-token',
    nested: { 'x-api-key': 'secret-key', reason: 'safe', request_id: 'internal' }
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.token, undefined);
  assert.equal(clean.nested['x-api-key'], undefined);
  assert.equal(clean.nested.request_id, undefined);
  assert.equal(clean.nested.reason, 'safe');
});
