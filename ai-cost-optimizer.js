'use strict';

/** LEO-AI SENTINEL v10.22.9.4 — hardened cost guard for OpenAI Chat Completions. */
const crypto = require('crypto');

const VERSION = 'v10.22.9.4-ai-cost-concurrency-hardening';
const ENABLED = process.env.AI_COST_OPTIMIZER_ENABLED !== 'false';
const PRIMARY_MODEL = String(process.env.AI_PRIMARY_MODEL || 'gpt-5.6-luna').trim();
const FORCE_PRIMARY = process.env.AI_FORCE_PRIMARY_MODEL !== 'false';
const MONTHLY_BUDGET_USD = num('AI_MONTHLY_BUDGET_USD', 1.00, 0.10, 1000);
const MAX_CALLS_PER_DAY = Math.round(num('AI_MAX_CALLS_PER_DAY', 18, 1, 500));
const MAX_COMPLETION_TOKENS = Math.round(num('AI_MAX_COMPLETION_TOKENS', 1200, 128, 20000));
const CACHE_MINUTES = num('AI_REQUEST_CACHE_MINUTES', 20, 0, 180);
const CACHE_MS = CACHE_MINUTES * 60 * 1000;

// GPT-5.6 Luna pricing configuration. Defaults may be overridden explicitly by environment.
const LUNA_INPUT = num('AI_INPUT_PRICE_PER_MTOK_USD', 0.20, 0, 1000);
const LUNA_CACHED_INPUT = num('AI_CACHED_INPUT_PRICE_PER_MTOK_USD', 0.02, 0, 1000);
const LUNA_OUTPUT = num('AI_OUTPUT_PRICE_PER_MTOK_USD', 1.20, 0, 1000);

const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '');
const REDIS = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const KEY_PREFIX = String(process.env.AI_BUDGET_REDIS_PREFIX || 'leo:ai-cost');

const OriginalOpenAI = require('openai');
const openAIPath = require.resolve('openai');
let state = freshState();
let loadedMonth = null;
let loadPromise = null;
let cache = new Map();
let providerBreakerUntil = 0;
let providerBreakerReason = null;
let lastEvent = null;
let inFlightProjectedUsd = 0;

function num(name, fallback, min, max) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}
function iso() { return new Date().toISOString(); }
function month() { return iso().slice(0, 7); }
function day() { return iso().slice(0, 10); }
function freshState() {
  return {
    version: VERSION, month: month(), monthCostUsd: 0,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
    calls: 0, successfulCalls: 0, failedCalls: 0, blockedCalls: 0, cacheHits: 0,
    daily: { day: day(), calls: 0, successfulCalls: 0, failedCalls: 0, blockedCalls: 0 },
    lastModel: null, lastCallAt: null, lastSuccessAt: null, lastErrorAt: null,
    lastErrorCode: null, updatedAt: iso()
  };
}
function normalize(value) {
  const base = freshState();
  if (!value || typeof value !== 'object' || value.month !== month()) return base;
  const merged = { ...base, ...value, daily: { ...base.daily, ...(value.daily || {}) } };
  if (merged.daily.day !== day()) merged.daily = base.daily;
  return merged;
}
function ensureDay() {
  if (!state.daily || state.daily.day !== day()) {
    state.daily = { day: day(), calls: 0, successfulCalls: 0, failedCalls: 0, blockedCalls: 0 };
  }
}
function redactSecrets(value) {
  let text = String(value ?? '');
  const known = [
    process.env.OPENAI_API_KEY,
    process.env.ETORO_API_KEY,
    process.env.ETORO_USER_KEY,
    process.env.BOT_SECRET,
    UPSTASH_TOKEN
  ].filter((x) => typeof x === 'string' && x.length >= 8);
  for (const secret of known) text = text.split(secret).join('[REDACTED]');
  text = text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[REDACTED]');
  return text.slice(0, 1000);
}
function safeError(error) {
  return error ? {
    name: redactSecrets(error.name || null),
    message: redactSecrets(error.message || error),
    status: error.status || null,
    code: redactSecrets(error.code || error.error?.code || null),
    type: redactSecrets(error.type || error.error?.type || null)
  } : null;
}
function log(event, details = {}, level = 'log') {
  const payload = { component: 'LEO_AI_COST_OPTIMIZER', version: VERSION, event, at: iso(), ...details };
  lastEvent = payload;
  global.__LEO_AI_COST_LAST_EVENT__ = payload;
  (console[level] || console.log)(`[LEO_AI_COST] ${JSON.stringify(payload)}`);
}
async function redis(cmd) {
  if (!REDIS) throw new Error('UPSTASH_NOT_CONFIGURED');
  const r = await global.fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error(`UPSTASH_HTTP_${r.status}`);
  const body = await r.json();
  if (body?.error) throw new Error(`UPSTASH_${body.error}`);
  return body?.result ?? null;
}
function redisKey() { return `${KEY_PREFIX}:${month()}`; }
async function load() {
  if (loadedMonth === month()) { ensureDay(); return state; }
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      if (REDIS) {
        const raw = await redis(['GET', redisKey()]);
        state = raw ? normalize(JSON.parse(raw)) : freshState();
      } else state = normalize(state);
    } catch (e) {
      log('BUDGET_STORE_READ_FALLBACK', { error: safeError(e) }, 'warn');
      state = normalize(state);
    }
    loadedMonth = month(); ensureDay(); return state;
  })();
  try { return await loadPromise; } finally { loadPromise = null; }
}
async function save() {
  state.updatedAt = iso();
  if (!REDIS) return;
  try { await redis(['SET', redisKey(), JSON.stringify(state)]); }
  catch (e) { log('BUDGET_STORE_WRITE_FALLBACK', { error: safeError(e) }, 'warn'); }
}
function prices(model) {
  if (String(model || '').toLowerCase().includes('gpt-5.6-luna')) {
    return { input: LUNA_INPUT, cached: LUNA_CACHED_INPUT, output: LUNA_OUTPUT };
  }
  return {
    input: num('AI_UNKNOWN_MODEL_INPUT_PRICE_PER_MTOK_USD', 5, 0, 1000),
    cached: num('AI_UNKNOWN_MODEL_CACHED_INPUT_PRICE_PER_MTOK_USD', 0.5, 0, 1000),
    output: num('AI_UNKNOWN_MODEL_OUTPUT_PRICE_PER_MTOK_USD', 30, 0, 1000)
  };
}
function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
function cost(model, input, cached, output) {
  const p = prices(model);
  const i = finiteNonNegative(input);
  const c = Math.min(i, finiteNonNegative(cached));
  return ((i - c) / 1e6) * p.input + (c / 1e6) * p.cached + (finiteNonNegative(output) / 1e6) * p.output;
}
function estimateInput(params) {
  try {
    let chars = 0;
    for (const m of (Array.isArray(params?.messages) ? params.messages : [])) {
      chars += String(m?.role || '').length;
      chars += typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content || '').length;
    }
    for (const extra of [params?.response_format, params?.tools, params?.tool_choice]) {
      if (extra != null) chars += JSON.stringify(extra).length;
    }
    // Intentionally conservative to reduce the chance of budget under-reservation.
    return Math.max(1, Math.ceil((chars / 3.5) * 1.25));
  } catch { return 5000; }
}
function projectedCallCost(params) {
  return cost(params?.model, estimateInput(params), 0, MAX_COMPLETION_TOKENS);
}
function fingerprint(params) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify({
      model: params.model, messages: params.messages,
      response_format: params.response_format || null, tools: params.tools || null,
      tool_choice: params.tool_choice || null
    })).digest('hex');
  } catch { return null; }
}
function cleanCache() {
  const now = Date.now();
  for (const [k, v] of cache) if (!v || now - v.at > CACHE_MS) cache.delete(k);
  if (cache.size > 50) {
    const old = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - 50);
    old.forEach(([k]) => cache.delete(k));
  }
}
function budgetError(code, message, meta) {
  const e = new Error(message); e.name = 'LeoAICostBudgetError'; e.code = code; e.status = 429; e.leoAiCost = meta; return e;
}
function optimizedParams(original = {}) {
  if (!ENABLED) return { ...original };
  const params = { ...original };
  if (FORCE_PRIMARY || !params.model) params.model = PRIMARY_MODEL;
  const currentMax = Number(params.max_completion_tokens || params.max_tokens || 0);
  if (!currentMax || currentMax > MAX_COMPLETION_TOKENS) {
    params.max_completion_tokens = MAX_COMPLETION_TOKENS;
    delete params.max_tokens;
  }
  return params;
}
function releaseReservation(value) {
  inFlightProjectedUsd = Math.max(0, inFlightProjectedUsd - finiteNonNegative(value));
}
async function gate(params) {
  await load(); ensureDay(); cleanCache();
  if (Date.now() < providerBreakerUntil) {
    const meta = { reason: 'PROVIDER_BREAKER', until: new Date(providerBreakerUntil).toISOString(), providerBreakerReason };
    state.blockedCalls++; state.daily.blockedCalls++; await save(); log('CALL_BLOCKED', meta, 'warn');
    throw budgetError('AI_PROVIDER_TEMPORARILY_BLOCKED', 'Fournisseur IA temporairement bloqué après une erreur API; aucun ordre ne doit être créé sans analyse.', meta);
  }
  const fp = fingerprint(params);
  if (fp && CACHE_MS > 0) {
    const hit = cache.get(fp);
    if (hit && Date.now() - hit.at <= CACHE_MS) {
      state.cacheHits++; await save(); log('CACHE_HIT', { model: params.model, cacheMinutes: CACHE_MINUTES, monthCostUsd: money(state.monthCostUsd) });
      return { cached: hit.response, fp, reservedProjectedUsd: 0 };
    }
  }
  if (state.daily.calls >= MAX_CALLS_PER_DAY) {
    const meta = { reason: 'DAILY_CALL_LIMIT', dailyCalls: state.daily.calls, maxCallsPerDay: MAX_CALLS_PER_DAY };
    state.blockedCalls++; state.daily.blockedCalls++; await save(); log('CALL_BLOCKED', meta, 'warn');
    throw budgetError('AI_DAILY_CALL_LIMIT_REACHED', 'Plafond quotidien des appels IA atteint; aucun ordre ne doit être créé sans nouvelle analyse.', meta);
  }
  const projected = projectedCallCost(params);
  if (state.monthCostUsd + inFlightProjectedUsd + projected > MONTHLY_BUDGET_USD) {
    const meta = {
      reason: 'MONTHLY_BUDGET', monthCostUsd: money(state.monthCostUsd),
      inFlightProjectedUsd: money(inFlightProjectedUsd), projectedCallUsd: money(projected),
      monthlyBudgetUsd: MONTHLY_BUDGET_USD
    };
    state.blockedCalls++; state.daily.blockedCalls++; await save(); log('CALL_BLOCKED', meta, 'warn');
    throw budgetError('AI_MONTHLY_BUDGET_EXCEEDED', 'Budget mensuel IA atteint ou réservé par des appels en cours; aucun ordre ne doit être créé sans nouvelle analyse.', meta);
  }
  inFlightProjectedUsd += projected;
  state.calls++; state.daily.calls++; state.lastCallAt = iso(); state.lastModel = params.model; await save();
  return { cached: null, fp, reservedProjectedUsd: projected };
}
function usage(response) {
  const u = response?.usage || {};
  const input = finiteNonNegative(u.prompt_tokens ?? u.input_tokens ?? 0);
  return {
    input,
    cached: Math.min(input, finiteNonNegative(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0)),
    output: finiteNonNegative(u.completion_tokens ?? u.output_tokens ?? 0)
  };
}
function money(v) { return Math.round(finiteNonNegative(v) * 1e6) / 1e6; }
async function success(params, response, fp, reservedProjectedUsd = 0) {
  const u = usage(response);
  const usageMissing = !response?.usage || (u.input === 0 && u.output === 0);
  const measuredCost = cost(params.model, u.input, u.cached, u.output);
  const callCost = usageMissing ? Math.max(finiteNonNegative(reservedProjectedUsd), projectedCallCost(params)) : measuredCost;
  state.successfulCalls++; state.daily.successfulCalls++; state.inputTokens += u.input;
  state.cachedInputTokens += u.cached; state.outputTokens += u.output; state.monthCostUsd += callCost;
  state.lastSuccessAt = iso(); state.lastErrorCode = null; state.lastModel = response?.model || params.model;
  if (fp && CACHE_MS > 0) cache.set(fp, { response, at: Date.now() });
  await save();
  log('CALL_COMPLETED', {
    requestedModel: params.model, responseModel: response?.model || null,
    inputTokens: u.input, cachedInputTokens: u.cached, outputTokens: u.output,
    usageMissing, costBasis: usageMissing ? 'CONSERVATIVE_RESERVED_FALLBACK' : 'PROVIDER_USAGE',
    callCostUsd: money(callCost), monthCostUsd: money(state.monthCostUsd),
    monthlyBudgetUsd: MONTHLY_BUDGET_USD, budgetRemainingUsd: money(Math.max(0, MONTHLY_BUDGET_USD - state.monthCostUsd)),
    dailyCalls: state.daily.calls, maxCallsPerDay: MAX_CALLS_PER_DAY
  });
}
async function failure(params, error) {
  await load();
  state.failedCalls++; state.daily.failedCalls++; state.lastErrorAt = iso();
  state.lastErrorCode = redactSecrets(error?.code || error?.error?.code || error?.status || 'UNKNOWN_ERROR');
  const status = Number(error?.status || 0); const code = String(error?.code || error?.error?.code || '');
  if (status === 429) {
    const longQuota = /quota|credit|billing/i.test(`${code} ${error?.message || ''}`);
    providerBreakerUntil = Date.now() + (longQuota ? 60 : 15) * 60 * 1000;
    providerBreakerReason = longQuota ? 'OPENAI_QUOTA_OR_CREDITS' : 'OPENAI_RATE_LIMIT';
  }
  await save();
  log('CALL_FAILED', { model: params?.model || null, error: safeError(error), providerBreakerReason, providerBreakerUntil: providerBreakerUntil ? new Date(providerBreakerUntil).toISOString() : null, monthCostUsd: money(state.monthCostUsd) }, 'warn');
}

class CostOptimizedOpenAI extends OriginalOpenAI {
  constructor(options) {
    super(options);
    if (!ENABLED || !this.chat?.completions?.create) return;
    const create = this.chat.completions.create.bind(this.chat.completions);
    this.chat.completions.create = async (originalParams, requestOptions) => {
      const params = optimizedParams(originalParams || {});
      let g;
      try {
        g = await gate(params);
      } catch (e) {
        if (e?.name !== 'LeoAICostBudgetError') await failure(params, e);
        throw e;
      }
      if (g.cached) return g.cached;
      try {
        const response = await create(params, requestOptions);
        await success(params, response, g.fp, g.reservedProjectedUsd);
        return response;
      } catch (e) {
        await failure(params, e);
        throw e;
      } finally {
        releaseReservation(g.reservedProjectedUsd);
      }
    };
  }
}

for (const key of Reflect.ownKeys(OriginalOpenAI)) {
  if (['length', 'name', 'prototype'].includes(String(key))) continue;
  try { const d = Object.getOwnPropertyDescriptor(OriginalOpenAI, key); if (d) Object.defineProperty(CostOptimizedOpenAI, key, d); } catch {}
}
CostOptimizedOpenAI.OpenAI = CostOptimizedOpenAI;
CostOptimizedOpenAI.default = CostOptimizedOpenAI;
if (ENABLED && require.cache[openAIPath]) require.cache[openAIPath].exports = CostOptimizedOpenAI;

global.__LEO_AI_COST_STATE__ = async () => {
  await load(); ensureDay();
  return {
    optimizerVersion: VERSION, enabled: ENABLED, primaryModel: PRIMARY_MODEL,
    forcePrimaryModel: FORCE_PRIMARY, monthlyBudgetUsd: MONTHLY_BUDGET_USD,
    maxCallsPerDay: MAX_CALLS_PER_DAY, maxCompletionTokens: MAX_COMPLETION_TOKENS,
    requestCacheMinutes: CACHE_MINUTES, persistent: REDIS,
    providerBreakerActive: Date.now() < providerBreakerUntil,
    providerBreakerUntil: providerBreakerUntil ? new Date(providerBreakerUntil).toISOString() : null,
    providerBreakerReason, inFlightProjectedUsd: money(inFlightProjectedUsd),
    state: { ...state, daily: { ...state.daily } }, lastEvent
  };
};

log('STARTED', {
  enabled: ENABLED, primaryModel: PRIMARY_MODEL, forcePrimaryModel: FORCE_PRIMARY,
  monthlyBudgetUsd: MONTHLY_BUDGET_USD, maxCallsPerDay: MAX_CALLS_PER_DAY,
  maxCompletionTokens: MAX_COMPLETION_TOKENS, requestCacheMinutes: CACHE_MINUTES,
  persistentBudgetStore: REDIS, concurrentBudgetReservations: true,
  missingUsageConservativeFallback: true, errorSecretRedaction: true,
  liveExecutionArmedModified: false, strategyModified: false, etoroModified: false, secretsLogged: false
});

module.exports = { VERSION, prices, cost, estimateInput, projectedCallCost, optimizedParams, usage, redactSecrets, safeError };
