'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeMacro, normalizeObservation } = require('./shadow-macro-intelligence-agent.js');

const now = new Date('2026-08-17T10:00:00Z');
function obs(value, source = 'FED', asOf = '2026-08-16T10:00:00Z') { return { value, source, sourceGroup: source, asOf }; }

function base() {
  return {
    policyRate: obs(3.5, 'FED'), inflationYoY: obs(2.4, 'BLS'), coreInflationYoY: obs(2.5, 'BLS'),
    unemployment: obs(4.0, 'BLS'), payrollTrend: obs(150, 'BLS'), pmi: obs(53, 'ISM'),
    yield2y: obs(3.4, 'TREASURY'), yield10y: obs(3.8, 'TREASURY'), dxyTrendPct: obs(-0.5, 'MARKET'),
    oilTrendPct: obs(-1.0, 'MARKET'), creditSpreadBps: obs(105, 'MARKET'), vix: obs(16, 'MARKET')
  };
}

test('classifies healthy disinflationary growth with strong provenance', () => {
  const r = analyzeMacro(base(), { now });
  assert.equal(r.status, 'DISINFLATIONARY_GROWTH');
  assert.ok(r.coveragePct >= 90);
  assert.ok(r.independentSources >= 2);
  assert.equal(r.safety.canTrade, false);
  assert.equal(r.safety.openAiCalls, 0);
});

test('future and stale observations are rejected', () => {
  const future = normalizeObservation('vix', obs(20, 'MARKET', '2026-08-18T10:00:00Z'), now);
  const stale = normalizeObservation('vix', obs(20, 'MARKET', '2026-08-10T10:00:00Z'), now);
  assert.equal(future.valid, false); assert.equal(future.reason, 'FUTURE');
  assert.equal(stale.valid, false); assert.equal(stale.reason, 'STALE');
});

test('insufficient independent data fails closed as INCONCLUSIVE', () => {
  const input = { policyRate: obs(4, 'ONE'), inflationYoY: obs(5, 'ONE'), pmi: obs(49, 'ONE') };
  const r = analyzeMacro(input, { now });
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.equal(r.safety.canAuthorizeLive, false);
});

test('detects tightening stress', () => {
  const input = base();
  input.inflationYoY = obs(6.5, 'BLS');
  input.coreInflationYoY = obs(6.2, 'BLS');
  input.policyRate = obs(6.0, 'FED');
  input.vix = obs(34, 'MARKET');
  input.creditSpreadBps = obs(240, 'MARKET');
  input.pmi = obs(48, 'ISM');
  const r = analyzeMacro(input, { now });
  assert.ok(['TIGHTENING_STRESS','INFLATION_PRESSURE','FINANCIAL_STRESS'].includes(r.status));
});
