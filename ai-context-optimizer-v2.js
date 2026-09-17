'use strict';

/**
 * LEO-AI SENTINEL v10.22.15.0 — decision context optimizer v2.
 *
 * Second-stage optimizer loaded after ai-context-optimizer.js. It exists for the
 * exact case where the conservative v1 optimizer refuses to compact an oversized
 * current decision state. V2 keeps a compact decision projection and then proves
 * that every safety fact detected by v1 still exists before it forwards the
 * request. If that proof fails, the original request is forwarded unchanged.
 *
 * Governance: prompt/context only. No strategy thresholds, sizing, eToro order,
 * risk veto, LIVE arming or provider-call count is changed.
 */
const CurrentOpenAI = require('openai');
const openAIPath = require.resolve('openai');
const v1 = require('./ai-context-optimizer');

const VERSION = 'v10.22.15.0-ai-context-v2';
const ENABLED = process.env.AI_CONTEXT_V2_ENABLED !== 'false';
const TRIGGER_CHARS = clampInt(process.env.AI_CONTEXT_V2_TRIGGER_CHARS, 90000, 30000, 300000);
const TARGET_CHARS = clampInt(process.env.AI_CONTEXT_V2_TARGET_CHARS, 80000, 25000, 120000);
const MAX_ARRAY_ITEMS = clampInt(process.env.AI_CONTEXT_V2_MAX_ARRAY_ITEMS, 24, 8, 80);
const MAX_STRING_CHARS = clampInt(process.env.AI_CONTEXT_V2_MAX_STRING_CHARS, 700, 120, 3000);

const IMPORTANT_KEY_RE = /^(?:source|time|version|trading_mode|max_order_usd|starter_portfolio_mode|preferred_next_assets|watchlist|asset_rules|execution_stats_24h|instruction|execution_awareness|action|asset|symbol|ticker|instrument|instrumentId|name|provider|endpoint|status|reason|approved|approval|hardVeto|veto|blocked|blockReason|circuitBreakerOpen|newBuyBlocked|tradable|eligibleForTrade|fresh|stale|confidence|score|technicalScore|researchScore|weight|weightPct|price|bid|ask|last|mid|cash|availableCash|totalTrackedValue|amount|amountUsd|category|regime|profile|allocation|allocationPlan|recommendedBuys|recommended_buys|approvedBuyAssets|approvedSellAssets|thresholds|ranking|topCandidates|candidateDiagnostics|support|opposition|reasons|vetoes|healthy|mode|confirmationMode|buyThreshold|sellThreshold|buySupportPct|sellSupportPct|disagreementPct|participationCount|buyAgentCount|sellAgentCount|executionSafe|requiredSatisfied|primaryAligned)$/i;
const IMPORTANT_VALUE_RE = /(BUY|SELL|HOLD|VETO|BLOCK|BREAKER|ERROR|FAIL|UNSAFE|STALE|CLOSED|REJECT|RISK|APPROVED|INCONCLUSIVE|ORDER_NO_EFFECT|REBALANCE|MIXED|RISK_OFF|HIGH_VOLATILITY)/i;

let lastEvent = null;
const stats = { optimized: 0, passthrough: 0, safetyFallbacks: 0, charsBefore: 0, charsAfter: 0 };

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function safeJson(value) { try { return JSON.stringify(value); } catch { return ''; } }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function scalar(value) { return value === null || ['string','number','boolean'].includes(typeof value); }
function compactString(value) {
  const s = String(value);
  return s.length > MAX_STRING_CHARS ? `${s.slice(0, MAX_STRING_CHARS)}…[truncated]` : s;
}
function hasSafetyFacts(value) {
  try { return v1.collectSafetyFacts(value).size > 0; } catch { return false; }
}
function itemScore(item) {
  if (scalar(item)) return IMPORTANT_VALUE_RE.test(String(item)) ? 100 : 0;
  if (!isObject(item)) return 0;
  let score = hasSafetyFacts(item) ? 1000 : 0;
  for (const [key, value] of Object.entries(item)) {
    if (IMPORTANT_KEY_RE.test(key)) score += 10;
    if (IMPORTANT_VALUE_RE.test(String(value))) score += 25;
    if (/^(confidence|score|technicalScore|researchScore)$/i.test(key) && Number.isFinite(Number(value))) score += Number(value) / 10;
  }
  return score;
}
function projectArray(value, key, depth) {
  const projected = value.map((item, index) => ({ item, index, score: itemScore(item), projected: projectValue(item, key, depth + 1) }))
    .filter((x) => x.projected !== undefined);
  if (projected.length <= MAX_ARRAY_ITEMS) return projected.map((x) => x.projected);
  const mandatory = projected.filter((x) => hasSafetyFacts(x.item));
  const selected = new Map();
  for (const x of mandatory) selected.set(x.index, x);
  const ranked = projected.slice().sort((a, b) => b.score - a.score || a.index - b.index);
  for (const x of ranked) {
    if (selected.size >= Math.max(MAX_ARRAY_ITEMS, mandatory.length)) break;
    selected.set(x.index, x);
  }
  return [...selected.values()].sort((a, b) => a.index - b.index).map((x) => x.projected);
}
function projectValue(value, key = '', depth = 0) {
  if (depth > 12 || value === undefined) return undefined;
  if (scalar(value)) {
    if (IMPORTANT_KEY_RE.test(key) || IMPORTANT_VALUE_RE.test(String(value))) {
      return typeof value === 'string' ? compactString(value) : value;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    const out = projectArray(value, key, depth);
    return out.length ? out : undefined;
  }
  if (!isObject(value)) return undefined;
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const projected = projectValue(childValue, childKey, depth + 1);
    if (projected !== undefined) out[childKey] = projected;
  }
  return Object.keys(out).length ? out : undefined;
}
function decisionProjection(payload) {
  const projected = projectValue(payload, 'root', 0) || {};
  for (const key of ['portfolio_summary','market_data_summary','foundation_agents','agent_council']) {
    if (!(key in projected)) projected[key] = {};
  }
  if (typeof payload.instruction === 'string') projected.instruction = compactString(payload.instruction);
  return projected;
}
function parseDecisionUserMessage(message) {
  if (!message || message.role !== 'user' || typeof message.content !== 'string') return null;
  try {
    const payload = JSON.parse(message.content);
    return v1.isDecisionPayload(payload) ? payload : null;
  } catch { return null; }
}
function compactDecisionPayloadV2(payload) {
  const before = safeJson(payload);
  if (!before) return { ok: false, reason: 'UNSERIALIZABLE', payload, beforeChars: 0, afterChars: 0 };
  if (before.length <= TRIGGER_CHARS) return { ok: false, reason: 'BELOW_TRIGGER', payload, beforeChars: before.length, afterChars: before.length };

  let candidate = decisionProjection(payload);
  let safety = v1.sameSafetyFacts(payload, candidate);
  let after = safeJson(candidate);
  if (!safety.ok) {
    return { ok: false, reason: 'V2_SAFETY_FACT_LOSS', payload, candidate, safety, beforeChars: before.length, afterChars: after.length };
  }

  if (after.length > TARGET_CHARS) {
    const narrow = v1.safetyProjection(payload, 'root', 0) || {};
    for (const key of ['source','time','version','trading_mode','max_order_usd','starter_portfolio_mode','preferred_next_assets','execution_stats_24h','execution_awareness','instruction']) {
      if (payload[key] !== undefined) narrow[key] = payload[key];
    }
    for (const key of ['portfolio_summary','market_data_summary','foundation_agents','agent_council']) {
      if (!(key in narrow)) narrow[key] = {};
    }
    const narrowSafety = v1.sameSafetyFacts(payload, narrow);
    const narrowText = safeJson(narrow);
    if (narrowSafety.ok && narrowText && narrowText.length < after.length) {
      candidate = narrow;
      safety = narrowSafety;
      after = narrowText;
    }
  }

  if (!after || after.length > TARGET_CHARS) {
    return { ok: false, reason: 'V2_SAFE_PROJECTION_ABOVE_TARGET', payload, candidate, safety, beforeChars: before.length, afterChars: after ? after.length : 0 };
  }
  return {
    ok: true,
    reason: 'V2_SAFETY_PROJECTION',
    payload: candidate,
    safety,
    beforeChars: before.length,
    afterChars: after.length,
    reductionPct: Math.round((1 - after.length / before.length) * 10000) / 100
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
  const result = compactDecisionPayloadV2(payload);
  if (!result.ok) return { params, optimized: false, reason: result.reason, metrics: result };
  const messages = params.messages.slice();
  messages[targetIndex] = { ...messages[targetIndex], content: JSON.stringify(result.payload) };
  params.messages = messages;
  return { params, optimized: true, reason: result.reason, metrics: result };
}
function log(event, details = {}, level = 'log') {
  const record = { component: 'LEO_AI_CONTEXT_OPTIMIZER_V2', version: VERSION, event, at: new Date().toISOString(), ...details };
  lastEvent = record;
  (console[level] || console.log)(`[LEO_AI_CONTEXT_V2] ${JSON.stringify(record)}`);
}

class ContextOptimizedOpenAIV2 extends CurrentOpenAI {
  constructor(options) {
    super(options);
    if (!this.chat?.completions?.create) return;
    const create = this.chat.completions.create.bind(this.chat.completions);
    this.chat.completions.create = async (originalParams, requestOptions) => {
      const result = optimizeParams(originalParams || {});
      const m = result.metrics;
      if (result.optimized) {
        stats.optimized += 1;
        stats.charsBefore += Number(m.beforeChars || 0);
        stats.charsAfter += Number(m.afterChars || 0);
        log('CONTEXT_COMPACTED_V2', {
          beforeChars: m.beforeChars,
          afterChars: m.afterChars,
          reductionPct: m.reductionPct,
          safetyFacts: m.safety?.originalCount || 0,
          targetChars: TARGET_CHARS
        });
      } else {
        stats.passthrough += 1;
        if (String(result.reason).includes('SAFETY') || String(result.reason).includes('TARGET')) stats.safetyFallbacks += 1;
        if (m?.beforeChars && m.beforeChars > TRIGGER_CHARS) log('CONTEXT_V2_PASSTHROUGH', {
          reason: result.reason,
          beforeChars: m.beforeChars,
          candidateChars: m.afterChars || null,
          targetChars: TARGET_CHARS
        }, 'warn');
      }
      return create(result.params, requestOptions);
    };
  }
}

for (const key of Reflect.ownKeys(CurrentOpenAI)) {
  if (['length','name','prototype'].includes(String(key))) continue;
  try { const d = Object.getOwnPropertyDescriptor(CurrentOpenAI, key); if (d) Object.defineProperty(ContextOptimizedOpenAIV2, key, d); } catch {}
}
ContextOptimizedOpenAIV2.OpenAI = ContextOptimizedOpenAIV2;
ContextOptimizedOpenAIV2.default = ContextOptimizedOpenAIV2;
if (require.cache[openAIPath]) require.cache[openAIPath].exports = ContextOptimizedOpenAIV2;

global.__LEO_AI_CONTEXT_V2_STATE__ = () => ({
  version: VERSION, enabled: ENABLED, triggerChars: TRIGGER_CHARS, targetChars: TARGET_CHARS,
  stats: { ...stats }, lastEvent,
  safety: { strategyModified: false, sizingModified: false, etoroModified: false, liveExecutionArmedModified: false, providerCallsAdded: 0 }
});

log('STARTED', { enabled: ENABLED, triggerChars: TRIGGER_CHARS, targetChars: TARGET_CHARS, strategyModified: false, sizingModified: false, etoroModified: false, secretsLogged: false });

module.exports = { VERSION, projectValue, decisionProjection, parseDecisionUserMessage, compactDecisionPayloadV2, optimizeParams };
