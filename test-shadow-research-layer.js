'use strict';

process.env.SHADOW_RESEARCH_ENABLED = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEvidence, scoreEvidenceForSymbol } = require('./shadow-research-layer');

test('normalizes Alpaca market evidence as research-only', () => {
  const ev = normalizeEvidence({
    source: 'ALPACA',
    symbol: 'NVDA',
    kind: 'MARKET_CONFIRMATION',
    score: 0.7,
    confidence: 0.9,
    observedAt: new Date().toISOString(),
    title: 'Independent market confirmation',
    reference: 'https://example.com/path?token=secret'
  });
  assert.equal(ev.source, 'ALPACA');
  assert.equal(ev.symbol, 'NVDA');
  assert.equal(ev.researchOnly, true);
  assert.equal(ev.canAuthorizeLive, false);
  assert.equal(ev.reference, 'https://example.com/path');
});

test('rejects source-kind combinations outside source contract', () => {
  assert.throws(() => normalizeEvidence({
    source: 'ALPACA', symbol: 'MSFT', kind: 'GUIDANCE', score: 0.5, confidence: 0.8
  }), /KIND_NOT_ALLOWED_FOR_SOURCE/);
});

test('requires independent evidence before promotion eligibility', () => {
  const now = Date.now();
  const base = {
    symbol: 'NVDA', kind: 'MARKET_CONFIRMATION', score: 0.9, confidence: 0.9,
    observedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 3600_000).toISOString()
  };
  const one = normalizeEvidence({ ...base, source: 'ALPACA' });
  const oneScore = scoreEvidenceForSymbol('NVDA', [one], now);
  assert.equal(oneScore.independentSources, 1);
  assert.equal(oneScore.promotionEligible, false);

  const two = normalizeEvidence({
    source: 'EXA', symbol: 'NVDA', kind: 'CATALYST', score: 0.85, confidence: 0.9,
    observedAt: base.observedAt, expiresAt: base.expiresAt
  });
  const twoScore = scoreEvidenceForSymbol('NVDA', [one, two], now);
  assert.equal(twoScore.independentSources, 2);
  assert.ok(twoScore.researchScore >= 70);
  assert.equal(twoScore.promotionEligible, true);
});

test('expired evidence does not influence active research score', () => {
  const now = Date.now();
  const ev = normalizeEvidence({
    source: 'EXA', symbol: 'PLTR', kind: 'NEWS', score: 1, confidence: 1,
    observedAt: new Date(now - 10 * 3600_000).toISOString(),
    expiresAt: new Date(now - 1000).toISOString()
  });
  // normalizeEvidence replaces an invalid/expired expiresAt with a valid future TTL,
  // so force expiry for the pure scoring test.
  ev.expiresAt = new Date(now - 1000).toISOString();
  const scored = scoreEvidenceForSymbol('PLTR', [ev], now);
  assert.equal(scored.activeEvidence, 0);
  assert.equal(scored.researchScore, 50);
});
