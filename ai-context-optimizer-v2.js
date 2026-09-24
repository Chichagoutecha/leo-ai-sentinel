'use strict';

/**
 * LEO-AI SENTINEL v10.22.18.0 — decision context optimizer v2.
 *
 * Production objective:
 * - materially reduce the central GPT decision payload before the provider call;
 * - preserve every safety fact detected by the conservative v1 collector, even
 *   when the verbose source subtree itself is omitted;
 * - expose request-size diagnostics so provider token usage can be compared with
 *   the actual payload sent.
 *
 * Safety design:
 * - a focused projection keeps decision-relevant current state;
 * - any v1 safety fact omitted by that projection is copied verbatim into
 *   __leo_safety_manifest.facts;
 * - the optimized payload is forwarded only if every original v1 safety fact is
 *   present either structurally or in that exact manifest;
 * - if a safe payload cannot fit below the fail-closed ceiling, the original
 *   request is forwarded unchanged.
 *
 * Governance: prompt/context only. No strategy thresholds, sizing, eToro order,
 * risk veto, LIVE arming, scheduling, broker payload or provider-call count is
 * changed.
 */
const CurrentOpenAI = require('openai');
const openAIPath = require.resolve('openai');
const v1 = require('./ai-context-optimizer');

const VERSION = 'v10.22.18.0-ai-context-v2';
const ENABLED = process.env.AI_CONTEXT_V2_ENABLED !== 'false';
const TRIGGER_CHARS = clampInt(process.env.AI_CONTEXT_V2_TRIGGER_CHARS, 60000, 30000, 300000);
const TARGET_CHARS = clampInt(process.env.AI_CONTEXT_V2_TARGET_CHARS, 50000, 25000, 90000);
const FALLBACK_MAX_CHARS = Math.max(
  TARGET_CHARS,
  clampInt(process.env.AI_CONTEXT_V2_FALLBACK_MAX_CHARS, 70000, 35000, 120000)
);
const MAX_ARRAY_ITEMS = clampInt(process.env.AI_CONTEXT_V2_MAX_ARRAY_ITEMS, 20, 8, 80);
const MAX_STRING_CHARS = clampInt(process.env.AI_CONTEXT_V2_MAX_STRING_CHARS, 600, 120, 3000);

const IMPORTANT_KEY_RE = /^(?:source|time|version|trading_mode|max_order_usd|starter_portfolio_mode|preferred_next_assets|watchlist|asset_rules|progressive_order_policy|execution_stats_24h|instruction|execution_awareness|action|decision|asset|symbol|ticker|instrument|instrumentId|name|provider|endpoint|status|reason|approved|approval|hardVeto|veto|blocked|blockReason|circuitBreakerOpen|newBuyBlocked|tradable|eligibleForTrade|fresh|stale|confidence|score|technicalScore|researchScore|weight|weightPct|price|bid|ask|last|mid|cash|availableCash|totalTrackedValue|amount|amountUsd|category|regime|profile|allocation|allocationPlan|recommendedBuys|recommended_buys|approvedBuyAssets|approvedSellAssets|approved_buys|approved_sells|thresholds|ranking|topCandidates|candidateDiagnostics|support|opposition|reasons|vetoes|healthy|mode|confirmationMode|buyThreshold|sellThreshold|buySupportPct|sellSupportPct|disagreementPct|participationCount|buyAgentCount|sellAgentCount|executionSafe|requiredSatisfied|primaryAligned|marketState|priceStatus|ageSeconds|freshnessSeconds)$/i;
const IMPORTANT_VALUE_RE = /(BUY|SELL|HOLD|VETO|BLOCK|BREAKER|ERROR|FAIL|UNSAFE|STALE|CLOSED|REJECT|RISK|APPROVED|INCONCLUSIVE|ORDER_NO_EFFECT|REBALANCE|MIXED|RISK_OFF|HIGH_VOLATILITY)/i;
const SENSITIVE_KEY_RE = /(secret|password|authorization|cookie|x-api-key|x-user-key|apikey|api_key|userkey|user_key|bearer)/i;

let lastEvent = null;
const stats = {
  optimized: 0,
  passthrough: 0,
  safetyFallbacks: 0,
  manifestCompactions: 0,
  charsBefore: 0,
  charsAfter: 0,
  requestCharsBefore: 0,
  requestCharsAfter: 0
};

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function safeJson(value) { try { return JSON.stringify(value); } catch { return ''; } }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function scalar(value) { return value === null || ['string','number','boolean'].includes(typeof value); }
function compactString(value) {
  const s = String(value);
  return s.length > MAX_STRING_CHARS ? s.slice(0, MAX_STRING_CHARS) + '…[truncated]' : s;
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
    if (/^(confidence|score|technicalScore|researchScore)$/i.test(key) && Number.isFinite(Number(value))) {
      score += Number(value) / 10;
    }
  }
  return score;
}
function projectArray(value, key, depth) {
  const projected = value
    .map((item, index) => ({
      item,
      index,
      score: itemScore(item),
      projected: projectValue(item, key, depth + 1)
    }))
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
  return [...selected.values()]
    .sort((a, b) => a.index - b.index)
    .map((x) => x.projected);
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
    if (SENSITIVE_KEY_RE.test(childKey)) continue;
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
  projected.__leo_context_contract = {
    version: VERSION,
    focusedCurrentState: true,
    safetyManifestAuthoritative: true,
    rule: 'Every __leo_safety_manifest fact is an exact omitted safety fact formatted as scope|key|value. Treat VETO/BLOCK/CLOSED/STALE/false eligibility and other hard constraints as binding. The MultiAgentCouncil and downstream RiskController remain authoritative.'
  };
  return projected;
}

function readManifestFacts(candidate) {
  const facts = candidate?.__leo_safety_manifest?.facts;
  return new Set(Array.isArray(facts) ? facts.map(String) : []);
}

function attachMissingSafetyManifest(original, candidate) {
  const originalFacts = v1.collectSafetyFacts(original);
  const projectedFacts = v1.collectSafetyFacts(candidate);
  const missing = [...originalFacts].filter((fact) => !projectedFacts.has(fact)).sort();
  const next = { ...candidate };

  if (missing.length) {
    next.__leo_safety_manifest = {
      exact: true,
      format: 'scope|key|value',
      count: missing.length,
      facts: missing
    };
  }

  return {
    candidate: next,
    missingCount: missing.length,
    originalCount: originalFacts.size,
    projectedCount: projectedFacts.size
  };
}

function manifestSafetyCheck(original, candidate) {
  const originalFacts = v1.collectSafetyFacts(original);
  const projectedFacts = v1.collectSafetyFacts(candidate);
  const manifestFacts = readManifestFacts(candidate);

  for (const fact of originalFacts) {
    if (!projectedFacts.has(fact) && !manifestFacts.has(fact)) {
      return {
        ok: false,
        missing: fact,
        originalCount: originalFacts.size,
        projectedCount: projectedFacts.size,
        manifestCount: manifestFacts.size
      };
    }
  }

  return {
    ok: true,
    missing: null,
    originalCount: originalFacts.size,
    projectedCount: projectedFacts.size,
    manifestCount: manifestFacts.size
  };
}

function narrowProjection(payload) {
  const narrow = v1.safetyProjection(payload, 'root', 0) || {};
  for (const key of [
    'source','time','version','trading_mode','max_order_usd','starter_portfolio_mode',
    'preferred_next_assets','progressive_order_policy','execution_stats_24h',
    'execution_awareness','instruction'
  ]) {
    if (payload[key] !== undefined) narrow[key] = payload[key];
  }

  const council = projectValue(payload.agent_council, 'agent_council', 0);
  if (council !== undefined) narrow.agent_council = council;

  const portfolio = v1.safetyProjection(payload.portfolio_summary, 'portfolio_summary', 0);
  if (portfolio !== undefined) narrow.portfolio_summary = portfolio;

  const market = v1.safetyProjection(payload.market_data_summary, 'market_data_summary', 0);
  if (market !== undefined) narrow.market_data_summary = market;

  const agents = v1.safetyProjection(payload.foundation_agents, 'foundation_agents', 0);
  if (agents !== undefined) narrow.foundation_agents = agents;

  for (const key of ['portfolio_summary','market_data_summary','foundation_agents','agent_council']) {
    if (!(key in narrow)) narrow[key] = {};
  }

  narrow.__leo_context_contract = {
    version: VERSION,
    focusedCurrentState: true,
    safetyManifestAuthoritative: true,
    narrowFallback: true,
    rule: 'The safety manifest contains exact omitted safety facts. Never override a hard veto or select an action not approved by the MultiAgentCouncil.'
  };
  return narrow;
}

function parseDecisionUserMessage(message) {
  if (!message || message.role !== 'user' || typeof message.content !== 'string') return null;
  try {
    const payload = JSON.parse(message.content);
    return v1.isDecisionPayload(payload) ? payload : null;
  } catch { return null; }
}

function buildSafeCandidate(payload, base, mode) {
  const manifested = attachMissingSafetyManifest(payload, base);
  const candidate = manifested.candidate;
  const safety = manifestSafetyCheck(payload, candidate);
  const text = safeJson(candidate);
  return {
    mode,
    candidate,
    safety,
    text,
    chars: text ? text.length : 0,
    manifestCount: safety.manifestCount || 0
  };
}

function compactDecisionPayloadV2(payload) {
  const before = safeJson(payload);
  if (!before) {
    return { ok: false, reason: 'UNSERIALIZABLE', payload, beforeChars: 0, afterChars: 0 };
  }
  if (before.length <= TRIGGER_CHARS) {
    return {
      ok: false,
      reason: 'BELOW_TRIGGER',
      payload,
      beforeChars: before.length,
      afterChars: before.length
    };
  }

  const primary = buildSafeCandidate(payload, decisionProjection(payload), 'V2_FOCUSED_SAFETY_MANIFEST');
  const narrow = buildSafeCandidate(payload, narrowProjection(payload), 'V2_SAFETY_MANIFEST_FALLBACK');

  const safeCandidates = [primary, narrow]
    .filter((item) => item.safety.ok && item.text)
    .sort((a, b) => a.chars - b.chars);

  const targetCandidate = safeCandidates.find((item) => item.chars <= TARGET_CHARS);
  const fallbackCandidate = safeCandidates.find((item) => item.chars <= FALLBACK_MAX_CHARS);
  const chosen = targetCandidate || fallbackCandidate || null;

  if (!chosen) {
    const smallest = safeCandidates[0] || primary;
    return {
      ok: false,
      reason: smallest.safety?.ok === false
        ? 'V2_SAFETY_MANIFEST_VERIFICATION_FAILED'
        : 'V2_SAFE_PROJECTION_ABOVE_FAIL_CLOSED_CEILING',
      payload,
      candidate: smallest.candidate,
      safety: smallest.safety,
      beforeChars: before.length,
      afterChars: smallest.chars || 0,
      targetChars: TARGET_CHARS,
      fallbackMaxChars: FALLBACK_MAX_CHARS
    };
  }

  return {
    ok: true,
    reason: chosen.mode,
    payload: chosen.candidate,
    safety: chosen.safety,
    beforeChars: before.length,
    afterChars: chosen.chars,
    manifestCount: chosen.manifestCount,
    targetMet: chosen.chars <= TARGET_CHARS,
    targetChars: TARGET_CHARS,
    fallbackMaxChars: FALLBACK_MAX_CHARS,
    reductionPct: Math.round((1 - chosen.chars / before.length) * 10000) / 100
  };
}

function optimizeParams(original = {}) {
  const params = { ...original };
  const requestCharsBefore = safeJson(params).length;

  if (!ENABLED || !Array.isArray(params.messages)) {
    return {
      params,
      optimized: false,
      reason: ENABLED ? 'NO_MESSAGES' : 'DISABLED',
      requestCharsBefore,
      requestCharsAfter: requestCharsBefore
    };
  }

  let targetIndex = -1;
  let payload = null;
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const parsed = parseDecisionUserMessage(params.messages[i]);
    if (parsed) {
      targetIndex = i;
      payload = parsed;
      break;
    }
  }

  if (targetIndex < 0) {
    return {
      params,
      optimized: false,
      reason: 'NON_DECISION_REQUEST',
      requestCharsBefore,
      requestCharsAfter: requestCharsBefore
    };
  }

  const result = compactDecisionPayloadV2(payload);
  if (!result.ok) {
    return {
      params,
      optimized: false,
      reason: result.reason,
      metrics: {
        ...result,
        requestCharsBefore,
        requestCharsAfter: requestCharsBefore,
        roughInputTokenEstimateAfter: Math.ceil(requestCharsBefore / 4)
      }
    };
  }

  const messages = params.messages.slice();
  messages[targetIndex] = { ...messages[targetIndex], content: JSON.stringify(result.payload) };
  params.messages = messages;

  const requestCharsAfter = safeJson(params).length;
  return {
    params,
    optimized: true,
    reason: result.reason,
    metrics: {
      ...result,
      requestCharsBefore,
      requestCharsAfter,
      roughInputTokenEstimateAfter: Math.ceil(requestCharsAfter / 4)
    }
  };
}

function log(event, details = {}, level = 'log') {
  const record = {
    component: 'LEO_AI_CONTEXT_OPTIMIZER_V2',
    version: VERSION,
    event,
    at: new Date().toISOString(),
    ...details
  };
  lastEvent = record;
  (console[level] || console.log)('[LEO_AI_CONTEXT_V2] ' + JSON.stringify(record));
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
        stats.manifestCompactions += Number(m.manifestCount || 0) > 0 ? 1 : 0;
        stats.charsBefore += Number(m.beforeChars || 0);
        stats.charsAfter += Number(m.afterChars || 0);
        stats.requestCharsBefore += Number(m.requestCharsBefore || 0);
        stats.requestCharsAfter += Number(m.requestCharsAfter || 0);

        log('CONTEXT_COMPACTED_V2', {
          mode: result.reason,
          beforeChars: m.beforeChars,
          afterChars: m.afterChars,
          reductionPct: m.reductionPct,
          requestCharsBefore: m.requestCharsBefore,
          requestCharsAfter: m.requestCharsAfter,
          roughInputTokenEstimateAfter: m.roughInputTokenEstimateAfter,
          safetyFacts: m.safety?.originalCount || 0,
          manifestFacts: m.safety?.manifestCount || 0,
          targetMet: Boolean(m.targetMet),
          targetChars: TARGET_CHARS,
          fallbackMaxChars: FALLBACK_MAX_CHARS
        });
      } else {
        stats.passthrough += 1;
        if (
          String(result.reason).includes('SAFETY') ||
          String(result.reason).includes('CEILING') ||
          String(result.reason).includes('TARGET')
        ) {
          stats.safetyFallbacks += 1;
        }

        if (m?.beforeChars && m.beforeChars > TRIGGER_CHARS) {
          log('CONTEXT_V2_PASSTHROUGH', {
            reason: result.reason,
            beforeChars: m.beforeChars,
            candidateChars: m.afterChars || null,
            requestCharsBefore: m.requestCharsBefore || null,
            roughInputTokenEstimateAfter: m.roughInputTokenEstimateAfter || null,
            targetChars: TARGET_CHARS,
            fallbackMaxChars: FALLBACK_MAX_CHARS
          }, 'warn');
        }
      }

      return create(result.params, requestOptions);
    };
  }
}

for (const key of Reflect.ownKeys(CurrentOpenAI)) {
  if (['length','name','prototype'].includes(String(key))) continue;
  try {
    const d = Object.getOwnPropertyDescriptor(CurrentOpenAI, key);
    if (d) Object.defineProperty(ContextOptimizedOpenAIV2, key, d);
  } catch {}
}
ContextOptimizedOpenAIV2.OpenAI = ContextOptimizedOpenAIV2;
ContextOptimizedOpenAIV2.default = ContextOptimizedOpenAIV2;
if (require.cache[openAIPath]) require.cache[openAIPath].exports = ContextOptimizedOpenAIV2;

global.__LEO_AI_CONTEXT_V2_STATE__ = () => ({
  version: VERSION,
  enabled: ENABLED,
  triggerChars: TRIGGER_CHARS,
  targetChars: TARGET_CHARS,
  fallbackMaxChars: FALLBACK_MAX_CHARS,
  stats: { ...stats },
  lastEvent,
  safety: {
    exactMissingFactsManifested: true,
    failClosedAboveCeiling: true,
    strategyModified: false,
    sizingModified: false,
    etoroModified: false,
    liveExecutionArmedModified: false,
    providerCallsAdded: 0
  }
});

log('STARTED', {
  enabled: ENABLED,
  triggerChars: TRIGGER_CHARS,
  targetChars: TARGET_CHARS,
  fallbackMaxChars: FALLBACK_MAX_CHARS,
  exactMissingFactsManifested: true,
  failClosedAboveCeiling: true,
  strategyModified: false,
  sizingModified: false,
  etoroModified: false,
  liveExecutionArmedModified: false,
  providerCallsAdded: 0,
  secretsLogged: false
});

module.exports = {
  VERSION,
  projectValue,
  decisionProjection,
  narrowProjection,
  attachMissingSafetyManifest,
  manifestSafetyCheck,
  parseDecisionUserMessage,
  compactDecisionPayloadV2,
  optimizeParams
};
