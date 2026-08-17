'use strict';

/**
 * LEO-AI SENTINEL v10.22.9.5 — decision-context optimizer for GPT-5.6 Luna.
 *
 * Loaded AFTER ai-cost-optimizer.js and ai-luna-temperature-compat.js.
 * It only compacts LEO decision payloads before the provider call. Safety-critical
 * current facts are preserved; if preservation cannot be proven, the original
 * payload is sent unchanged.
 */

const CurrentOpenAI = require('openai');
const openAIPath = require.resolve('openai');
const VERSION = 'v10.22.9.5-ai-context-budgeting';
const ENABLED = process.env.AI_CONTEXT_OPTIMIZER_ENABLED !== 'false';
const MAX_INPUT_CHARS = clampInt(process.env.AI_CONTEXT_MAX_INPUT_CHARS, 120000, 40000, 500000);
const MAX_STRING_CHARS = clampInt(process.env.AI_CONTEXT_MAX_STRING_CHARS, 900, 200, 5000);
const MAX_GENERIC_ARRAY = clampInt(process.env.AI_CONTEXT_MAX_GENERIC_ARRAY, 16, 4, 64);
const MAX_CRITICAL_ARRAY = clampInt(process.env.AI_CONTEXT_MAX_CRITICAL_ARRAY, 64, 16, 160);

const NOISY_EXACT = new Set([
  'history','histories','scanhistory','watchhistory','executionverificationhistory',
  'performancehistory','equityhistory','agentcouncilhistory','macrocreditregimehistory',
  'researchEvents'.toLowerCase(),'pointintimearchive','audittrail','logs','trendmemory',
  'scientifictrials','runs','leaderboard','raw','rawdata','payload','candles','bars',
  'pricehistory','historicaldata','pointintimeindex'
]);
const CRITICAL_ARRAY_RE = /(position|order|reason|veto|approved|block|risk|health|execution|candidate|council|divergence|provider)/i;
const IMPORTANT_VALUE_RE = /(VETO|BLOCK|BREAKER|ERROR|FAIL|UNSAFE|STALE|CLOSED|REJECT|INCONCLUSIVE|RISK|AI_FAILURES|ORDER_NO_EFFECT|SELL|BUY)/i;
const SAFETY_KEY_RE = /^(action|status|reason|approved|approval|hardVeto|veto|blocked|blockReason|circuitBreakerOpen|newBuyBlocked|tradable|stale|fresh|confidence|canTrade|canAuthorizeLive|livePromotionAllowed|portfolioIdentityConfirmed|identityConfirmed)$/i;

let lastEvent = null;
const stats = { optimized: 0, passthrough: 0, safetyFallbacks: 0, charsBefore: 0, charsAfter: 0 };

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function round(n, p = 2) { const m = 10 ** p; return Math.round(Number(n || 0) * m) / m; }
function safeJson(value) { try { return JSON.stringify(value); } catch { return ''; } }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function noisyKey(key) {
  const k = String(key || '').replace(/[_\-\s]/g, '').toLowerCase();
  return NOISY_EXACT.has(k) || /history$/.test(k) || /archive$/.test(k);
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
  const retain = value.slice(-2).map((v) => compactValue(v, key, depth + 1));
  return { compacted: true, originalCount: value.length, latest: retain };
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
      const mustPreserve = IMPORTANT_VALUE_RE.test(text) || child === false || /^(hardVeto|veto|blocked|circuitBreakerOpen|newBuyBlocked|canTrade|canAuthorizeLive|livePromotionAllowed)$/i.test(key);
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
  const compacted = compactValue(payload, 'root', 0);
  const safety = sameSafetyFacts(payload, compacted);
  if (!safety.ok) return { ok: false, reason: 'SAFETY_FACT_LOSS', safety, payload, beforeChars: before.length, afterChars: before.length, reductionPct: 0 };
  const after = safeJson(compacted);
  if (!after) return { ok: false, reason: 'COMPACT_UNSERIALIZABLE', payload, beforeChars: before.length, afterChars: before.length, reductionPct: 0 };
  if (after.length > MAX_INPUT_CHARS) {
    return { ok: false, reason: 'SAFE_COMPACTION_ABOVE_LIMIT', safety, payload, candidate: compacted, beforeChars: before.length, afterChars: after.length, reductionPct: round((1 - after.length / before.length) * 100, 2) };
  }
  return { ok: true, reason: 'COMPACTED', safety, payload: compacted, beforeChars: before.length, afterChars: after.length, reductionPct: round((1 - after.length / before.length) * 100, 2) };
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
        log('CONTEXT_COMPACTED', { beforeChars: m.beforeChars, afterChars: m.afterChars, reductionPct: m.reductionPct, safetyFacts: m.safety?.originalCount || 0, maxInputChars: MAX_INPUT_CHARS });
      } else {
        stats.passthrough += 1;
        if (String(result.reason).includes('SAFETY') || String(result.reason).includes('LIMIT')) stats.safetyFallbacks += 1;
        if (m?.beforeChars) log('CONTEXT_PASSTHROUGH', { reason: result.reason, beforeChars: m.beforeChars, candidateChars: m.afterChars || null, maxInputChars: MAX_INPUT_CHARS }, 'warn');
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
  stats: { ...stats },
  lastEvent,
  safety: { strategyModified: false, sizingModified: false, etoroModified: false, liveExecutionArmedModified: false, providerCallsAdded: 0 }
});

log('STARTED', { enabled: ENABLED, maxInputChars: MAX_INPUT_CHARS, maxStringChars: MAX_STRING_CHARS, strategyModified: false, sizingModified: false, etoroModified: false, liveExecutionArmedModified: false, secretsLogged: false });

module.exports = { VERSION, compactValue, collectSafetyFacts, sameSafetyFacts, isDecisionPayload, parseDecisionUserMessage, compactDecisionPayload, optimizeParams };
