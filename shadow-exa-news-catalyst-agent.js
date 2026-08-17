'use strict';

/**
 * LEO-AI SENTINEL v10.23.4 — Exa News & Catalyst Agent
 *
 * Shadow/research only. This module contains no Exa network client and no
 * trading surface. It accepts normalized search/fetch observations from a
 * trusted research adapter, deduplicates/corroborates events, penalizes rumor,
 * stale/conflicting/injection-prone evidence, and emits auditable EXA research
 * evidence without ever authorizing LIVE execution.
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const VERSION = 'v10.23.4-exa-news-catalyst-agent';
const PREFIX = '[LEO_EXA_CATALYST]';
const ENABLED = process.env.SHADOW_EXA_CATALYST_ENABLED !== 'false';
const MAX_AUDIT = Math.round(clamp(process.env.SHADOW_EXA_MAX_AUDIT, 400, 50, 5000));
const DEFAULT_MAX_AGE_HOURS = clamp(process.env.SHADOW_EXA_MAX_AGE_HOURS, 96, 6, 24 * 30);
const FUTURE_TOLERANCE_MINUTES = clamp(process.env.SHADOW_EXA_FUTURE_TOLERANCE_MINUTES, 10, 0, 120);
const MIN_CONFIRMING_SOURCE_GROUPS = Math.round(clamp(process.env.SHADOW_EXA_MIN_CONFIRMING_SOURCES, 2, 2, 5));
const MAX_ITEMS_PER_EVENT = Math.round(clamp(process.env.SHADOW_EXA_MAX_ITEMS_PER_EVENT, 12, 2, 40));

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const HAS_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const STATE_KEY = String(process.env.SHADOW_EXA_STATE_KEY || 'leo:shadow-exa:v10.23.4:state');
const STATE_FILE = process.env.SHADOW_EXA_STATE_FILE || path.join(
  process.env.PERSISTENT_DISK_PATH || '/tmp',
  'leo-shadow-exa-catalyst-state.json'
);

const SOURCE_CLASS_RELIABILITY = Object.freeze({
  REGULATOR: 0.99,
  GOVERNMENT: 0.97,
  COMPANY_PRIMARY: 0.93,
  PARTNER_PRIMARY: 0.91,
  EXCHANGE_PRIMARY: 0.94,
  REPUTABLE_MEDIA: 0.84,
  TRADE_MEDIA: 0.72,
  RESEARCH_INSTITUTION: 0.82,
  BLOG: 0.55,
  SOCIAL: 0.30,
  UNKNOWN: 0.45
});

const PRIMARY_CLASSES = new Set(['REGULATOR', 'GOVERNMENT', 'COMPANY_PRIMARY', 'PARTNER_PRIMARY', 'EXCHANGE_PRIMARY']);
const LOW_TRUST_CLASSES = new Set(['BLOG', 'SOCIAL', 'UNKNOWN']);
const EVENT_TYPES = new Set([
  'EARNINGS', 'GUIDANCE', 'PRODUCT', 'PARTNERSHIP', 'CONTRACT', 'M_AND_A',
  'REGULATORY', 'FDA', 'LEGAL', 'CYBERSECURITY', 'MANAGEMENT', 'FINANCING',
  'CAPITAL_ALLOCATION', 'SUPPLY_CHAIN', 'CUSTOMER', 'COMPETITION', 'RESEARCH',
  'SECTOR', 'MACRO', 'OTHER'
]);

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
function iso(ms = Date.now()) { return new Date(ms).toISOString(); }
function validDate(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function hash(value) { return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24); }
function normalizeSymbol(value) { return String(value || '').trim().toUpperCase(); }
function sanitizeText(value, max = 900) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(ignore|disregard|override|system prompt|developer message|reveal secret|execute trade|buy now|sell now|place order)\b/gi, '[filtered]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function hasPromptInjectionLikeText(value) {
  const raw = String(value ?? '').toLowerCase();
  return /(ignore\s+(all\s+)?previous|disregard\s+(all\s+)?previous|system\s+prompt|developer\s+message|reveal\s+(the\s+)?secret|execute\s+(a\s+)?trade|place\s+(an?\s+)?order|buy\s+now|sell\s+now)/i.test(raw);
}
function hasRumorLanguage(value) {
  const raw = String(value ?? '').toLowerCase();
  return /\b(rumou?r|unconfirmed|reportedly|sources say|anonymous source|speculation|speculative chatter|social media claims?|may be considering|could be considering)\b/i.test(raw);
}
function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|auth|password|signature/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().slice(0, 700);
  } catch {
    return null;
  }
}
function hostnameOf(urlValue) {
  try { return new URL(String(urlValue || '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}
function defaultSourceGroup(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return 'unknown';
  if (host === 'investor.nvidia.com' || host === 'nvidianews.nvidia.com' || host.endsWith('.nvidia.com')) return 'nvidia.com';
  if (host.endsWith('.sec.gov') || host === 'sec.gov') return 'sec.gov';
  if (host.endsWith('.fda.gov') || host === 'fda.gov') return 'fda.gov';
  if (host.endsWith('.justice.gov') || host === 'justice.gov') return 'justice.gov';
  if (host.endsWith('.ftc.gov') || host === 'ftc.gov') return 'ftc.gov';
  const parts = host.split('.').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}
function normalizeKeyText(value) {
  return sanitizeText(value, 500)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|and|or|of|to|for|with|on|in|at|by|from|is|are|announces?|announced|says?|said)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function derivedEventKey(symbol, eventType, title) {
  const tokens = normalizeKeyText(title).split(' ').filter((token) => token.length >= 3).slice(0, 12).sort();
  return `${normalizeSymbol(symbol)}:${eventType}:${tokens.join('-')}`.slice(0, 300);
}
function log(event, details = {}, level = 'log') {
  const payload = { component: 'LEO_EXA_CATALYST', version: VERSION, event, at: iso(), ...details };
  lastEvent = payload;
  global.__LEO_EXA_CATALYST_LAST_EVENT__ = payload;
  (console[level] || console.log)(`${PREFIX} ${JSON.stringify(payload)}`);
}

function freshState() {
  return {
    version: VERSION,
    createdAt: iso(),
    updatedAt: iso(),
    audit: [],
    stats: {
      batches: 0,
      events: 0,
      confirmed: 0,
      primarySource: 0,
      possible: 0,
      rumorRisk: 0,
      conflicting: 0,
      stale: 0,
      inconclusive: 0,
      rejectedInjection: 0,
      duplicatesRemoved: 0,
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

function normalizeObservation(input = {}) {
  const symbol = normalizeSymbol(input.symbol || input.ticker);
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(symbol)) return null;
  const titleRaw = String(input.title || '');
  const summaryRaw = String(input.summary || input.highlights || input.content || '');
  const url = safeUrl(input.url || input.reference);
  const hostname = hostnameOf(url);
  const sourceClass = String(input.sourceClass || 'UNKNOWN').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(SOURCE_CLASS_RELIABILITY, sourceClass)) return null;
  const eventType = String(input.eventType || 'OTHER').toUpperCase();
  if (!EVENT_TYPES.has(eventType)) return null;
  const publishedAt = validDate(input.publishedAt || input.observedAt || input.date);
  const direction = clamp(input.directionScore, 0, -1, 1);
  const confidence = clamp(input.confidence, 0.5, 0, 1);
  const injectionSuspected = Boolean(input.injectionSuspected) || hasPromptInjectionLikeText(`${titleRaw} ${summaryRaw}`);
  const rumorLanguage = Boolean(input.rumorLanguage) || hasRumorLanguage(`${titleRaw} ${summaryRaw}`);
  const sourceGroup = sanitizeText(input.sourceGroup, 120).toLowerCase() || defaultSourceGroup(hostname);
  const eventKey = sanitizeText(input.eventKey, 280) || derivedEventKey(symbol, eventType, titleRaw);
  return {
    id: `exa-observation-${hash(JSON.stringify({ symbol, url, titleRaw, publishedAt, eventType }))}`,
    symbol,
    title: sanitizeText(titleRaw, 260),
    summary: sanitizeText(summaryRaw, 1000),
    url,
    hostname,
    sourceClass,
    sourceReliability: SOURCE_CLASS_RELIABILITY[sourceClass],
    sourceGroup,
    eventType,
    eventKey,
    publishedAt,
    directionScore: round(direction, 4),
    confidence: round(confidence, 4),
    impact: String(input.impact || 'MEDIUM').toUpperCase(),
    injectionSuspected,
    rumorLanguage,
    anonymousSource: Boolean(input.anonymousSource),
    researchOnly: true,
    canAuthorizeLive: false
  };
}

function observationAgeHours(obs, nowMs) {
  if (!obs?.publishedAt) return null;
  return (nowMs - Date.parse(obs.publishedAt)) / 3600000;
}
function observationUsability(obs, nowMs, maxAgeHours) {
  if (!obs) return { usable: false, reason: 'INVALID' };
  if (obs.injectionSuspected) return { usable: false, reason: 'PROMPT_INJECTION_SUSPECTED' };
  const ageHours = observationAgeHours(obs, nowMs);
  if (!Number.isFinite(ageHours)) return { usable: false, reason: 'TIMESTAMP_MISSING' };
  if (ageHours < -FUTURE_TOLERANCE_MINUTES / 60) return { usable: false, reason: 'TIMESTAMP_FROM_FUTURE' };
  if (ageHours > maxAgeHours) return { usable: false, reason: 'STALE' };
  return { usable: true, reason: 'USABLE', ageHours: Math.max(0, ageHours) };
}
function dedupeObservations(items) {
  const seenExact = new Set();
  const bySourceEvent = new Map();
  let removed = 0;
  for (const obs of items) {
    if (!obs) continue;
    const exactKey = `${obs.url || ''}:${normalizeKeyText(obs.title)}:${obs.publishedAt || ''}`;
    if (seenExact.has(exactKey)) {
      removed += 1;
      continue;
    }
    seenExact.add(exactKey);
    const key = `${obs.eventKey}:${obs.sourceGroup}`;
    const existing = bySourceEvent.get(key);
    if (!existing) {
      bySourceEvent.set(key, obs);
      continue;
    }
    removed += 1;
    const currentWeight = obs.sourceReliability * obs.confidence;
    const existingWeight = existing.sourceReliability * existing.confidence;
    if (currentWeight > existingWeight || (currentWeight === existingWeight && Date.parse(obs.publishedAt || 0) > Date.parse(existing.publishedAt || 0))) {
      bySourceEvent.set(key, obs);
    }
  }
  return { observations: [...bySourceEvent.values()], removed };
}

function analyzeEventGroup(observations, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const maxAgeHours = clamp(options.maxAgeHours, DEFAULT_MAX_AGE_HOURS, 1, 24 * 90);
  const normalized = (Array.isArray(observations) ? observations : []).map(normalizeObservation).filter(Boolean);
  if (!normalized.length) {
    return { status: 'INCONCLUSIVE', reason: 'NO_VALID_OBSERVATIONS', canTrade: false, canAuthorizeLive: false, researchOnly: true };
  }

  const deduped = dedupeObservations(normalized);
  const eventKeys = new Set(deduped.observations.map((obs) => obs.eventKey));
  if (eventKeys.size !== 1) {
    return {
      status: 'INCONCLUSIVE', reason: 'MULTIPLE_EVENT_KEYS', symbol: normalized[0].symbol,
      observations: deduped.observations, duplicatesRemoved: deduped.removed,
      canTrade: false, canAuthorizeLive: false, researchOnly: true
    };
  }
  const symbols = new Set(deduped.observations.map((obs) => obs.symbol));
  if (symbols.size !== 1) {
    return {
      status: 'INCONCLUSIVE', reason: 'SYMBOL_MISMATCH', observations: deduped.observations,
      duplicatesRemoved: deduped.removed, canTrade: false, canAuthorizeLive: false, researchOnly: true
    };
  }

  const inspected = deduped.observations.slice(0, MAX_ITEMS_PER_EVENT).map((obs) => ({
    obs,
    usability: observationUsability(obs, nowMs, maxAgeHours)
  }));
  const rejectedInjection = inspected.filter((item) => item.usability.reason === 'PROMPT_INJECTION_SUSPECTED').length;
  const staleCount = inspected.filter((item) => ['STALE', 'TIMESTAMP_FROM_FUTURE', 'TIMESTAMP_MISSING'].includes(item.usability.reason)).length;
  const usable = inspected.filter((item) => item.usability.usable).map((item) => item.obs);

  if (!usable.length) {
    return {
      id: `exa-event-${hash([...eventKeys][0])}`,
      evaluatedAt: iso(nowMs),
      status: staleCount > 0 && rejectedInjection === 0 ? 'STALE' : 'INCONCLUSIVE',
      reason: rejectedInjection > 0 ? 'ALL_USABLE_EVIDENCE_REJECTED_OR_INJECTION' : 'NO_FRESH_EVIDENCE',
      symbol: normalized[0].symbol,
      eventKey: [...eventKeys][0],
      eventType: normalized[0].eventType,
      observations: deduped.observations,
      duplicatesRemoved: deduped.removed,
      rejectedInjection,
      staleCount,
      canTrade: false,
      canAuthorizeLive: false,
      researchOnly: true
    };
  }

  const sourceGroups = new Set(usable.map((obs) => obs.sourceGroup));
  const primaryGroups = new Set(usable.filter((obs) => PRIMARY_CLASSES.has(obs.sourceClass)).map((obs) => obs.sourceGroup));
  let positiveWeight = 0;
  let negativeWeight = 0;
  let signed = 0;
  let totalWeight = 0;
  let rumorWeighted = 0;
  let lowTrustWeight = 0;
  let bestPublishedAt = null;

  for (const obs of usable) {
    const ageHours = Math.max(0, observationAgeHours(obs, nowMs) || 0);
    const freshness = Math.max(0.35, 1 - 0.65 * Math.min(1, ageHours / maxAgeHours));
    const trust = obs.sourceReliability;
    const anonymousPenalty = obs.anonymousSource ? 0.55 : 1;
    const rumorPenalty = obs.rumorLanguage ? 0.55 : 1;
    const weight = Math.max(0.01, trust * obs.confidence * freshness * anonymousPenalty * rumorPenalty);
    const contribution = obs.directionScore * weight;
    signed += contribution;
    totalWeight += weight;
    if (contribution > 0) positiveWeight += contribution;
    else negativeWeight += Math.abs(contribution);
    if (obs.rumorLanguage || obs.anonymousSource) rumorWeighted += weight;
    if (LOW_TRUST_CLASSES.has(obs.sourceClass)) lowTrustWeight += weight;
    if (!bestPublishedAt || Date.parse(obs.publishedAt) > Date.parse(bestPublishedAt)) bestPublishedAt = obs.publishedAt;
  }

  const netDirection = totalWeight ? signed / totalWeight : 0;
  const conflictRatio = Math.min(positiveWeight, negativeWeight) / Math.max(0.0001, Math.max(positiveWeight, negativeWeight));
  const rumorRatio = totalWeight ? rumorWeighted / totalWeight : 0;
  const lowTrustRatio = totalWeight ? lowTrustWeight / totalWeight : 0;
  const strongestPrimary = usable.some((obs) => PRIMARY_CLASSES.has(obs.sourceClass) && obs.sourceReliability >= 0.9);
  const corroborated = sourceGroups.size >= Math.round(clamp(options.minConfirmingSources, MIN_CONFIRMING_SOURCE_GROUPS, 2, 5));

  let status = 'POSSIBLE_CATALYST';
  let reason = 'LIMITED_CORROBORATION';
  if (conflictRatio >= 0.45 && positiveWeight > 0.05 && negativeWeight > 0.05) {
    status = 'CONFLICTING';
    reason = 'MATERIAL_SOURCE_CONFLICT';
  } else if (rumorRatio >= 0.5 || (sourceGroups.size === 1 && lowTrustRatio >= 0.7) || usable.every((obs) => obs.rumorLanguage || obs.anonymousSource)) {
    status = 'RUMOR_RISK';
    reason = 'RUMOR_OR_LOW_TRUST_DOMINATES';
  } else if (corroborated && Math.abs(netDirection) >= 0.2 && (strongestPrimary || lowTrustRatio < 0.35)) {
    status = 'CONFIRMED_CATALYST';
    reason = 'INDEPENDENT_CORROBORATION';
  } else if (strongestPrimary && Math.abs(netDirection) >= 0.15) {
    status = 'PRIMARY_SOURCE_CATALYST';
    reason = 'AUTHORITATIVE_PRIMARY_SOURCE_ONLY';
  }

  const sourceQuality = clamp(
    (usable.reduce((sum, obs) => sum + obs.sourceReliability * obs.confidence, 0) / usable.length) *
      (1 - Math.min(0.6, conflictRatio * 0.6)) *
      (1 - Math.min(0.45, rumorRatio * 0.45)),
    0, 0, 1
  );
  const confidence = round(sourceQuality, 4);

  return {
    id: `exa-event-${hash([...eventKeys][0])}`,
    evaluatedAt: iso(nowMs),
    status,
    reason,
    symbol: usable[0].symbol,
    eventKey: usable[0].eventKey,
    eventType: usable[0].eventType,
    directionScore: round(netDirection, 4),
    confidence,
    independentSourceGroups: sourceGroups.size,
    primarySourceGroups: primaryGroups.size,
    sourceGroups: [...sourceGroups].sort(),
    conflictRatio: round(conflictRatio, 4),
    rumorRatio: round(rumorRatio, 4),
    lowTrustRatio: round(lowTrustRatio, 4),
    latestPublishedAt: bestPublishedAt,
    observations: usable,
    duplicatesRemoved: deduped.removed,
    rejectedInjection,
    staleCount,
    canTrade: false,
    canAuthorizeLive: false,
    researchOnly: true
  };
}

function groupBatchObservations(inputs) {
  const normalized = (Array.isArray(inputs) ? inputs : []).map(normalizeObservation).filter(Boolean);
  const groups = new Map();
  for (const obs of normalized) {
    if (!groups.has(obs.eventKey)) groups.set(obs.eventKey, []);
    groups.get(obs.eventKey).push(obs);
  }
  return [...groups.values()];
}

function analyzeBatch(inputs, options = {}) {
  return groupBatchObservations(inputs)
    .map((group) => analyzeEventGroup(group, options))
    .sort((a, b) => {
      const statusRank = {
        CONFIRMED_CATALYST: 6,
        PRIMARY_SOURCE_CATALYST: 5,
        CONFLICTING: 4,
        RUMOR_RISK: 3,
        POSSIBLE_CATALYST: 2,
        STALE: 1,
        INCONCLUSIVE: 0
      };
      return (statusRank[b.status] || 0) - (statusRank[a.status] || 0) || Number(b.confidence || 0) - Number(a.confidence || 0);
    });
}

function evidenceFromEventReport(report) {
  if (!report || !report.symbol || ['STALE', 'INCONCLUSIVE'].includes(report.status)) return [];
  const observedAt = report.latestPublishedAt || report.evaluatedAt || iso();
  const reference = report.observations?.find((obs) => obs.url)?.url || `urn:exa:event:${hash(report.eventKey || report.id)}`;
  const confidence = clamp(report.confidence, 0.5, 0, 1);
  const evidence = [];

  if (report.status === 'RUMOR_RISK') {
    evidence.push({
      source: 'EXA', symbol: report.symbol, kind: 'RISK', score: -0.55, confidence: Math.min(0.75, confidence),
      observedAt, ttlHours: 48, title: `Unconfirmed/rumor risk around ${report.symbol}`,
      summary: `Event ${report.eventType}; rumor/low-trust evidence dominates. No catalyst confirmation.`, reference
    });
    return evidence;
  }

  if (report.status === 'CONFLICTING') {
    evidence.push({
      source: 'EXA', symbol: report.symbol, kind: 'RISK', score: -0.45, confidence: Math.min(0.8, confidence),
      observedAt, ttlHours: 48, title: `Conflicting sources around ${report.symbol}`,
      summary: `Material source disagreement for ${report.eventType}; conflict ratio ${report.conflictRatio}.`, reference
    });
    evidence.push({
      source: 'EXA', symbol: report.symbol, kind: 'NEWS', score: 0, confidence: Math.min(0.65, confidence),
      observedAt, ttlHours: 48, title: `Unresolved news event ${report.symbol}`,
      summary: `Directional interpretation withheld because sources materially conflict.`, reference
    });
    return evidence;
  }

  const directionalScore = clamp(report.directionScore, 0, -1, 1);
  evidence.push({
    source: 'EXA', symbol: report.symbol, kind: 'NEWS', score: round(directionalScore * 0.7, 4), confidence,
    observedAt, ttlHours: 72, title: `News event ${report.symbol}: ${report.eventType}`,
    summary: `${report.status}; ${report.independentSourceGroups || 0} independent source group(s); direction ${round(directionalScore, 3)}.`, reference
  });

  if (['CONFIRMED_CATALYST', 'PRIMARY_SOURCE_CATALYST'].includes(report.status)) {
    const catalystMultiplier = report.status === 'CONFIRMED_CATALYST' ? 0.95 : 0.65;
    evidence.push({
      source: 'EXA', symbol: report.symbol, kind: directionalScore < 0 ? 'RISK' : 'CATALYST',
      score: round(directionalScore * catalystMultiplier, 4),
      confidence: report.status === 'CONFIRMED_CATALYST' ? confidence : Math.min(0.78, confidence),
      observedAt, ttlHours: 168,
      title: `${report.status === 'CONFIRMED_CATALYST' ? 'Corroborated' : 'Primary-source'} ${report.eventType} ${report.symbol}`,
      summary: `${report.reason}; source groups: ${(report.sourceGroups || []).join(', ')}.`, reference
    });
  }

  return evidence;
}

async function ingestBatch(inputs, options = {}) {
  await loadState();
  if (!ENABLED) return { ok: false, reason: 'DISABLED' };
  const reports = analyzeBatch(inputs, options);
  state.stats.batches += 1;
  state.stats.events += reports.length;
  let allEvidence = [];
  for (const report of reports) {
    const map = {
      CONFIRMED_CATALYST: 'confirmed', PRIMARY_SOURCE_CATALYST: 'primarySource', POSSIBLE_CATALYST: 'possible',
      RUMOR_RISK: 'rumorRisk', CONFLICTING: 'conflicting', STALE: 'stale', INCONCLUSIVE: 'inconclusive'
    };
    const bucket = map[report.status] || 'inconclusive';
    state.stats[bucket] += 1;
    state.stats.rejectedInjection += Number(report.rejectedInjection || 0);
    state.stats.duplicatesRemoved += Number(report.duplicatesRemoved || 0);
    allEvidence.push(...evidenceFromEventReport(report));
    state.audit.push({
      id: report.id || `exa-${hash(JSON.stringify(report))}`,
      evaluatedAt: report.evaluatedAt || iso(),
      symbol: report.symbol || null,
      eventType: report.eventType || null,
      eventKey: report.eventKey || null,
      status: report.status,
      directionScore: report.directionScore ?? null,
      confidence: report.confidence ?? null,
      independentSourceGroups: report.independentSourceGroups ?? 0,
      sourceGroups: report.sourceGroups || [],
      conflictRatio: report.conflictRatio ?? null,
      rumorRatio: report.rumorRatio ?? null,
      rejectedInjection: report.rejectedInjection ?? 0,
      duplicatesRemoved: report.duplicatesRemoved ?? 0
    });
  }
  state.audit = state.audit.slice(-MAX_AUDIT);

  let evidenceResults = [];
  const researchIngest = global.__LEO_SHADOW_RESEARCH_BULK_INGEST__;
  if (allEvidence.length && typeof researchIngest === 'function') {
    evidenceResults = await researchIngest(allEvidence);
    for (const result of evidenceResults) {
      if (result?.ok) state.stats.evidenceIngested += 1;
      else state.stats.evidenceRejected += 1;
    }
  }
  await saveState();
  log('BATCH_ANALYZED', {
    events: reports.length,
    statuses: reports.map((report) => ({ symbol: report.symbol || null, eventType: report.eventType || null, status: report.status })),
    evidenceAccepted: evidenceResults.filter((item) => item?.ok).length,
    rejectedInjection: reports.reduce((sum, report) => sum + Number(report.rejectedInjection || 0), 0),
    networkCalls: 0,
    executionCalls: 0,
    openAiCalls: 0
  });
  return { ok: true, reports, evidence: allEvidence, evidenceResults };
}

async function stateSnapshot() {
  await loadState();
  return {
    version: VERSION,
    enabled: ENABLED,
    persistentBackend: HAS_UPSTASH ? 'upstash-redis' : 'local-file',
    stats: { ...state.stats, networkCalls: 0, executionCalls: 0, openAiCalls: 0, openAiCostUsd: 0 },
    recentAudit: state.audit.slice(-40),
    lastEvent,
    settings: {
      maxAgeHours: DEFAULT_MAX_AGE_HOURS,
      futureToleranceMinutes: FUTURE_TOLERANCE_MINUTES,
      minConfirmingSourceGroups: MIN_CONFIRMING_SOURCE_GROUPS
    },
    safety: {
      researchOnly: true,
      canTrade: false,
      canAuthorizeLive: false,
      networkClientPresent: false,
      executionFunctionsPresent: false,
      automaticLivePromotion: false,
      automaticShadowUniverseMutation: false,
      rawExternalInstructionsExecuted: false,
      openAiEnabled: false,
      openAiCostUsd: 0
    }
  };
}

global.__LEO_EXA_CATALYST_INGEST__ = ingestBatch;
global.__LEO_EXA_CATALYST_STATE__ = stateSnapshot;

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
  normalizeObservation,
  dedupeObservations,
  analyzeEventGroup,
  analyzeBatch,
  evidenceFromEventReport,
  ingestBatch,
  stateSnapshot,
  sanitizeText,
  hasPromptInjectionLikeText,
  hasRumorLanguage,
  defaultSourceGroup
};
