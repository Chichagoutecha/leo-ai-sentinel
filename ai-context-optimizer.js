'use strict';

/**
 * LEO-AI SENTINEL v10.22.11.1 — adaptive decision-context optimizer for GPT-5.6 Luna.
 *
 * Loaded AFTER ai-cost-optimizer.js and ai-luna-temperature-compat.js.
 * It only compacts LEO decision payloads before the provider call. Safety-critical
 * current facts are preserved. If preservation cannot be proven, the original
 * payload is sent unchanged.
 */
const crypto = require('crypto');
const CurrentOpenAI = require('openai');
const openAIPath = require.resolve('openai');
const VERSION = 'v10.22.11.1-ai-context-adaptive';
const ENABLED = process.env.AI_CONTEXT_OPTIMIZER_ENABLED !== 'false';
const MAX_INPUT_CHARS = clampInt(process.env.AI_CONTEXT_MAX_INPUT_CHARS, 120000, 40000, 500000);
const MAX_STRING_CHARS = clampInt(process.env.AI_CONTEXT_MAX_STRING_CHARS, 900, 200, 5000);
const MAX_GENERIC_ARRAY = clampInt(process.env.AI_CONTEXT_MAX_GENERIC_ARRAY, 16, 4, 64);
const MAX_CRITICAL_ARRAY = clampInt(process.env.AI_CONTEXT_MAX_CRITICAL_ARRAY, 64, 16, 160);
const DEDUPE_MIN_CHARS = clampInt(process.env.AI_CONTEXT_DEDUPE_MIN_CHARS, 1800, 512, 20000);
const OPAQUE_BULK_MIN_CHARS = clampInt(process.env.AI_CONTEXT_OPAQUE_BULK_MIN_CHARS, 3500, 1000, 50000);

// Only keys whose semantics are clearly historical/reconstructible belong here.
const NOISY_EXACT = new Set([
  'history','histories','scanhistory','watchhistory','executionverificationhistory',
  'performancehistory','equityhistory','agentcouncilhistory','macrocreditregimehistory',
  'researchevents','pointintimearchive','audittrail','logs','trendmemory',
  'scientifictrials','runs','leaderboard','candles','bars','pricehistory',
  'historicaldata','pointintimeindex'
]);
const CRITICAL_ARRAY_RE = /(position|order|reason|veto|approved|block|risk|health|execution|candidate|council|divergence|provider)/i;
const IMPORTANT_VALUE_RE = /(VETO|BLOCK|BREAKER|ERROR|FAIL|UNSAFE|STALE|CLOSED|REJECT|INCONCLUSIVE|RISK|AI_FAILURES|ORDER_NO_EFFECT|SELL|BUY)/i;
const SAFETY_KEY_RE = /^(action|status|reason|approved|approval|hardVeto|veto|blocked|blockReason|circuitBreakerOpen|newBuyBlocked|tradable|stale|fresh|confidence|canTrade|canAuthorizeLive|livePromotionAllowed|portfolioIdentityConfirmed|identityConfirmed)$/i;
const IDENTITY_KEY_RE = /^(asset|symbol|ticker|instrument|instrumentId|provider|source|name|endpoint|time|timestamp|fetchedAt|updatedAt)$/i;
const DECISION_SCALAR_RE = /^(price|bid|ask|last|open|high|low|close|score|technicalScore|researchScore|confidence|weight|weightPct|amount|amountUsd|cash|availableCash|value|totalTrackedValue|ageSeconds|freshnessSeconds)$/i;
const OPAQUE_BULK_KEY_RE = /^(raw|rawData|rawPayload|rawResponse|payload|providerPayload|providerResponse|responseBody|responseData|adapterPayload)$/i;

let lastEvent = null;
const stats = {
  optimized: 0, passthrough: 0, safetyFallbacks: 0,
  adaptiveCompactions: 0, dedupeReferences: 0, opaqueBulkCompactions: 0,
  charsBefore: 0, charsAfter: 0
};

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function round(n, p = 2) { const m = 10 ** p; return Math.round(Number(n || 0) * m) / m; }
function safeJson(value) { try { return JSON.stringify(value); } catch { return ''; } }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function normalizedKey(key) { return String(key || '').replace(/[_\-\s]/g, '').toLowerCase(); }
function noisyKey(key) {
  const k = normalizedKey(key);
  return NOISY_EXACT.has(k) || /history$/.test(k) || /archive$/.test(k);
}
function opaqueBulkKey(key) {
  return OPAQUE_BULK_KEY_RE.test(String(key || '').replace(/[_\-\s]/g, ''));
}
function objectSymbol(obj, inherited = '') {
  if (!isObject(obj)) return inherited;
  return String(obj.asset || obj.symbol || obj.ticker || obj.instrument || inherited || '').trim().toUpperCase().slice(0, 32);
}
function scalar(value) { return value === null || ['string','number','boolean'].includes(typeof value); }
function sanitizeString(value, key) {
  const s = String(value);
  if (SAFETY_KEY_RE.test(String(key || ''))) return s.slice(0, 1800);
  return s.length > MAX_STRING_CHARS ? `${s.slice(0, MAX_STRING_CHARS)}…[truncated ${s.length - MAX_STRING_CHARS} chars]` : s;
}
function itemImportance(item) {
  if (!isObject(item)) return IMPORTANT_VALUE_RE.test(String(item)) ? 100 : 0;
  let score = 0;
  for (const [k, v] of Object.entries(item)) {
    if (SAFETY_KEY_RE.test(k) && IMPORTANT_VALUE_RE.test(String(v))) score += 100;
    if (/^(hardVeto|veto|blocked|circuitBreakerOpen|newBuyBlocked)$/i.test(k) && Boolean(v)) score += 120;
    if (/^(approved|tradable|fresh)$/i.test(k) && v === false) score += 90;
    if (/^(score|confidence|technicalScore|researchScore)$/i.test(k) && Number.isFinite(Number(v))) score += Math.max(0, Number(v)) / 10;
  }
  return score;
}
function compactNoisyArray(value, key, depth) {
  if (!Array.isArray(value)) return compactValue(value, key, depth + 1);
  if (value.length <= 4) return value.map((v) => compactValue(v, key, depth + 1));
  return {
    compacted: true,
    originalCount: value.length,
    first: value.slice(0, 2).map((v) => compactValue(v, key, depth + 1)),
    last: value.slice(-2).map((v) => compactValue(v, key, depth + 1)),
    omittedMiddleCount: Math.max(0, value.length - 4)
  };
}
function compactArray(value, key, depth) {
  if (!Array.isArray(value)) return value;
  const limit = CRITICAL_ARRAY_RE.test(String(key || '')) ? MAX_CRITICAL_ARRAY : MAX_GENERIC_ARRAY;
  if (value.length <= limit) return value.map((v) => compactValue(v, key, depth + 1));

  const indexed = value.map((item, index) => ({ item, index, score: itemImportance(item) }));
  const mandatory = indexed.filter((x) => x.score >= 90);
  const selected = new Map();
  for (const x of mandatory.slice(0, MAX_CRITICAL_ARRAY)) selected.set(x.index, x);
  const ranked = indexed.slice().sort((a, b) => b.score - a.score || a.index - b.index);
  for (const x of ranked) {
    if (selected.size >= limit) break;
    selected.set(x.index, x);
  }
  if (selected.size < limit) {
    for (const x of indexed) {
      if (selected.size >= limit) break;
      selected.set(x.index, x);
    }
  }
  return [...selected.values()].sort((a, b) => a.index - b.index).map((x) => compactValue(x.item, key, depth + 1));
}
function compactValue(value, key = '', depth = 0) {
  if (depth > 9) return '[depth-limited]';
  if (scalar(value)) return typeof value === 'string' ? sanitizeString(value, key) : value;
  if (Array.isArray(value)) return compactArray(value, key, depth);
  if (!isObject(value)) return String(value);
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (noisyKey(childKey)) {
      if (Array.isArray(childValue)) out[childKey] = compactNoisyArray(childValue, childKey, depth);
      else if (isObject(childValue)) out[childKey] = { compacted: true, keys: Object.keys(childValue).length };
      else out[childKey] = compactValue(childValue, childKey, depth + 1);
      continue;
    }
    out[childKey] = compactValue(childValue, childKey, depth + 1);
  }
  return out;
}

function collectSafetyFacts(value, path = [], inheritedSymbol = '', facts = new Set(), inNoisy = false) {
  if (inNoisy || value === null || value === undefined) return facts;
  if (Array.isArray(value)) {
    for (const item of value) collectSafetyFacts(item, path, inheritedSymbol, facts, false);
    return facts;
  }
  if (!isObject(value)) return facts;
  const symbol = objectSymbol(value, inheritedSymbol);
  for (const [key, child] of Object.entries(value)) {
    if (noisyKey(key)) continue;
    if (scalar(child) && SAFETY_KEY_RE.test(key)) {
      const text = String(child);
      const mustPreserve = IMPORTANT_VALUE_RE.test(text) || child === false ||
        /^(hardVeto|veto|blocked|circuitBreakerOpen|newBuyBlocked|canTrade|canAuthorizeLive|livePromotionAllowed)$/i.test(key);
      if (mustPreserve) facts.add(`${symbol || path.join('.') || 'ROOT'}|${key}|${text}`);
    }
    if (!scalar(child)) collectSafetyFacts(child, path.concat(key), symbol, facts, false);
  }
  return facts;
}
function sameSafetyFacts(original, compacted) {
  const a = collectSafetyFacts(original);
  const b = collectSafetyFacts(compacted);
  for (const fact of a) if (!b.has(fact)) return { ok: false, missing: fact, originalCount: a.size, compactCount: b.size };
  return { ok: true, missing: null, originalCount: a.size, compactCount: b.size };
}

function subtreeHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function dedupeLargeSubtrees(value, path = 'root', seen = new Map(), metrics = { references: 0, charsSaved: 0 }, depth = 0) {
  if (depth > 12 || scalar(value) || value === undefined) return value;
  if (!Array.isArray(value) && !isObject(value)) return value;

  let processed;
  if (Array.isArray(value)) {
    processed = value.map((item, index) => dedupeLargeSubtrees(item, `${path}[${index}]`, seen, metrics, depth + 1));
  } else {
    processed = {};
    for (const [key, child] of Object.entries(value)) {
      processed[key] = dedupeLargeSubtrees(child, `${path}.${key}`, seen, metrics, depth + 1);
    }
  }

  const text = safeJson(processed);
  if (!text || text.length < DEDUPE_MIN_CHARS || path === 'root') return processed;
  const hash = subtreeHash(text);
  const prior = seen.get(hash);
  if (prior && prior.text === text) {
    metrics.references += 1;
    metrics.charsSaved += Math.max(0, text.length - 80);
    return { compacted: true, sameAs: prior.path, originalChars: text.length };
  }
  seen.set(hash, { path, text });
  return processed;
}

function safetyProjection(value, key = '', depth = 0) {
  if (depth > 12 || value === undefined) return undefined;
  if (scalar(value)) {
    if (SAFETY_KEY_RE.test(key) || IDENTITY_KEY_RE.test(key) || DECISION_SCALAR_RE.test(key)) {
      return typeof value === 'string' ? sanitizeString(value, key) : value;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    const projected = [];
    for (const item of value) {
      const p = safetyProjection(item, key, depth + 1);
      if (p !== undefined && (!isObject(p) || Object.keys(p).length > 0)) projected.push(p);
    }
    return projected.length ? projected : undefined;
  }
  if (!isObject(value)) return undefined;

  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (noisyKey(childKey)) continue;
    if (scalar(childValue)) {
      if (SAFETY_KEY_RE.test(childKey) || IDENTITY_KEY_RE.test(childKey) || DECISION_SCALAR_RE.test(childKey)) {
        out[childKey] = typeof childValue === 'string' ? sanitizeString(childValue, childKey) : childValue;
      }
      continue;
    }
    const projected = safetyProjection(childValue, childKey, depth + 1);
    if (projected !== undefined && (!isObject(projected) || Object.keys(projected).length > 0)) out[childKey] = projected;
  }
  return Object.keys(out).length ? out : undefined;
}

function compactOpaqueBulkSubtrees(value, key = 'root', metrics = { compacted: 0, charsSaved: 0 }, depth = 0) {
  if (depth > 12 || scalar(value) || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => compactOpaqueBulkSubtrees(item, key, metrics, depth + 1));
  if (!isObject(value)) return value;

  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const text = safeJson(childValue);
    if (opaqueBulkKey(childKey) && text && text.length >= OPAQUE_BULK_MIN_CHARS) {
      const projection = safetyProjection(childValue, childKey, depth + 1);
      const replacement = {
        compacted: true,
        kind: 'opaque-current-bulk',
        originalChars: text.length,
        ...(projection === undefined ? {} : { safetyProjection: projection })
      };
      const replacementText = safeJson(replacement);
      metrics.compacted += 1;
      metrics.charsSaved += Math.max(0, text.length - replacementText.length);
      out[childKey] = replacement;
      continue;
    }
    out[childKey] = compactOpaqueBulkSubtrees(childValue, childKey, metrics, depth + 1);
  }
  return out;
}

function adaptiveCompactOversize(original, firstPass) {
  const dedupeMetrics = { references: 0, charsSaved: 0 };
  let candidate = dedupeLargeSubtrees(firstPass, 'root', new Map(), dedupeMetrics, 0);
  let safety = sameSafetyFacts(original, candidate);
  if (!safety.ok) return { ok: false, reason: 'ADAPTIVE_DEDUPE_SAFETY_FACT_LOSS', candidate: firstPass, safety, dedupeMetrics };

  let text = safeJson(candidate);
  if (text && text.length <= MAX_INPUT_CHARS) {
    return {
      ok: true, reason: 'COMPACTED_DEDUPED', payload: candidate, safety,
      afterChars: text.length, dedupeMetrics, opaqueMetrics: { compacted: 0, charsSaved: 0 }
    };
  }

  const opaqueMetrics = { compacted: 0, charsSaved: 0 };
  candidate = compactOpaqueBulkSubtrees(candidate, 'root', opaqueMetrics, 0);
  safety = sameSafetyFacts(original, candidate);
  if (!safety.ok) return { ok: false, reason: 'ADAPTIVE_OPAQUE_SAFETY_FACT_LOSS', candidate: firstPass, safety, dedupeMetrics, opaqueMetrics };

  // Opaque projections can themselves expose identical safety summaries, so run
  // a final dedupe pass after projection.
  const finalDedupeMetrics = { references: 0, charsSaved: 0 };
  candidate = dedupeLargeSubtrees(candidate, 'root', new Map(), finalDedupeMetrics, 0);
  safety = sameSafetyFacts(original, candidate);
  if (!safety.ok) return { ok: false, reason: 'ADAPTIVE_FINAL_SAFETY_FACT_LOSS', candidate: firstPass, safety, dedupeMetrics, opaqueMetrics, finalDedupeMetrics };

  text = safeJson(candidate);
  return {
    ok: Boolean(text && text.length <= MAX_INPUT_CHARS),
    reason: text && text.length <= MAX_INPUT_CHARS ? 'COMPACTED_ADAPTIVE' : 'SAFE_COMPACTION_ABOVE_LIMIT',
    payload: candidate,
    candidate,
    safety,
    afterChars: text ? text.length : 0,
    dedupeMetrics,
    opaqueMetrics,
    finalDedupeMetrics
  };
}

function isDecisionPayload(payload) {
  return isObject(payload) && payload.trading_mode && payload.portfolio_summary && payload.market_data_summary && payload.foundation_agents && typeof payload.instruction === 'string';
}
function parseDecisionUserMessage(message) {
  if (!message || message.role !== 'user' || typeof message.content !== 'string') return null;
  try {
    const payload = JSON.parse(message.content);
    return isDecisionPayload(payload) ? payload : null;
  } catch { return null; }
}
function compactDecisionPayload(payload) {
  const before = safeJson(payload);
  if (!before) return { ok: false, reason: 'UNSERIALIZABLE', payload, beforeChars: 0, afterChars: 0, reductionPct: 0 };
  const firstPass = compactValue(payload, 'root', 0);
  let safety = sameSafetyFacts(payload, firstPass);
  if (!safety.ok) return { ok: false, reason: 'SAFETY_FACT_LOSS', safety, payload, beforeChars: before.length, afterChars: before.length, reductionPct: 0 };
  let after = safeJson(firstPass);
  if (!after) return { ok: false, reason: 'COMPACT_UNSERIALIZABLE', payload, beforeChars: before.length, afterChars: before.length, reductionPct: 0 };

  if (after.length <= MAX_INPUT_CHARS) {
    return {
      ok: true, reason: 'COMPACTED', safety, payload: firstPass,
      beforeChars: before.length, afterChars: after.length,
      reductionPct: round((1 - after.length / before.length) * 100, 2)
    };
  }

  const adaptive = adaptiveCompactOversize(payload, firstPass);
  if (!adaptive.ok) {
    return {
      ok: false, reason: adaptive.reason || 'SAFE_COMPACTION_ABOVE_LIMIT',
      safety: adaptive.safety || safety,
      payload,
      candidate: adaptive.candidate || firstPass,
      beforeChars: before.length,
      afterChars: adaptive.afterChars || after.length,
      reductionPct: round((1 - (adaptive.afterChars || after.length) / before.length) * 100, 2),
      adaptive
    };
  }

  after = safeJson(adaptive.payload);
  safety = adaptive.safety;
  return {
    ok: true,
    reason: adaptive.reason,
    safety,
    payload: adaptive.payload,
    beforeChars: before.length,
    afterChars: after.length,
    reductionPct: round((1 - after.length / before.length) * 100, 2),
    adaptive
  };
}
function optimizeParams(original = {}) {
  const params = { ...original };
  if (!ENABLED || !Array.isArray(params.messages)) return { params, optimized: false, reason: ENABLED ? 'NO_MESSAGES' : 'DISABLED' };
  let targetIndex = -1;
  let payload = null;
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const parsed = parseDecisionUserMessage(params.messages[i]);
    if (parsed) { targetIndex = i; payload = parsed; break; }
  }
  if (targetIndex < 0) return { params, optimized: false, reason: 'NON_DECISION_REQUEST' };
  const result = compactDecisionPayload(payload);
  if (!result.ok) return { params, optimized: false, reason: result.reason, metrics: result };
  const messages = params.messages.slice();
  messages[targetIndex] = { ...messages[targetIndex], content: JSON.stringify(result.payload) };
  params.messages = messages;
  return { params, optimized: true, reason: result.reason, metrics: result };
}
function log(event, details = {}, level = 'log') {
  const record = { component: 'LEO_AI_CONTEXT_OPTIMIZER', version: VERSION, event, at: new Date().toISOString(), ...details };
  lastEvent = record;
  (console[level] || console.log)(`[LEO_AI_CONTEXT] ${JSON.stringify(record)}`);
}

class ContextOptimizedOpenAI extends CurrentOpenAI {
  constructor(options) {
    super(options);
    if (!this.chat?.completions?.create) return;
    const create = this.chat.completions.create.bind(this.chat.completions);
    this.chat.completions.create = async (originalParams, requestOptions) => {
      const result = optimizeParams(originalParams || {});
      const m = result.metrics;
      if (result.optimized) {
        stats.optimized += 1;
        stats.charsBefore += m.beforeChars;
        stats.charsAfter += m.afterChars;
        if (String(result.reason).includes('ADAPTIVE') || String(result.reason).includes('DEDUPED')) stats.adaptiveCompactions += 1;
        stats.dedupeReferences += Number(m.adaptive?.dedupeMetrics?.references || 0) + Number(m.adaptive?.finalDedupeMetrics?.references || 0);
        stats.opaqueBulkCompactions += Number(m.adaptive?.opaqueMetrics?.compacted || 0);
        log('CONTEXT_COMPACTED', {
          mode: result.reason,
          beforeChars: m.beforeChars,
          afterChars: m.afterChars,
          reductionPct: m.reductionPct,
          safetyFacts: m.safety?.originalCount || 0,
          dedupeReferences: Number(m.adaptive?.dedupeMetrics?.references || 0) + Number(m.adaptive?.finalDedupeMetrics?.references || 0),
          opaqueBulkCompactions: Number(m.adaptive?.opaqueMetrics?.compacted || 0),
          maxInputChars: MAX_INPUT_CHARS
        });
      } else {
        stats.passthrough += 1;
        if (String(result.reason).includes('SAFETY') || String(result.reason).includes('LIMIT')) stats.safetyFallbacks += 1;
        if (m?.beforeChars) log('CONTEXT_PASSTHROUGH', {
          reason: result.reason,
          beforeChars: m.beforeChars,
          candidateChars: m.afterChars || null,
          maxInputChars: MAX_INPUT_CHARS
        }, 'warn');
      }
      return create(result.params, requestOptions);
    };
  }
}

for (const key of Reflect.ownKeys(CurrentOpenAI)) {
  if (['length', 'name', 'prototype'].includes(String(key))) continue;
  try { const d = Object.getOwnPropertyDescriptor(CurrentOpenAI, key); if (d) Object.defineProperty(ContextOptimizedOpenAI, key, d); } catch {}
}
ContextOptimizedOpenAI.OpenAI = ContextOptimizedOpenAI;
ContextOptimizedOpenAI.default = ContextOptimizedOpenAI;
if (require.cache[openAIPath]) require.cache[openAIPath].exports = ContextOptimizedOpenAI;

global.__LEO_AI_CONTEXT_STATE__ = () => ({
  version: VERSION,
  enabled: ENABLED,
  maxInputChars: MAX_INPUT_CHARS,
  maxStringChars: MAX_STRING_CHARS,
  dedupeMinChars: DEDUPE_MIN_CHARS,
  opaqueBulkMinChars: OPAQUE_BULK_MIN_CHARS,
  stats: { ...stats },
  lastEvent,
  safety: {
    strategyModified: false, sizingModified: false, etoroModified: false,
    liveExecutionArmedModified: false, providerCallsAdded: 0
  }
});

log('STARTED', {
  enabled: ENABLED,
  maxInputChars: MAX_INPUT_CHARS,
  maxStringChars: MAX_STRING_CHARS,
  dedupeMinChars: DEDUPE_MIN_CHARS,
  opaqueBulkMinChars: OPAQUE_BULK_MIN_CHARS,
  strategyModified: false,
  sizingModified: false,
  etoroModified: false,
  liveExecutionArmedModified: false,
  secretsLogged: false
});

module.exports = {
  VERSION,
  compactValue,
  collectSafetyFacts,
  sameSafetyFacts,
  dedupeLargeSubtrees,
  safetyProjection,
  compactOpaqueBulkSubtrees,
  adaptiveCompactOversize,
  isDecisionPayload,
  parseDecisionUserMessage,
  compactDecisionPayload,
  optimizeParams
};
