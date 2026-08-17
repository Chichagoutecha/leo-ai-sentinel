'use strict';

process.env.FOUNDATION_CALIBRATION_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const bench = require('./foundation-calibration-bench');

test('shadow price map only uses valid top-candidate prices', () => {
  const map = bench.shadowPriceMap({
    lastScan: {
      scannedAt: '2026-08-17T12:00:00.000Z',
      topCandidates: [
        { symbol: 'SPY', mid: 650.25 },
        { symbol: 'bad', mid: 0 },
        { symbol: '', mid: 100 }
      ]
    }
  });
  assert.equal(map.size, 1);
  assert.equal(map.get('SPY').price, 650.25);
});

test('Alpaca calibration pairs are deduplicated across repeated captures', () => {
  const source = bench.freshState();
  const audit = [{
    id: 'pair-1', symbol: 'SPY', evaluatedAt: '2026-08-17T12:00:00.000Z',
    status: 'CONFIRMED', reason: 'INDEPENDENT_PRICE_CONFIRMATION', priceDivergencePct: 0.04, confidence: 0.94
  }];
  const first = bench.mergeCaptureIntoState(source, { priceMap: new Map(), alpacaAudit: audit, exaAudit: [] }, Date.parse('2026-08-17T12:01:00Z'));
  const second = bench.mergeCaptureIntoState(first.state, { priceMap: new Map(), alpacaAudit: audit, exaAudit: [] }, Date.parse('2026-08-17T12:02:00Z'));
  assert.equal(first.delta.alpacaAdded, 1);
  assert.equal(second.delta.alpacaAdded, 0);
  assert.equal(second.state.alpacaPairs.length, 1);
});

test('Exa catalyst is anchored near event time and evaluated at J+1 without new market calls', () => {
  const t0 = '2026-08-17T12:00:00.000Z';
  const t1 = '2026-08-18T12:05:00.000Z';
  const event = [{
    id: 'exa-1', eventKey: 'NVDA:PARTNERSHIP:abc', symbol: 'NVDA', evaluatedAt: t0,
    eventType: 'PARTNERSHIP', status: 'CONFIRMED_CATALYST', directionScore: 0.8,
    confidence: 0.9, independentSourceGroups: 2, conflictRatio: 0, rumorRatio: 0
  }];
  const startPrices = new Map([['NVDA', { symbol: 'NVDA', price: 180, at: t0 }]]);
  const first = bench.mergeCaptureIntoState(bench.freshState(), { priceMap: startPrices, alpacaAudit: [], exaAudit: event }, Date.parse(t0));
  assert.equal(first.delta.exaAdded, 1);
  assert.equal(first.delta.anchored, 1);
  assert.equal(first.state.exaEvents[0].baselinePrice, 180);

  const laterPrices = new Map([['NVDA', { symbol: 'NVDA', price: 189, at: t1 }]]);
  const second = bench.mergeCaptureIntoState(first.state, { priceMap: laterPrices, alpacaAudit: [], exaAudit: [] }, Date.parse(t1));
  assert.equal(second.delta.outcomesAdded, 1);
  const outcome = second.state.exaEvents[0].outcomes.d1;
  assert.equal(outcome.returnPct, 5);
  assert.equal(outcome.directionalHit, true);
  assert.equal(outcome.signedEdgePct, 5);
});

test('Exa negative catalyst scores falling prices as a directional hit', () => {
  const t0 = '2026-08-17T12:00:00.000Z';
  const t1 = '2026-08-18T12:00:00.000Z';
  const event = [{
    id: 'exa-neg', eventKey: 'ABC:GUIDANCE:lowered', symbol: 'ABC', evaluatedAt: t0,
    eventType: 'GUIDANCE', status: 'PRIMARY_SOURCE_CATALYST', directionScore: -0.7,
    confidence: 0.85, independentSourceGroups: 1
  }];
  const first = bench.mergeCaptureIntoState(bench.freshState(), {
    priceMap: new Map([['ABC', { symbol: 'ABC', price: 100, at: t0 }]]), alpacaAudit: [], exaAudit: event
  }, Date.parse(t0));
  const second = bench.mergeCaptureIntoState(first.state, {
    priceMap: new Map([['ABC', { symbol: 'ABC', price: 95, at: t1 }]]), alpacaAudit: [], exaAudit: []
  }, Date.parse(t1));
  const outcome = second.state.exaEvents[0].outcomes.d1;
  assert.equal(outcome.returnPct, -5);
  assert.equal(outcome.directionalHit, true);
  assert.equal(outcome.signedEdgePct, 5);
});

test('calibration summaries expose paired-provider and catalyst predictive metrics', () => {
  const state = bench.freshState();
  state.alpacaPairs = [
    { id: '1', status: 'CONFIRMED', priceDivergencePct: 0.05 },
    { id: '2', status: 'CONFIRMED', priceDivergencePct: 0.08 },
    { id: '3', status: 'DIVERGENT', priceDivergencePct: 1.2 }
  ];
  state.exaEvents = [
    { id: 'e1', status: 'CONFIRMED_CATALYST', baselinePrice: 100, outcomes: { d1: { returnPct: 2, directionalHit: true, signedEdgePct: 2 } } },
    { id: 'e2', status: 'PRIMARY_SOURCE_CATALYST', baselinePrice: 100, outcomes: { d1: { returnPct: -1, directionalHit: false, signedEdgePct: -1 } } }
  ];
  const summary = bench.calibrationSummary(state);
  assert.equal(summary.alpaca.observations, 3);
  assert.equal(summary.alpaca.confirmedPct, 66.67);
  assert.equal(summary.exa.events, 2);
  assert.equal(summary.exa.horizons.d1.directionalOutcomes, 2);
  assert.equal(summary.exa.horizons.d1.hitRatePct, 50);
  assert.equal(summary.exa.horizons.d1.averageSignedEdgePct, 0.5);
});

test('calibration bench contains no trading endpoint or OpenAI client', () => {
  const source = fs.readFileSync(path.join(__dirname, 'foundation-calibration-bench.js'), 'utf8');
  assert.equal(/public-api\.etoro\.com/.test(source), false);
  assert.equal(/\/trading\/execution\//.test(source), false);
  assert.equal(/require\s*\(\s*['"]openai['"]\s*\)/.test(source), false);
  assert.equal(/LIVE_EXECUTION_ARMED\s*=/.test(source), false);
});
