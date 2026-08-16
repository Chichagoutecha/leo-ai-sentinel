'use strict';

/**
 * LEO-AI SENTINEL v10.23.3 — Quartr Fundamental Intelligence Agent
 *
 * Shadow/research only. The scoring engine intentionally has no Quartr network
 * client and no trading surface. A trusted adapter supplies company-reported,
 * normalized financial data (ideally from Quartr get_financials / filings).
 * Raw external instructions are never executed.
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const VERSION = 'v10.23.3-quartr-fundamental-intelligence';
const PREFIX = '[LEO_QUARTR_FUNDAMENTAL]';
const ENABLED = process.env.SHADOW_QUARTR_FUNDAMENTAL_ENABLED !== 'false';
const MAX_AUDIT = Math.round(clamp(process.env.SHADOW_QUARTR_MAX_AUDIT, 300, 50, 3000));
const MAX_REPORT_AGE_DAYS = clamp(process.env.SHADOW_QUARTR_MAX_REPORT_AGE_DAYS, 180, 30, 730);
const MIN_PERIODS = Math.round(clamp(process.env.SHADOW_QUARTR_MIN_PERIODS, 2, 2, 12));

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const HAS_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const STATE_KEY = String(process.env.SHADOW_QUARTR_STATE_KEY || 'leo:shadow-quartr:v10.23.3:state');
const STATE_FILE = process.env.SHADOW_QUARTR_STATE_FILE || path.join(
  process.env.PERSISTENT_DISK_PATH || '/tmp',
  'leo-shadow-quartr-fundamental-state.json'
);

let loaded = false;
let loadPromise = null;
let state = freshState();
let lastEvent = null;

function clamp(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function iso(ms = Date.now()) { return new Date(ms).toISOString(); }
function hash(value) { return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24); }
function validDate(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function sanitizeText(value, max = 900) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(ignore|disregard|override|system prompt|developer message|execute|buy now|sell now)\b/gi, '[filtered]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}
function pctChange(current, previous) {
  const c = finite(current);
  const p = finite(previous);
  if (c == null || p == null || p === 0) return null;
  return ((c / p) - 1) * 100;
}
function marginPct(numerator, revenue) {
  const n = finite(numerator);
  const r = finite(revenue);
  if (n == null || !(r > 0)) return null;
  return n / r * 100;
}
function capexAbs(value) {
  const n = finite(value);
  return n == null ? null : Math.abs(n);
}
function log(event, details = {}, level = 'log') {
  const payload = { component: 'LEO_QUARTR_FUNDAMENTAL', version: VERSION, event, at: iso(), ...details };
  lastEvent = payload;
  global.__LEO_QUARTR_FUNDAMENTAL_LAST_EVENT__ = payload;
  (console[level] || console.log)(`${PREFIX} ${JSON.stringify(payload)}`);
}

function freshState() {
  return {
    version: VERSION,
    createdAt: iso(),
    updatedAt: iso(),
    audit: [],
    stats: {
      analyses: 0,
      strong: 0,
      healthy: 0,
      mixed: 0,
      weak: 0,
      inconclusive: 0,
      evidenceIngested: 0,
      evidenceRejected: 0,
      networkCalls: 0,
      executionCalls: 0,
      openAiCalls: 0,
      openAiCostUsd: 0
    }
  };
}
function normalizeState(value) {
  const base = freshState();
  if (!value || typeof value !== 'object') return base;
  return {
    ...base,
    ...value,
    version: VERSION,
    audit: Array.isArray(value.audit) ? value.audit.slice(-MAX_AUDIT) : [],
    stats: {
      ...base.stats,
      ...(value.stats || {}),
      networkCalls: 0,
      executionCalls: 0,
      openAiCalls: 0,
      openAiCostUsd: 0
    }
  };
}
async function redis(command) {
  if (!HAS_UPSTASH) throw new Error('UPSTASH_NOT_CONFIGURED');
  const response = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!response.ok) throw new Error(`UPSTASH_HTTP_${response.status}`);
  const json = await response.json();
  if (json?.error) throw new Error(`UPSTASH_${json.error}`);
  return json?.result ?? null;
}
async function loadState() {
  if (loaded) return state;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      if (HAS_UPSTASH) {
        const raw = await redis(['GET', STATE_KEY]);
        state = raw ? normalizeState(JSON.parse(raw)) : freshState();
      } else if (fs.existsSync(STATE_FILE)) {
        state = normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      }
    } catch (error) {
      log('STATE_LOAD_FALLBACK', { error: String(error?.message || error).slice(0, 400) }, 'warn');
      state = normalizeState(state);
    }
    loaded = true;
    return state;
  })();
  try { return await loadPromise; } finally { loadPromise = null; }
}
async function saveState() {
  state.updatedAt = iso();
  const body = JSON.stringify(state);
  try {
    if (HAS_UPSTASH) {
      await redis(['SET', STATE_KEY, body]);
      return;
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    log('STATE_SAVE_FAILED', { error: String(error?.message || error).slice(0, 400) }, 'warn');
  }
}

function normalizePeriod(input = {}) {
  const revenue = finite(input.revenue);
  const grossProfit = finite(input.grossProfit);
  const operatingIncome = finite(input.operatingIncome);
  const netIncome = finite(input.netIncome);
  const epsDiluted = finite(input.epsDiluted ?? input.eps);
  const operatingCashFlow = finite(input.operatingCashFlow);
  const capitalExpenditures = capexAbs(input.capitalExpenditures ?? input.capex);
  const cashAndEquivalents = finite(input.cashAndEquivalents ?? input.cash);
  const totalDebt = finite(input.totalDebt ?? input.debt);
  const periodEnd = validDate(input.periodEnd ?? input.date);
  const reportedAt = validDate(input.reportedAt ?? input.filedAt ?? input.publishedAt) || periodEnd;
  if (!periodEnd || !(revenue > 0)) return null;
  const freeCashFlow = operatingCashFlow != null && capitalExpenditures != null
    ? operatingCashFlow - capitalExpenditures
    : null;
  return {
    periodEnd,
    reportedAt,
    periodType: String(input.periodType || 'quarterly').toLowerCase(),
    revenue,
    grossProfit,
    operatingIncome,
    netIncome,
    epsDiluted,
    operatingCashFlow,
    capitalExpenditures,
    freeCashFlow,
    cashAndEquivalents,
    totalDebt,
    grossMarginPct: round(input.grossMarginPct != null ? finite(input.grossMarginPct) : marginPct(grossProfit, revenue), 4),
    operatingMarginPct: round(input.operatingMarginPct != null ? finite(input.operatingMarginPct) : marginPct(operatingIncome, revenue), 4),
    netMarginPct: round(input.netMarginPct != null ? finite(input.netMarginPct) : marginPct(netIncome, revenue), 4),
    freeCashFlowMarginPct: round(marginPct(freeCashFlow, revenue), 4)
  };
}

function normalizeFundamentalBundle(input = {}) {
  const symbol = normalizeSymbol(input.symbol || input.ticker);
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(symbol)) return null;
  const periods = (Array.isArray(input.periods) ? input.periods : [])
    .map(normalizePeriod)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.periodEnd) - Date.parse(a.periodEnd));
  const guidance = input.guidance && typeof input.guidance === 'object' ? {
    direction: String(input.guidance.direction || 'UNKNOWN').toUpperCase(),
    revenueGrowthPctMid: finite(input.guidance.revenueGrowthPctMid),
    epsGrowthPctMid: finite(input.guidance.epsGrowthPctMid),
    observedAt: validDate(input.guidance.observedAt || input.guidance.reportedAt),
    summary: sanitizeText(input.guidance.summary, 600)
  } : null;
  const management = input.managementCommentary && typeof input.managementCommentary === 'object' ? {
    score: clamp(input.managementCommentary.score, 0, -1, 1),
    confidence: clamp(input.managementCommentary.confidence, 0.5, 0, 1),
    observedAt: validDate(input.managementCommentary.observedAt),
    summary: sanitizeText(input.managementCommentary.summary, 700)
  } : null;
  return {
    source: 'QUARTR',
    symbol,
    companyId: finite(input.companyId),
    companyName: sanitizeText(input.companyName, 160) || null,
    currency: String(input.currency || 'USD').toUpperCase().slice(0, 8),
    periods,
    guidance,
    management,
    sourceReference: sanitizeText(input.sourceReference, 500) || `urn:quartr:${symbol}`,
    adapterVersion: sanitizeText(input.adapterVersion, 80) || 'normalized-contract-v1'
  };
}

function findYearAgo(periods, latest) {
  if (!latest) return null;
  const target = Date.parse(latest.periodEnd) - 365.25 * 24 * 3600_000;
  let best = null;
  let distance = Infinity;
  for (const period of periods.slice(1)) {
    const d = Math.abs(Date.parse(period.periodEnd) - target);
    if (d < distance && d <= 75 * 24 * 3600_000) {
      best = period;
      distance = d;
    }
  }
  return best;
}

function linearScore(value, points) {
  const n = finite(value);
  if (n == null) return 50;
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  if (n <= sorted[0][0]) return sorted[0][1];
  if (n >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
  for (let i = 1; i < sorted.length; i += 1) {
    const [x2, y2] = sorted[i];
    const [x1, y1] = sorted[i - 1];
    if (n <= x2) {
      const t = (n - x1) / (x2 - x1);
      return y1 + t * (y2 - y1);
    }
  }
  return 50;
}

function scoreFundamentalBundle(input, options = {}) {
  const bundle = normalizeFundamentalBundle(input);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  if (!bundle || bundle.periods.length < MIN_PERIODS) {
    return {
      status: 'INCONCLUSIVE',
      reason: !bundle ? 'BUNDLE_INVALID' : 'INSUFFICIENT_PERIODS',
      symbol: bundle?.symbol || normalizeSymbol(input?.symbol || input?.ticker),
      bundle,
      canTrade: false,
      canAuthorizeLive: false,
      researchOnly: true
    };
  }

  const latest = bundle.periods[0];
  const yearAgo = findYearAgo(bundle.periods, latest) || bundle.periods[1] || null;
  const latestObserved = latest.reportedAt || latest.periodEnd;
  const ageDays = (nowMs - Date.parse(latestObserved)) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays < -5 || ageDays > clamp(options.maxReportAgeDays, MAX_REPORT_AGE_DAYS, 30, 730)) {
    return {
      status: 'INCONCLUSIVE',
      reason: ageDays < -5 ? 'REPORT_TIMESTAMP_FROM_FUTURE' : 'REPORT_STALE',
      symbol: bundle.symbol,
      bundle,
      reportAgeDays: round(ageDays, 2),
      canTrade: false,
      canAuthorizeLive: false,
      researchOnly: true
    };
  }

  const revenueGrowthPct = pctChange(latest.revenue, yearAgo?.revenue);
  const epsGrowthPct = pctChange(latest.epsDiluted, yearAgo?.epsDiluted);
  const opMarginDeltaPct = latest.operatingMarginPct != null && yearAgo?.operatingMarginPct != null
    ? latest.operatingMarginPct - yearAgo.operatingMarginPct
    : null;
  const fcfMarginDeltaPct = latest.freeCashFlowMarginPct != null && yearAgo?.freeCashFlowMarginPct != null
    ? latest.freeCashFlowMarginPct - yearAgo.freeCashFlowMarginPct
    : null;
  const cash = finite(latest.cashAndEquivalents);
  const debt = finite(latest.totalDebt);
  const netCash = cash != null && debt != null ? cash - debt : null;
  const debtToCash = cash > 0 && debt != null ? debt / cash : null;

  const growthScore = linearScore(revenueGrowthPct, [
    [-20, 5], [-10, 20], [0, 45], [8, 62], [15, 75], [25, 88], [50, 100]
  ]);
  const profitabilityLevel = linearScore(latest.operatingMarginPct, [
    [-20, 5], [0, 30], [5, 45], [15, 68], [25, 84], [40, 100]
  ]);
  const marginTrend = linearScore(opMarginDeltaPct, [
    [-10, 10], [-5, 25], [0, 55], [3, 75], [8, 95]
  ]);
  const profitabilityScore = 0.7 * profitabilityLevel + 0.3 * marginTrend;
  const cashFlowLevel = linearScore(latest.freeCashFlowMarginPct, [
    [-20, 5], [0, 35], [5, 55], [15, 75], [30, 95]
  ]);
  const cashFlowTrend = linearScore(fcfMarginDeltaPct, [
    [-10, 10], [-3, 30], [0, 55], [3, 72], [8, 92]
  ]);
  const cashFlowScore = 0.75 * cashFlowLevel + 0.25 * cashFlowTrend;
  let balanceSheetScore = 50;
  if (netCash != null) {
    if (netCash >= 0) balanceSheetScore = 82;
    else if (debtToCash != null && debtToCash <= 1.5) balanceSheetScore = 68;
    else if (debtToCash != null && debtToCash <= 3) balanceSheetScore = 50;
    else if (debtToCash != null && debtToCash <= 5) balanceSheetScore = 35;
    else balanceSheetScore = 20;
  }
  const earningsScore = 0.6 * linearScore(epsGrowthPct, [
    [-50, 5], [-20, 20], [0, 50], [15, 68], [30, 82], [60, 95]
  ]) + 0.4 * linearScore(latest.netMarginPct, [
    [-20, 10], [0, 35], [5, 50], [15, 70], [30, 90]
  ]);

  let guidanceAdjustment = 0;
  const guidanceDirection = bundle.guidance?.direction || 'UNKNOWN';
  if (guidanceDirection === 'RAISED') guidanceAdjustment += 5;
  else if (guidanceDirection === 'LOWERED') guidanceAdjustment -= 8;
  else if (guidanceDirection === 'WITHDRAWN') guidanceAdjustment -= 10;
  if (bundle.guidance?.revenueGrowthPctMid != null) {
    guidanceAdjustment += clamp(bundle.guidance.revenueGrowthPctMid / 10, 0, -4, 4);
  }

  const baseScore = 0.25 * growthScore + 0.25 * profitabilityScore + 0.20 * cashFlowScore +
    0.20 * balanceSheetScore + 0.10 * earningsScore;
  const qualityScore = round(clamp(baseScore + guidanceAdjustment, 50, 0, 100), 2);

  const flags = [];
  if (revenueGrowthPct != null && revenueGrowthPct < -5) flags.push('REVENUE_CONTRACTION');
  if (latest.operatingMarginPct != null && latest.operatingMarginPct < 0) flags.push('NEGATIVE_OPERATING_MARGIN');
  if (latest.freeCashFlow != null && latest.freeCashFlow < 0) flags.push('NEGATIVE_FREE_CASH_FLOW');
  if (debtToCash != null && debtToCash > 5) flags.push('HIGH_DEBT_TO_CASH');
  if (guidanceDirection === 'LOWERED' || guidanceDirection === 'WITHDRAWN') flags.push('GUIDANCE_DETERIORATION');

  let status = 'MIXED';
  if (qualityScore >= 80 && flags.length === 0) status = 'STRONG';
  else if (qualityScore >= 65 && !flags.includes('GUIDANCE_DETERIORATION')) status = 'HEALTHY';
  else if (qualityScore < 45 || flags.length >= 3) status = 'WEAK';

  const confidenceFactors = [
    bundle.periods.length >= 5 ? 1 : bundle.periods.length >= 3 ? 0.8 : 0.65,
    yearAgo ? 1 : 0.6,
    latest.freeCashFlow != null ? 1 : 0.7,
    cash != null && debt != null ? 1 : 0.75
  ];
  const confidence = round(confidenceFactors.reduce((a, b) => a + b, 0) / confidenceFactors.length, 4);

  return {
    id: `quartr-fundamental-${hash(`${bundle.symbol}:${latest.periodEnd}:${qualityScore}`)}`,
    evaluatedAt: iso(nowMs),
    status,
    reason: 'FUNDAMENTAL_SCORE_COMPUTED',
    symbol: bundle.symbol,
    companyId: bundle.companyId,
    companyName: bundle.companyName,
    qualityScore,
    confidence,
    reportAgeDays: round(ageDays, 2),
    components: {
      growth: round(growthScore, 2),
      profitability: round(profitabilityScore, 2),
      cashFlow: round(cashFlowScore, 2),
      balanceSheet: round(balanceSheetScore, 2),
      earnings: round(earningsScore, 2),
      guidanceAdjustment: round(guidanceAdjustment, 2)
    },
    metrics: {
      revenueGrowthPct: round(revenueGrowthPct, 4),
      epsGrowthPct: round(epsGrowthPct, 4),
      grossMarginPct: latest.grossMarginPct,
      operatingMarginPct: latest.operatingMarginPct,
      operatingMarginDeltaPct: round(opMarginDeltaPct, 4),
      netMarginPct: latest.netMarginPct,
      freeCashFlow: round(latest.freeCashFlow, 2),
      freeCashFlowMarginPct: latest.freeCashFlowMarginPct,
      freeCashFlowMarginDeltaPct: round(fcfMarginDeltaPct, 4),
      cashAndEquivalents: cash,
      totalDebt: debt,
      netCash: round(netCash, 2),
      debtToCash: round(debtToCash, 4)
    },
    guidance: bundle.guidance,
    management: bundle.management,
    flags,
    sourceReference: bundle.sourceReference,
    adapterVersion: bundle.adapterVersion,
    canTrade: false,
    canAuthorizeLive: false,
    researchOnly: true
  };
}

function signedScoreFromQuality(qualityScore) {
  const q = clamp(qualityScore, 50, 0, 100);
  return clamp((q - 50) / 50, 0, -1, 1);
}

function evidenceFromFundamentalReport(report) {
  if (!report || !report.symbol || report.status === 'INCONCLUSIVE') return [];
  const observedAt = report.evaluatedAt || iso();
  const confidence = clamp(report.confidence, 0.5, 0, 1);
  const evidence = [
    {
      source: 'QUARTR',
      symbol: report.symbol,
      kind: 'FUNDAMENTAL',
      score: round(signedScoreFromQuality(report.qualityScore), 4),
      confidence,
      observedAt,
      ttlHours: 24 * 120,
      title: `Quartr fundamental quality ${report.symbol}`,
      summary: `Quality ${report.qualityScore}/100; status ${report.status}; revenue growth ${report.metrics?.revenueGrowthPct ?? 'n/a'}%; operating margin ${report.metrics?.operatingMarginPct ?? 'n/a'}%.`,
      reference: report.sourceReference
    },
    {
      source: 'QUARTR',
      symbol: report.symbol,
      kind: 'CASH_FLOW',
      score: round(clamp((Number(report.components?.cashFlow || 50) - 50) / 50, 0, -1, 1), 4),
      confidence,
      observedAt,
      ttlHours: 24 * 120,
      title: `Quartr cash-flow quality ${report.symbol}`,
      summary: `FCF margin ${report.metrics?.freeCashFlowMarginPct ?? 'n/a'}%; FCF trend ${report.metrics?.freeCashFlowMarginDeltaPct ?? 'n/a'} points.`,
      reference: report.sourceReference
    },
    {
      source: 'QUARTR',
      symbol: report.symbol,
      kind: 'BALANCE_SHEET',
      score: round(clamp((Number(report.components?.balanceSheet || 50) - 50) / 50, 0, -1, 1), 4),
      confidence,
      observedAt,
      ttlHours: 24 * 120,
      title: `Quartr balance-sheet quality ${report.symbol}`,
      summary: `Net cash ${report.metrics?.netCash ?? 'n/a'}; debt/cash ${report.metrics?.debtToCash ?? 'n/a'}.`,
      reference: report.sourceReference
    }
  ];

  if (report.guidance && report.guidance.direction !== 'UNKNOWN') {
    let guidanceScore = 0;
    if (report.guidance.direction === 'RAISED') guidanceScore = 0.75;
    else if (report.guidance.direction === 'MAINTAINED') guidanceScore = 0.15;
    else if (report.guidance.direction === 'LOWERED') guidanceScore = -0.8;
    else if (report.guidance.direction === 'WITHDRAWN') guidanceScore = -0.9;
    evidence.push({
      source: 'QUARTR',
      symbol: report.symbol,
      kind: 'GUIDANCE',
      score: guidanceScore,
      confidence,
      observedAt: report.guidance.observedAt || observedAt,
      ttlHours: 24 * 90,
      title: `Quartr guidance ${report.symbol}: ${report.guidance.direction}`,
      summary: sanitizeText(report.guidance.summary, 700),
      reference: report.sourceReference
    });
  }

  if (report.management && Number.isFinite(Number(report.management.score))) {
    evidence.push({
      source: 'QUARTR',
      symbol: report.symbol,
      kind: 'MANAGEMENT_COMMENTARY',
      score: clamp(report.management.score, 0, -1, 1),
      confidence: clamp(report.management.confidence, 0.5, 0, 1),
      observedAt: report.management.observedAt || observedAt,
      ttlHours: 24 * 90,
      title: `Quartr management commentary ${report.symbol}`,
      summary: sanitizeText(report.management.summary, 700),
      reference: report.sourceReference
    });
  }
  return evidence;
}

async function ingestFundamentalBundle(input, options = {}) {
  await loadState();
  if (!ENABLED) return { ok: false, reason: 'DISABLED' };
  const report = scoreFundamentalBundle(input, options);
  state.stats.analyses += 1;
  const bucket = String(report.status || 'INCONCLUSIVE').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(state.stats, bucket)) state.stats[bucket] += 1;
  else state.stats.inconclusive += 1;

  const evidence = evidenceFromFundamentalReport(report);
  let evidenceResults = [];
  const researchIngest = global.__LEO_SHADOW_RESEARCH_BULK_INGEST__;
  if (evidence.length && typeof researchIngest === 'function') {
    evidenceResults = await researchIngest(evidence);
    for (const result of evidenceResults) {
      if (result?.ok) state.stats.evidenceIngested += 1;
      else state.stats.evidenceRejected += 1;
    }
  }

  state.audit.push({
    id: report.id || `quartr-${hash(JSON.stringify(input))}`,
    evaluatedAt: report.evaluatedAt || iso(),
    symbol: report.symbol || null,
    status: report.status,
    qualityScore: report.qualityScore ?? null,
    confidence: report.confidence ?? null,
    flags: Array.isArray(report.flags) ? report.flags : [],
    evidenceAttempted: evidence.length,
    evidenceAccepted: evidenceResults.filter((item) => item?.ok).length
  });
  state.audit = state.audit.slice(-MAX_AUDIT);
  await saveState();
  log('ANALYSIS_COMPLETED', {
    symbol: report.symbol || null,
    status: report.status,
    qualityScore: report.qualityScore ?? null,
    confidence: report.confidence ?? null,
    flags: Array.isArray(report.flags) ? report.flags : [],
    evidenceAccepted: evidenceResults.filter((item) => item?.ok).length,
    networkCalls: 0,
    executionCalls: 0,
    openAiCalls: 0
  }, report.status === 'WEAK' ? 'warn' : 'log');
  return { ok: true, report, evidence, evidenceResults };
}

async function stateSnapshot() {
  await loadState();
  return {
    version: VERSION,
    enabled: ENABLED,
    persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
    stats: { ...state.stats, networkCalls: 0, executionCalls: 0, openAiCalls: 0, openAiCostUsd: 0 },
    recentAudit: state.audit.slice(-30),
    lastEvent,
    settings: { maxReportAgeDays: MAX_REPORT_AGE_DAYS, minPeriods: MIN_PERIODS },
    safety: {
      researchOnly: true,
      canTrade: false,
      canAuthorizeLive: false,
      networkClientPresent: false,
      executionFunctionsPresent: false,
      automaticLivePromotion: false,
      rawExternalInstructionsExecuted: false,
      openAiEnabled: false,
      openAiCostUsd: 0
    }
  };
}

global.__LEO_QUARTR_FUNDAMENTAL_INGEST__ = ingestFundamentalBundle;
global.__LEO_QUARTR_FUNDAMENTAL_STATE__ = stateSnapshot;

log('STARTED', {
  enabled: ENABLED,
  persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
  networkClientPresent: false,
  executionFunctionsPresent: false,
  automaticLivePromotion: false,
  rawExternalInstructionsExecuted: false,
  openAiCalls: 0,
  openAiCostUsd: 0
});

module.exports = {
  VERSION,
  normalizePeriod,
  normalizeFundamentalBundle,
  scoreFundamentalBundle,
  evidenceFromFundamentalReport,
  ingestFundamentalBundle,
  stateSnapshot,
  sanitizeText
};
