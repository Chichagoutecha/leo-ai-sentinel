'use strict';

/**
 * LEO-AI SENTINEL — Stage 12 Macro Intelligence Agent (Shadow only)
 * Provider-decoupled macro normalizer + regime scorer.
 * No network client, no OpenAI, no eToro execution, no LIVE mutation.
 */

const VERSION = 'v10.24.0.1-macro-intelligence-runtime-safe';
const DEFAULT_MAX_AGE_DAYS = Object.freeze({
  policyRate: 120, inflationYoY: 45, coreInflationYoY: 45, unemployment: 45,
  payrollTrend: 45, pmi: 45, yield2y: 3, yield10y: 3, dxyTrendPct: 3,
  oilTrendPct: 3, creditSpreadBps: 3, vix: 1
});

let stats = { analyses: 0, staleInputs: 0, futureInputs: 0, inconclusive: 0, last: null };

function clamp(n, min, max) { const x = Number(n); return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : min; }
function finite(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function iso(v) { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
function daysBetween(a, b) { return (Date.parse(a) - Date.parse(b)) / 86400000; }
function sanitize(s, max = 160) { return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function safeDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  const t = value == null ? NaN : Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : new Date();
}
function safeObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

function normalizeObservation(name, raw, now = new Date()) {
  const effectiveNow = safeDate(now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { name, valid: false, reason: 'MISSING' };
  const value = finite(raw.value);
  const asOf = iso(raw.asOf);
  if (value == null || !asOf) return { name, valid: false, reason: 'INVALID_VALUE_OR_TIME' };
  const nowIso = effectiveNow.toISOString();
  const ageDays = daysBetween(nowIso, asOf);
  if (ageDays < -0.01) return { name, value, asOf, valid: false, reason: 'FUTURE', ageDays };
  const configuredMaxAge = finite(raw.maxAgeDays);
  const maxAgeDays = configuredMaxAge != null && configuredMaxAge >= 0 ? configuredMaxAge : (DEFAULT_MAX_AGE_DAYS[name] ?? 7);
  if (ageDays > maxAgeDays) return { name, value, asOf, valid: false, reason: 'STALE', ageDays, maxAgeDays };
  return {
    name, value, asOf, ageDays, maxAgeDays, valid: true,
    source: sanitize(raw.source || 'UNKNOWN', 80),
    sourceGroup: sanitize(raw.sourceGroup || raw.source || 'UNKNOWN', 80)
  };
}

function scoreMacro(observations) {
  const obs = safeObject(observations);
  const v = (k) => obs[k]?.valid ? obs[k].value : null;
  let growth = 0, inflation = 0, conditions = 0;
  const pmi = v('pmi');
  const unemp = v('unemployment');
  const payroll = v('payrollTrend');
  const cpi = v('inflationYoY');
  const core = v('coreInflationYoY');
  const policy = v('policyRate');
  const y2 = v('yield2y');
  const y10 = v('yield10y');
  const credit = v('creditSpreadBps');
  const vix = v('vix');
  const dxy = v('dxyTrendPct');
  const oil = v('oilTrendPct');

  if (pmi != null) growth += clamp((pmi - 50) * 8, -40, 40);
  if (unemp != null) growth += clamp((4.5 - unemp) * 12, -25, 25);
  if (payroll != null) growth += clamp(payroll / 10, -20, 20);

  if (cpi != null) inflation += clamp((cpi - 2) * 18, -35, 45);
  if (core != null) inflation += clamp((core - 2) * 20, -35, 45);
  if (oil != null) inflation += clamp(oil * 1.5, -20, 20);

  if (credit != null) conditions += clamp((140 - credit) / 2, -40, 35);
  if (vix != null) conditions += clamp((22 - vix) * 3, -35, 30);
  if (y2 != null && y10 != null) conditions += clamp((y10 - y2) * 15, -25, 25);
  if (dxy != null) conditions += clamp(-dxy * 2, -15, 15);
  if (policy != null && cpi != null) conditions += clamp((cpi - policy) * 5, -20, 20);

  growth = clamp(growth, -100, 100);
  inflation = clamp(inflation, -100, 100);
  conditions = clamp(conditions, -100, 100);

  let regime = 'MIXED';
  if (growth < -35 && conditions < -25) regime = 'RECESSION_RISK';
  else if (inflation > 35 && conditions < -15) regime = 'TIGHTENING_STRESS';
  else if (inflation > 40) regime = 'INFLATION_PRESSURE';
  else if (growth > 25 && inflation < 20 && conditions > 10) regime = 'DISINFLATIONARY_GROWTH';
  else if (growth > 20 && conditions > 30) regime = 'LIQUIDITY_RISK_ON';
  else if (conditions < -40) regime = 'FINANCIAL_STRESS';

  return { growthScore: growth, inflationPressureScore: inflation, financialConditionsScore: conditions, regime };
}

function analyzeMacro(input = {}, options = {}) {
  const safeInput = safeObject(input);
  const safeOptions = safeObject(options);
  const now = safeDate(safeOptions.now);
  const normalized = {};
  for (const name of Object.keys(DEFAULT_MAX_AGE_DAYS)) normalized[name] = normalizeObservation(name, safeInput[name], now);
  const valid = Object.values(normalized).filter(x => x.valid);
  const stale = Object.values(normalized).filter(x => x.reason === 'STALE').length;
  const future = Object.values(normalized).filter(x => x.reason === 'FUTURE').length;
  const independentSources = new Set(valid.map(x => x.sourceGroup).filter(Boolean)).size;
  const coveragePct = Math.round(valid.length / Object.keys(DEFAULT_MAX_AGE_DAYS).length * 10000) / 100;
  const score = scoreMacro(normalized);
  const status = valid.length >= 6 && independentSources >= 2 ? score.regime : 'INCONCLUSIVE';
  stats.analyses += 1; stats.staleInputs += stale; stats.futureInputs += future; if (status === 'INCONCLUSIVE') stats.inconclusive += 1;
  const result = {
    version: VERSION, at: now.toISOString(), status,
    ...score, coveragePct, validInputs: valid.length, independentSources,
    observations: normalized,
    safety: { shadowOnly: true, canTrade: false, canAuthorizeLive: false, networkClientPresent: false, openAiCalls: 0, executionCalls: 0 }
  };
  stats.last = result;
  return result;
}

function getState() { return { version: VERSION, stats: { ...stats }, safety: { shadowOnly: true, canTrade: false, canAuthorizeLive: false, networkClientPresent: false } }; }
global.__LEO_MACRO_INTELLIGENCE_STATE__ = getState;
global.__LEO_MACRO_INTELLIGENCE_ANALYZE__ = analyzeMacro;

module.exports = { VERSION, DEFAULT_MAX_AGE_DAYS, safeDate, normalizeObservation, scoreMacro, analyzeMacro, getState };