'use strict';

/**
 * LEO-AI SENTINEL v10.23.1 — Shadow Opportunity Discovery Agent
 *
 * Combines the deterministic Shadow Lab ranking with normalized research
 * evidence. It can recommend what deserves more SHADOW research, but it never
 * changes the LIVE allowlist, never mutates shadow-universe.json automatically,
 * never calls OpenAI, and never touches an eToro execution endpoint.
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const VERSION = 'v10.23.1-shadow-opportunity-discovery';
const PREFIX = '[LEO_SHADOW_DISCOVERY]';
const ENABLED = process.env.SHADOW_DISCOVERY_ENABLED !== 'false';
const SCHEDULE = String(process.env.SHADOW_DISCOVERY_SCHEDULE || '38 */4 * * *').trim();
const STARTUP_DELAY_MINUTES = clamp(process.env.SHADOW_DISCOVERY_STARTUP_DELAY_MINUTES, 18, 0, 180);
const TOP_OPPORTUNITIES = Math.round(clamp(process.env.SHADOW_DISCOVERY_TOP_OPPORTUNITIES, 20, 5, 100));
const REVIEW_SCORE = clamp(process.env.SHADOW_DISCOVERY_REVIEW_SCORE, 68, 40, 95);
const RESEARCH_ONLY_REVIEW_SCORE = clamp(process.env.SHADOW_DISCOVERY_RESEARCH_ONLY_SCORE, 74, 50, 99);
const UNIVERSE_PATH = path.join(__dirname, 'shadow-universe.json');
const STATE_FILE = process.env.SHADOW_DISCOVERY_STATE_FILE || path.join(
  process.env.PERSISTENT_DISK_PATH || '/tmp',
  'leo-shadow-opportunity-discovery-state.json'
);
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const HAS_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const STATE_KEY = String(process.env.SHADOW_DISCOVERY_STATE_KEY || 'leo:shadow-discovery:v10.23.1:state');

const THEME_BOOSTS = Object.freeze({
  AI_BIG_TECH: 6,
  SEMICONDUCTORS: 7,
  CYBERSECURITY: 6,
  QUANTUM: 5,
  SPACE: 5,
  DEFENSE: 5,
  NUCLEAR: 5,
  ENERGY: 3,
  HEALTHCARE: 3,
  BIOTECH: 4,
  ROBOTICS: 4,
  FINANCE: 2,
  CORE_EQUITY: 2,
  ETF: 2,
  CRYPTO: 2
});

let state = freshState();
let loaded = false;
let lastEvent = null;
let running = false;

function clamp(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function iso() { return new Date().toISOString(); }
function round(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
function log(event, details = {}, level = 'log') {
  const payload = { component: 'LEO_SHADOW_OPPORTUNITY_DISCOVERY', version: VERSION, event, at: iso(), ...details };
  lastEvent = payload;
  global.__LEO_SHADOW_DISCOVERY_LAST_EVENT__ = payload;
  (console[level] || console.log)(`${PREFIX} ${JSON.stringify(payload)}`);
}
function freshState() {
  return {
    version: VERSION,
    createdAt: iso(),
    updatedAt: iso(),
    runs: 0,
    history: [],
    lastRanking: [],
    researchOnlyCandidates: [],
    stats: { openAiCalls: 0, openAiCostUsd: 0, executionCalls: 0, liveMutations: 0, shadowUniverseMutations: 0 }
  };
}
function normalizeState(value) {
  const base = freshState();
  if (!value || typeof value !== 'object') return base;
  return {
    ...base,
    ...value,
    version: VERSION,
    history: Array.isArray(value.history) ? value.history.slice(-120) : [],
    lastRanking: Array.isArray(value.lastRanking) ? value.lastRanking.slice(0, TOP_OPPORTUNITIES) : [],
    researchOnlyCandidates: Array.isArray(value.researchOnlyCandidates) ? value.researchOnlyCandidates.slice(0, TOP_OPPORTUNITIES) : [],
    stats: { ...base.stats, ...(value.stats || {}), openAiCalls: 0, openAiCostUsd: 0, executionCalls: 0, liveMutations: 0, shadowUniverseMutations: 0 }
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
  try {
    if (HAS_UPSTASH) {
      const raw = await redis(['GET', STATE_KEY]);
      state = raw ? normalizeState(JSON.parse(raw)) : freshState();
    } else if (fs.existsSync(STATE_FILE)) {
      state = normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    }
  } catch (error) {
    log('STATE_LOAD_FALLBACK', { error: String(error.message || error).slice(0, 400) }, 'warn');
    state = normalizeState(state);
  }
  loaded = true;
  return state;
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
    log('STATE_SAVE_FAILED', { error: String(error.message || error).slice(0, 400) }, 'warn');
  }
}
function loadUniverse() {
  try {
    const json = JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8'));
    return Array.isArray(json.assets) ? json.assets.map((a) => ({
      symbol: String(a.symbol || '').toUpperCase(),
      bucket: String(a.bucket || 'UNCLASSIFIED').toUpperCase(),
      priority: clamp(a.priority, 2, 0, 10)
    })).filter((a) => a.symbol) : [];
  } catch {
    return [];
  }
}
function themeBoost(bucket) {
  const key = String(bucket || '').toUpperCase();
  for (const [theme, boost] of Object.entries(THEME_BOOSTS)) {
    if (key.includes(theme)) return boost;
  }
  return 0;
}

function scoreOpportunity({ market, research, universeAsset }) {
  const marketScore = Number.isFinite(Number(market?.score)) ? clamp(market.score, 50, 0, 100) : null;
  const researchScore = Number.isFinite(Number(research?.researchScore)) ? clamp(research.researchScore, 50, 0, 100) : 50;
  const independentSources = Number(research?.independentSources || 0);
  const confidence = clamp(research?.confidence, 0, 0, 1);
  const priority = clamp(universeAsset?.priority, 2, 0, 10);
  const boost = themeBoost(universeAsset?.bucket || market?.bucket);

  let score;
  if (marketScore == null) {
    score = researchScore * 0.78 + Math.min(10, independentSources * 3) + confidence * 6 + boost * 0.5;
  } else {
    score = marketScore * 0.58 + researchScore * 0.27 + priority * 0.8 + boost;
    if (independentSources >= 2) score += 2;
    if (confidence >= 0.75) score += 2;
    const spread = Number(market?.spreadPct);
    if (Number.isFinite(spread)) {
      if (spread > 2.5) score -= 12;
      else if (spread > 1.0) score -= 5;
      else if (spread <= 0.25) score += 3;
    }
    const freshness = Number(market?.freshnessMinutes);
    if (Number.isFinite(freshness) && freshness > 120) score -= 12;
  }
  score = clamp(score, 50, 0, 100);

  const inUniverse = Boolean(universeAsset);
  let status = 'OBSERVE';
  if (marketScore != null && market?.eligible !== false && score >= REVIEW_SCORE) status = 'PRIORITY_SHADOW_RESEARCH';
  if (!inUniverse && researchScore >= RESEARCH_ONLY_REVIEW_SCORE && independentSources >= 2 && confidence >= 0.65) {
    status = 'ELIGIBLE_FOR_SHADOW_UNIVERSE_REVIEW';
  }

  return {
    symbol: String(market?.symbol || research?.symbol || universeAsset?.symbol || '').toUpperCase(),
    bucket: universeAsset?.bucket || market?.bucket || 'RESEARCH_DISCOVERY',
    score: round(score, 2),
    marketScore: marketScore == null ? null : round(marketScore, 2),
    researchScore: round(researchScore, 2),
    researchConfidence: round(confidence, 4),
    independentSources,
    sources: Array.isArray(research?.sources) ? research.sources : [],
    marketEligible: market?.eligible ?? null,
    spreadPct: Number.isFinite(Number(market?.spreadPct)) ? Number(market.spreadPct) : null,
    observedReturnsPct: market?.observedReturnsPct || null,
    status,
    inShadowUniverse: inUniverse,
    canTrade: false,
    canModifyLiveAllowlist: false,
    automaticShadowUniverseMutation: false
  };
}

async function getShadowState() {
  if (typeof global.__LEO_SHADOW_LAB_STATE__ !== 'function') return null;
  try { return await global.__LEO_SHADOW_LAB_STATE__(); }
  catch { return null; }
}
async function getResearchState() {
  if (typeof global.__LEO_SHADOW_RESEARCH_STATE__ !== 'function') return null;
  try { return await global.__LEO_SHADOW_RESEARCH_STATE__(); }
  catch { return null; }
}

async function runDiscovery(trigger = 'manual-internal') {
  if (!ENABLED) return { ok: false, skipped: true, reason: 'DISABLED' };
  if (running) return { ok: false, skipped: true, reason: 'RUN_ALREADY_ACTIVE' };
  running = true;
  const startedAt = Date.now();
  try {
    await loadState();
    const [shadow, research] = await Promise.all([getShadowState(), getResearchState()]);
    const universe = loadUniverse();
    const byUniverse = new Map(universe.map((a) => [a.symbol, a]));
    const marketCandidates = Array.isArray(shadow?.lastScan?.topCandidates) ? shadow.lastScan.topCandidates : [];
    const byMarket = new Map(marketCandidates.map((c) => [String(c.symbol || '').toUpperCase(), c]));
    const researchScores = Array.isArray(research?.symbolScores) ? research.symbolScores : [];
    const byResearch = new Map(researchScores.map((r) => [String(r.symbol || '').toUpperCase(), r]));
    const symbols = new Set([...byMarket.keys(), ...byResearch.keys()]);

    const ranking = [];
    for (const symbol of symbols) {
      const market = byMarket.get(symbol) || null;
      const researchItem = byResearch.get(symbol) || { symbol, researchScore: 50, confidence: 0, independentSources: 0, sources: [] };
      const universeAsset = byUniverse.get(symbol) || null;
      ranking.push(scoreOpportunity({ market, research: researchItem, universeAsset }));
    }
    ranking.sort((a, b) => b.score - a.score || b.independentSources - a.independentSources || a.symbol.localeCompare(b.symbol));

    const researchOnly = ranking.filter((item) => item.status === 'ELIGIBLE_FOR_SHADOW_UNIVERSE_REVIEW');
    state.runs += 1;
    state.lastRanking = ranking.slice(0, TOP_OPPORTUNITIES);
    state.researchOnlyCandidates = researchOnly.slice(0, TOP_OPPORTUNITIES);
    const record = {
      at: iso(), trigger, durationMs: Date.now() - startedAt,
      marketCandidates: byMarket.size,
      researchSymbols: byResearch.size,
      rankedSymbols: ranking.length,
      priorityResearch: ranking.filter((x) => x.status === 'PRIORITY_SHADOW_RESEARCH').length,
      shadowUniverseReviewCandidates: researchOnly.length,
      top: state.lastRanking.slice(0, 10)
    };
    state.history.push(record);
    state.history = state.history.slice(-120);
    await saveState();
    log('DISCOVERY_COMPLETED', {
      trigger,
      durationMs: record.durationMs,
      rankedSymbols: record.rankedSymbols,
      priorityResearch: record.priorityResearch,
      shadowUniverseReviewCandidates: record.shadowUniverseReviewCandidates,
      top: record.top.slice(0, 5).map((x) => ({ symbol: x.symbol, score: x.score, status: x.status })),
      openAiCalls: 0,
      executionCalls: 0
    });
    return { ok: true, ...record };
  } catch (error) {
    log('DISCOVERY_FAILED', { trigger, error: String(error.message || error).slice(0, 700) }, 'warn');
    return { ok: false, error: String(error.message || error) };
  } finally {
    running = false;
  }
}

async function stateSnapshot() {
  await loadState();
  return {
    version: VERSION,
    enabled: ENABLED,
    schedule: SCHEDULE,
    running,
    persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
    runs: state.runs,
    lastRanking: state.lastRanking,
    researchOnlyCandidates: state.researchOnlyCandidates,
    lastRun: state.history[state.history.length - 1] || null,
    stats: { ...state.stats, openAiCalls: 0, openAiCostUsd: 0, executionCalls: 0, liveMutations: 0, shadowUniverseMutations: 0 },
    lastEvent,
    safety: {
      shadowOnly: true,
      canTrade: false,
      canModifyLiveAllowlist: false,
      automaticShadowUniverseMutation: false,
      openAiEnabled: false,
      openAiCostUsd: 0
    }
  };
}

global.__LEO_SHADOW_DISCOVERY_RUN__ = runDiscovery;
global.__LEO_SHADOW_DISCOVERY_STATE__ = stateSnapshot;

if (ENABLED) {
  try {
    cron.schedule(SCHEDULE, () => {
      runDiscovery('shadow-discovery-cron').catch((error) => log('CRON_UNHANDLED', { error: String(error.message || error) }, 'warn'));
    });
  } catch (error) {
    log('SCHEDULE_INVALID', { schedule: SCHEDULE, error: String(error.message || error) }, 'warn');
  }
  const timer = setTimeout(() => {
    runDiscovery('startup-delay').catch((error) => log('STARTUP_UNHANDLED', { error: String(error.message || error) }, 'warn'));
  }, STARTUP_DELAY_MINUTES * 60_000);
  if (typeof timer.unref === 'function') timer.unref();
}

log('STARTED', {
  enabled: ENABLED,
  schedule: SCHEDULE,
  startupDelayMinutes: STARTUP_DELAY_MINUTES,
  openAiCalls: 0,
  openAiCostUsd: 0,
  executionCalls: 0,
  automaticLivePromotion: false,
  automaticShadowUniverseMutation: false
});

module.exports = { VERSION, scoreOpportunity, runDiscovery, stateSnapshot, themeBoost };
