'use strict';

/**
 * LEO-AI SENTINEL v10.23.1 — Shadow Research Layer
 *
 * Research-only evidence registry. It is intentionally disconnected from LIVE
 * execution and never calls OpenAI. ChatGPT plugins/connectors such as Alpaca,
 * Quartr and Exa can be used by the research workflow to produce normalized
 * evidence, but Render does not magically inherit those plugin connections.
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const VERSION = 'v10.23.1-shadow-research-layer';
const PREFIX = '[LEO_SHADOW_RESEARCH]';
const ENABLED = process.env.SHADOW_RESEARCH_ENABLED !== 'false';
const MAX_EVIDENCE = Math.round(clamp(process.env.SHADOW_RESEARCH_MAX_EVIDENCE, 2500, 100, 20000));
const MAX_PER_SYMBOL = Math.round(clamp(process.env.SHADOW_RESEARCH_MAX_PER_SYMBOL, 80, 10, 500));
const STATE_KEY = String(process.env.SHADOW_RESEARCH_STATE_KEY || 'leo:shadow-research:v10.23.1:state');
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const HAS_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const STATE_FILE = process.env.SHADOW_RESEARCH_STATE_FILE || path.join(
  process.env.PERSISTENT_DISK_PATH || '/tmp',
  'leo-shadow-research-state.json'
);
const SOURCES_PATH = path.join(__dirname, 'shadow-research-sources.json');

const ALLOWED_KINDS = new Set([
  'MARKET_CONFIRMATION', 'LIQUIDITY', 'VOLATILITY', 'TECHNICAL_CONFIRMATION',
  'FUNDAMENTAL', 'EARNINGS', 'GUIDANCE', 'BALANCE_SHEET', 'CASH_FLOW',
  'MANAGEMENT_COMMENTARY', 'NEWS', 'CATALYST', 'RISK', 'THEME', 'RESEARCH'
]);
const DEFAULT_TTL_HOURS = Object.freeze({
  MARKET_CONFIRMATION: 8,
  LIQUIDITY: 12,
  VOLATILITY: 24,
  TECHNICAL_CONFIRMATION: 24,
  NEWS: 72,
  CATALYST: 168,
  RISK: 168,
  THEME: 720,
  RESEARCH: 720,
  EARNINGS: 2160,
  GUIDANCE: 2160,
  FUNDAMENTAL: 4320,
  BALANCE_SHEET: 4320,
  CASH_FLOW: 4320,
  MANAGEMENT_COMMENTARY: 2160
});

let sourceManifest = loadSourceManifest();
let state = freshState();
let loaded = false;
let loadPromise = null;
let lastEvent = null;

function clamp(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function iso() { return new Date().toISOString(); }
function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
function hash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24);
}
function sanitizeText(value, max = 600) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function safeReference(value) {
  const raw = sanitizeText(value, 500);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    return raw.slice(0, 240);
  }
}
function validDate(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function log(event, details = {}, level = 'log') {
  const payload = { component: 'LEO_SHADOW_RESEARCH_LAYER', version: VERSION, event, at: iso(), ...details };
  lastEvent = payload;
  global.__LEO_SHADOW_RESEARCH_LAST_EVENT__ = payload;
  (console[level] || console.log)(`${PREFIX} ${JSON.stringify(payload)}`);
}

function loadSourceManifest() {
  try {
    return JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  } catch {
    return { sources: {}, promotionRules: {} };
  }
}
function sourceDefinition(source) {
  return sourceManifest?.sources?.[source] || null;
}
function sourceReliability(source) {
  return clamp(sourceDefinition(source)?.defaultReliability, 0.5, 0, 1);
}
function freshState() {
  return {
    version: VERSION,
    createdAt: iso(),
    updatedAt: iso(),
    evidence: [],
    stats: { ingested: 0, duplicates: 0, rejected: 0, pruned: 0, openAiCalls: 0, openAiCostUsd: 0, executionCalls: 0 }
  };
}
function normalizeState(value) {
  const base = freshState();
  if (!value || typeof value !== 'object') return base;
  return {
    ...base,
    ...value,
    version: VERSION,
    evidence: Array.isArray(value.evidence) ? value.evidence.slice(-MAX_EVIDENCE) : [],
    stats: { ...base.stats, ...(value.stats || {}), openAiCalls: 0, openAiCostUsd: 0, executionCalls: 0 }
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
      log('STATE_LOAD_FALLBACK', { error: sanitizeText(error.message || error, 400) }, 'warn');
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
    log('STATE_SAVE_FAILED', { error: sanitizeText(error.message || error, 400) }, 'warn');
  }
}

function normalizeEvidence(input = {}) {
  const source = String(input.source || '').trim().toUpperCase();
  const sourceDef = sourceDefinition(source);
  if (!sourceDef) throw new Error(`SHADOW_RESEARCH_SOURCE_NOT_ALLOWED:${source || 'EMPTY'}`);

  const symbol = String(input.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(symbol)) throw new Error('SHADOW_RESEARCH_SYMBOL_INVALID');

  const kind = String(input.kind || '').trim().toUpperCase();
  if (!ALLOWED_KINDS.has(kind)) throw new Error(`SHADOW_RESEARCH_KIND_INVALID:${kind || 'EMPTY'}`);
  if (Array.isArray(sourceDef.acceptedKinds) && !sourceDef.acceptedKinds.includes(kind)) {
    throw new Error(`SHADOW_RESEARCH_KIND_NOT_ALLOWED_FOR_SOURCE:${source}:${kind}`);
  }

  const score = clamp(input.score, 0, -1, 1);
  const confidence = clamp(input.confidence, 0.5, 0, 1);
  const observedAt = validDate(input.observedAt) || iso();
  const ttlHours = clamp(input.ttlHours, DEFAULT_TTL_HOURS[kind] || 168, 1, 24 * 365);
  let expiresAt = validDate(input.expiresAt);
  if (!expiresAt || Date.parse(expiresAt) <= Date.parse(observedAt)) {
    expiresAt = new Date(Date.parse(observedAt) + ttlHours * 3600_000).toISOString();
  }
  const title = sanitizeText(input.title, 180) || `${source} ${kind}`;
  const summary = sanitizeText(input.summary, 900);
  const reference = safeReference(input.reference || input.url);
  const rawFingerprint = JSON.stringify({ source, symbol, kind, score: round(score, 4), confidence: round(confidence, 4), observedAt, title, summary, reference });

  return {
    id: `ev-${hash(rawFingerprint)}`,
    source,
    sourceRole: sourceDef.role || null,
    sourceReliability: sourceReliability(source),
    symbol,
    kind,
    score: round(score, 4),
    confidence: round(confidence, 4),
    observedAt,
    expiresAt,
    title,
    summary,
    reference,
    evidenceHash: hash(rawFingerprint),
    researchOnly: true,
    canAuthorizeLive: false
  };
}

function pruneEvidence() {
  const now = Date.now();
  const before = state.evidence.length;
  const bySymbol = new Map();
  for (const ev of state.evidence) {
    if (!ev || !ev.symbol || !Number.isFinite(Date.parse(ev.expiresAt))) continue;
    // Keep expired evidence for audit for up to 30 days, but never score it.
    if (Date.parse(ev.expiresAt) < now - 30 * 24 * 3600_000) continue;
    if (!bySymbol.has(ev.symbol)) bySymbol.set(ev.symbol, []);
    bySymbol.get(ev.symbol).push(ev);
  }
  const trimmed = [];
  for (const items of bySymbol.values()) {
    items.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    trimmed.push(...items.slice(-MAX_PER_SYMBOL));
  }
  trimmed.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  state.evidence = trimmed.slice(-MAX_EVIDENCE);
  state.stats.pruned += Math.max(0, before - state.evidence.length);
}

async function ingestEvidence(input) {
  await loadState();
  if (!ENABLED) return { ok: false, reason: 'DISABLED' };
  let ev;
  try {
    ev = normalizeEvidence(input);
  } catch (error) {
    state.stats.rejected += 1;
    await saveState();
    throw error;
  }
  if (state.evidence.some((item) => item.id === ev.id || item.evidenceHash === ev.evidenceHash)) {
    state.stats.duplicates += 1;
    await saveState();
    return { ok: true, duplicate: true, evidence: ev };
  }
  state.evidence.push(ev);
  state.stats.ingested += 1;
  pruneEvidence();
  await saveState();
  log('EVIDENCE_INGESTED', { id: ev.id, source: ev.source, symbol: ev.symbol, kind: ev.kind, score: ev.score, confidence: ev.confidence });
  return { ok: true, duplicate: false, evidence: ev };
}

async function ingestBulk(inputs) {
  const results = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    try { results.push(await ingestEvidence(input)); }
    catch (error) { results.push({ ok: false, error: sanitizeText(error.message || error, 300) }); }
  }
  return results;
}

function scoreEvidenceForSymbol(symbol, evidence, nowMs = Date.now()) {
  const valid = (Array.isArray(evidence) ? evidence : []).filter((ev) =>
    ev?.symbol === symbol && Number.isFinite(Date.parse(ev.expiresAt)) && Date.parse(ev.expiresAt) > nowMs
  );
  let positive = 0;
  let negative = 0;
  let signed = 0;
  let totalWeight = 0;
  let confidenceWeighted = 0;
  const sources = new Set();
  const kinds = new Set();

  for (const ev of valid) {
    const ageMs = Math.max(0, nowMs - Date.parse(ev.observedAt));
    const lifeMs = Math.max(1, Date.parse(ev.expiresAt) - Date.parse(ev.observedAt));
    const freshness = Math.max(0.2, 1 - 0.8 * Math.min(1, ageMs / lifeMs));
    const reliability = clamp(ev.sourceReliability, sourceReliability(ev.source), 0, 1);
    const confidence = clamp(ev.confidence, 0.5, 0, 1);
    const weight = Math.max(0.01, reliability * confidence * freshness);
    const contribution = clamp(ev.score, 0, -1, 1) * weight;
    signed += contribution;
    totalWeight += weight;
    confidenceWeighted += confidence * reliability;
    if (contribution > 0) positive += contribution;
    else negative += Math.abs(contribution);
    sources.add(ev.source);
    kinds.add(ev.kind);
  }

  const raw = totalWeight ? signed / totalWeight : 0;
  const conflict = Math.min(positive, negative) / Math.max(0.0001, Math.max(positive, negative));
  const conflictPenalty = Math.min(15, conflict * 15);
  const score = clamp(50 + raw * 50 - conflictPenalty, 50, 0, 100);
  const confidence = valid.length ? clamp(confidenceWeighted / valid.length, 0, 0, 1) : 0;

  return {
    symbol,
    researchScore: round(score, 2),
    netEvidence: round(raw, 4),
    confidence: round(confidence, 4),
    independentSources: sources.size,
    sources: [...sources].sort(),
    kinds: [...kinds].sort(),
    activeEvidence: valid.length,
    conflictRatio: round(conflict, 4),
    promotionEligible: sources.size >= Number(sourceManifest?.promotionRules?.minimumIndependentSources || 2) &&
      score >= Number(sourceManifest?.promotionRules?.minimumResearchScore || 70) &&
      confidence >= Number(sourceManifest?.promotionRules?.minimumConfidence || 0.65)
  };
}

function allSymbolScores() {
  const symbols = [...new Set(state.evidence.map((ev) => ev.symbol).filter(Boolean))];
  return symbols.map((symbol) => scoreEvidenceForSymbol(symbol, state.evidence))
    .sort((a, b) => b.researchScore - a.researchScore || b.independentSources - a.independentSources || a.symbol.localeCompare(b.symbol));
}

async function stateSnapshot() {
  await loadState();
  pruneEvidence();
  return {
    version: VERSION,
    enabled: ENABLED,
    persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
    evidenceCount: state.evidence.length,
    symbolScores: allSymbolScores(),
    stats: { ...state.stats, openAiCalls: 0, openAiCostUsd: 0, executionCalls: 0 },
    sourceManifest,
    lastEvent,
    safety: {
      researchOnly: true,
      canTrade: false,
      canAuthorizeLive: false,
      automaticLivePromotion: false,
      automaticShadowUniverseMutation: false,
      openAiEnabled: false,
      openAiCostUsd: 0
    }
  };
}

global.__LEO_SHADOW_RESEARCH_INGEST__ = ingestEvidence;
global.__LEO_SHADOW_RESEARCH_BULK_INGEST__ = ingestBulk;
global.__LEO_SHADOW_RESEARCH_STATE__ = stateSnapshot;

log('STARTED', {
  enabled: ENABLED,
  sources: Object.keys(sourceManifest?.sources || {}),
  persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
  openAiCalls: 0,
  openAiCostUsd: 0,
  executionCalls: 0,
  automaticLivePromotion: false,
  automaticShadowUniverseMutation: false
});

module.exports = {
  VERSION,
  normalizeEvidence,
  scoreEvidenceForSymbol,
  ingestEvidence,
  ingestBulk,
  stateSnapshot,
  sourceReliability
};
