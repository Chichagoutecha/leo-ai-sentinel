'use strict';

process.env.SHADOW_DISCOVERY_ENABLED = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreOpportunity } = require('./shadow-opportunity-discovery');

test('strong in-universe market plus research becomes priority shadow research', () => {
  const result = scoreOpportunity({
    market: { symbol: 'NVDA', score: 82, eligible: true, spreadPct: 0.08, freshnessMinutes: 2, bucket: 'SEMICONDUCTORS' },
    research: { symbol: 'NVDA', researchScore: 78, confidence: 0.82, independentSources: 2, sources: ['ALPACA', 'QUARTR'] },
    universeAsset: { symbol: 'NVDA', bucket: 'SEMICONDUCTORS', priority: 8 }
  });
  assert.equal(result.status, 'PRIORITY_SHADOW_RESEARCH');
  assert.equal(result.canTrade, false);
  assert.equal(result.canModifyLiveAllowlist, false);
  assert.equal(result.automaticShadowUniverseMutation, false);
});

test('research-only symbol needs two sources for universe review', () => {
  const oneSource = scoreOpportunity({
    market: null,
    research: { symbol: 'NEWCO', researchScore: 90, confidence: 0.9, independentSources: 1, sources: ['EXA'] },
    universeAsset: null
  });
  assert.notEqual(oneSource.status, 'ELIGIBLE_FOR_SHADOW_UNIVERSE_REVIEW');

  const twoSources = scoreOpportunity({
    market: null,
    research: { symbol: 'NEWCO', researchScore: 90, confidence: 0.9, independentSources: 2, sources: ['EXA', 'QUARTR'] },
    universeAsset: null
  });
  assert.equal(twoSources.status, 'ELIGIBLE_FOR_SHADOW_UNIVERSE_REVIEW');
  assert.equal(twoSources.inShadowUniverse, false);
});

test('bad spread penalizes otherwise attractive market candidate', () => {
  const good = scoreOpportunity({
    market: { symbol: 'AAA', score: 80, eligible: true, spreadPct: 0.1, freshnessMinutes: 2 },
    research: { symbol: 'AAA', researchScore: 70, confidence: 0.7, independentSources: 2 },
    universeAsset: { symbol: 'AAA', bucket: 'CORE_EQUITY', priority: 5 }
  });
  const bad = scoreOpportunity({
    market: { symbol: 'AAA', score: 80, eligible: true, spreadPct: 4.0, freshnessMinutes: 2 },
    research: { symbol: 'AAA', researchScore: 70, confidence: 0.7, independentSources: 2 },
    universeAsset: { symbol: 'AAA', bucket: 'CORE_EQUITY', priority: 5 }
  });
  assert.ok(good.score > bad.score);
});
