'use strict';

/**
 * LEO-AI SENTINEL — Decision Context v2.
 *
 * Goals:
 * - keep the central GPT decision context below a bounded target when the legacy
 *   adaptive optimizer cannot shrink unique current-state payloads enough;
 * - preserve every safety fact through an explicit manifest plus focused current
 *   state projection;
 * - make LIVE decisions aware of the already-installed UCITS execution bridge
 *   window, so a mapped BUY is not selected when its execution venue is closed;
 * - expose compact decision diagnostics without changing risk thresholds, order
 *   sizing, eToro requests, or LIVE arming.
 */

const contextV1 = require('./ai-context-optimizer.js');
const CurrentOpenAI = require('openai');
const openAIPath = require.resolve('openai');

const VERSION = 'v10.22.15.0-decision-context-v2';
const ENABLED = process.env.AI_DECISION_CONTEXT_V2_ENABLED !== 'false';
const AUTO_INSTALL = process.env.AI_DECISION_CONTEXT_V2_AUTO_INSTALL !== 'false';
const TARGET_CHARS = clampInt(process.env.AI_DECISION_CONTEXT_V2_TARGET_CHARS, 90000, 40000, 115000);
const MAX_ARRAY = clampInt(process.env.AI_DECISION_CONTEXT_V2_MAX_ARRAY, 32, 8, 96);
const MAX_STRING = clampInt(process.env.AI_DECISION_CONTEXT_V2_MAX_STRING, 700, 160, 2400);
const DIAGNOSTIC_TOP_N = clampInt(process.env.AI_DECISION_DIAGNOSTIC_TOP_N, 3, 1, 8);

const NOISY_RE = /(history|archive|audittrail|logs|candles|bars|rawpayload|rawresponse|responsebody|pointintime|leaderboard|scientifictrials|researchevents)$/i;
const SENSITIVE_RE = /(secret|password|authorization|cookie|x-api-key|x-user-key|apikey|api_key|userkey|user_key|token|referenceid)/i;
const KEEP_STRING_RE = /(asset|symbol|ticker|instrument|name|status|action|recommendation|reason|rationale|summary|provider|source|regime|category|profile|mode|endpoint|signal|decision|verdict|warning|error|side|transaction|orderType|orderCurrency|time|date|at)$/i;
const KEEP_BOOLEAN_RE = /(approved|approval|hardveto|veto|blocked|breaker|healthy|enabled|tradable|fresh|stale|eligible|required|confirmed|safe|available|cantrade|canbuy|canexecute|allowed|aligned|open)$/i;
const KEEP_NUMBER_RE = /(score|pct|percent|count|amount|usd|cash|price|value|weight|ratio|age|minute|second|volatility|drawdown|sharpe|sortino|beta|alpha|rsi|macd|atr|momentum|support|resistance|minimum|maximum|max|min|confidence|participation|deviation|spread|leverage)$/i;
const ASSET_CONTAINER_RE = /^(assets|ratesByAsset|comparisons|byAsset|assetReports|candidates)$/i;
const EXPLANATION_ARRAY_RE = /(reason|rationale|veto|support|oppos|approved|block|warning|candidate|ranking|vote)/i;

let lastEvent = null;
let lastDiagnostics = null;
const stats = {
  decisionCalls: 0,
  focusedCompactions: 0,
  executionAwareCalls: 0,
  providerErrors: 0,
  charsBefore: 0,
  charsAfter: 0
};

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function safeJson(value) { try { return JSON.stringify(value); } catch { return ''; } }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function scalar(value) { return value === null || ['string', 'number', 'boolean'].includes(typeof value); }
function trimString(value, limit = MAX_STRING) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}
function safeKey(key) { return !SENSITIVE_RE.test(String(key || '')); }
function normalizeAsset(value) { return String(value || '').trim().toUpperCase().slice(0, 40); }

function zonedClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { weekday: values.weekday, hour: Number(values.hour), minute: Number(values.minute) };
}

function venueStatus(symbol, date = new Date()) {
  const safe = String(symbol || '').toUpperCase();
  const config = safe.endsWith('.L')
    ? { venue: 'LSE', timeZone: 'Europe/London', open: 8 * 60 + 5, close: 16 * 60 + 20 }
    : safe.endsWith('.DE')
      ? { venue: 'XETRA', timeZone: 'Europe/Berlin', open: 9 * 60 + 5, close: 17 * 60 + 20 }
      : null;
  if (!config) return { known: false, open: null, venue: null, localClock: null };
  const clock = zonedClock(date, config.timeZone);
  const minuteOfDay = clock.hour * 60 + clock.minute;
  const weekday = !['Sat', 'Sun'].includes(clock.weekday);
  return {
    known: true,
    open: Boolean(weekday && minuteOfDay >= config.open && minuteOfDay <= config.close),
    venue: config.venue,
    timeZone: config.timeZone,
    localClock: `${clock.weekday} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
    regularWindow: safe.endsWith('.L') ? '08:05-16:20 Europe/London' : '09:05-17:20 Europe/Berlin'
  };
}

function buildExecutionWindow(payload, date = new Date(), bridgeState = global.__LEO_ETORO_UCITS_EXECUTION_BRIDGE__) {
  const mode = String(bridgeState?.mode || 'unavailable').toLowerCase();
  const approved = new Set((bridgeState?.approvedSymbols || []).map((x) => String(x).toUpperCase()));
  const mappings = bridgeState?.mappings || {};
  const mappedAssets = {};
  const openMappedAssets = [];
  const closedMappedAssets = [];

  for (const [assetRaw, mapping] of Object.entries(mappings)) {
    const asset = normalizeAsset(assetRaw);
    if (!asset || !mapping?.executionSymbol) continue;
    const executionSymbol = String(mapping.executionSymbol).toUpperCase();
    const venue = venueStatus(executionSymbol, date);
    const explicitlyApproved = approved.has(executionSymbol);
    let buyExecutableNow = null;
    let reason = 'BRIDGE_OFF_OR_UNAVAILABLE_USE_EXISTING_MARKET_RULES';
    if (mode === 'guard') {
      buyExecutableNow = false;
      reason = 'UCITS_BRIDGE_GUARD_MODE';
    } else if (mode === 'live') {
      buyExecutableNow = Boolean(explicitlyApproved && venue.open === true);
      reason = !explicitlyApproved
        ? 'UCITS_SYMBOL_NOT_APPROVED'
        : venue.open === true
          ? 'UCITS_EXECUTION_WINDOW_OPEN'
          : 'UCITS_EXECUTION_VENUE_CLOSED';
    }
    mappedAssets[asset] = {
      executionSymbol,
      venue: mapping.venue || venue.venue,
      bridgeMode: mode,
      explicitlyApproved,
      venueOpen: venue.open,
      buyExecutableNow,
      reason,
      localClock: venue.localClock,
      regularWindow: venue.regularWindow
    };
    if (buyExecutableNow === true) openMappedAssets.push(asset);
    if (buyExecutableNow === false) closedMappedAssets.push(asset);
  }

  return {
    generatedAt: date.toISOString(),
    tradingMode: payload?.trading_mode || null,
    bridgeMode: mode,
    mappedAssets,
    openMappedAssets,
    closedMappedAssets,
    scansRemain24x7: true,
    directAndCryptoAssetsRemainGovernedByExistingMarketRules: true,
    rule: 'In LIVE, a mapped UCITS BUY with buyExecutableNow=false is ineligible for this decision. This execution-feasibility rule never overrides council, risk, identity, data-quality, allocation, or verifier vetoes.'
  };
}

function executionAwareInstruction(original, executionWindow) {
  const closed = executionWindow?.closedMappedAssets || [];
  const prefix = [
    'EXECUTION WINDOW RULE (fail-closed):',
    'in LIVE, never choose BUY for a mapped UCITS asset whose execution_window.mappedAssets[asset].buyExecutableNow is false.',
    'If no council-approved BUY is executable now, choose HOLD.',
    'This rule does not relax any council, risk, data-quality, allocation, identity or verifier requirement.',
    closed.length ? `Mapped BUYs unavailable now: ${closed.join(', ')}.` : 'No mapped UCITS BUY is currently marked unavailable by the bridge window.'
  ].join(' ');
  return `${prefix} ${String(original || '')}`;
}

function collectRelevantAssets(payload) {
  const set = new Set();
  const add = (value) => {
    const asset = normalizeAsset(value);
    if (asset && asset.length <= 40) set.add(asset);
  };
  for (const asset of payload?.preferred_next_assets || []) add(asset);
  for (const asset of payload?.agent_council?.approvedBuyAssets || payload?.agent_council?.approved_buys || []) add(asset);
  for (const asset of payload?.agent_council?.approvedSellAssets || payload?.agent_council?.approved_sells || []) add(asset);
  for (const item of payload?.agent_council?.ranking || []) add(item?.asset || item?.symbol);
  for (const position of payload?.portfolio_summary?.positions || []) add(position?.asset || position?.symbol || position?.ticker);
  for (const key of Object.keys(payload?.agent_council?.assets || {})) add(key);
  for (const key of Object.keys(payload?.watchlist || {})) add(key);
  return set;
}

function keepScalar(key, value, depth) {
  if (!safeKey(key)) return false;
  if (depth <= 1) return true;
  if (typeof value === 'string') return KEEP_STRING_RE.test(key) || String(value).length <= 80 && /(BUY|SELL|HOLD|VETO|BLOCK|RISK|OPEN|CLOSED|MIXED|FRESH|STALE|OK|ERROR)/i.test(value);
  if (typeof value === 'boolean') return KEEP_BOOLEAN_RE.test(key);
  if (typeof value === 'number') return KEEP_NUMBER_RE.test(key);
  if (value === null) return KEEP_STRING_RE.test(key) || KEEP_BOOLEAN_RE.test(key) || KEEP_NUMBER_RE.test(key);
  return false;
}

function projectedImportance(item) {
  if (!isObject(item)) return 0;
  let score = 0;
  if (item.hardVeto === true || item.veto === true || item.blocked === true) score += 1000;
  if (String(item.action || item.status || '').match(/VETO|BLOCK|BUY|SELL|ERROR|CLOSED/i)) score += 500;
  score += Number(item.confidence || item.score || item.technicalScore || 0);
  return score;
}

function projectValue(value, key, relevantAssets, depth = 0) {
  if (depth > 10 || value === undefined) return undefined;
  if (scalar(value)) {
    if (!keepScalar(key, value, depth)) return undefined;
    return typeof value === 'string' ? trimString(value) : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const projected = value
      .map((item) => projectValue(item, key, relevantAssets, depth + 1))
      .filter((item) => item !== undefined && (!isObject(item) || Object.keys(item).length > 0));
    if (projected.length <= MAX_ARRAY) return projected;
    if (EXPLANATION_ARRAY_RE.test(key)) {
      return projected
        .map((item, index) => ({ item, index, score: projectedImportance(item) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, MAX_ARRAY)
        .sort((a, b) => a.index - b.index)
        .map((entry) => entry.item);
    }
    return projected.slice(0, MAX_ARRAY);
  }
  if (!isObject(value)) return undefined;

  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (!safeKey(childKey) || NOISY_RE.test(childKey)) continue;
    if (ASSET_CONTAINER_RE.test(childKey) && isObject(childValue)) {
      const selected = {};
      for (const [assetKey, assetValue] of Object.entries(childValue)) {
        const normalized = normalizeAsset(assetKey);
        if (relevantAssets.size > 0 && normalized && !relevantAssets.has(normalized)) continue;
        const p = projectValue(assetValue, assetKey, relevantAssets, depth + 1);
        if (p !== undefined && (!isObject(p) || Object.keys(p).length > 0)) selected[assetKey] = p;
      }
      if (Object.keys(selected).length > 0) out[childKey] = selected;
      continue;
    }
    const p = projectValue(childValue, childKey, relevantAssets, depth + 1);
    if (p !== undefined && (!isObject(p) || Object.keys(p).length > 0)) out[childKey] = p;
  }
  return Object.keys(out).length ? out : undefined;
}

function manifestObject(facts) {
  const out = {};
  let i = 0;
  for (const fact of [...facts].sort()) {
    out[`f${String(i).padStart(4, '0')}`] = fact;
    i += 1;
  }
  return out;
}

function manifestValues(projected) {
  return new Set(Object.values(projected?.__leo_safety_manifest || {}).map(String));
}

function v2SafetyCheck(original, projected) {
  const originalFacts = contextV1.collectSafetyFacts(original);
  const projectedFacts = contextV1.collectSafetyFacts(projected);
  const manifest = manifestValues(projected);
  for (const fact of originalFacts) {
    if (!projectedFacts.has(fact) && !manifest.has(fact)) {
      return { ok: false, missing: fact, originalCount: originalFacts.size, projectedCount: projectedFacts.size, manifestCount: manifest.size };
    }
  }
  return { ok: true, missing: null, originalCount: originalFacts.size, projectedCount: projectedFacts.size, manifestCount: manifest.size };
}

function focusedProjection(payload) {
  const relevantAssets = collectRelevantAssets(payload);
  const safetyFacts = contextV1.collectSafetyFacts(payload);
  const projected = {
    source: payload.source,
    time: payload.time,
    version: payload.version,
    trading_mode: payload.trading_mode,
    max_order_usd: payload.max_order_usd,
    starter_portfolio_mode: payload.starter_portfolio_mode,
    preferred_next_assets: Array.isArray(payload.preferred_next_assets) ? payload.preferred_next_assets.slice(0, MAX_ARRAY) : [],
    execution_window: payload.execution_window,
    progressive_order_policy: projectValue(payload.progressive_order_policy, 'progressive_order_policy', relevantAssets, 1),
    watchlist: projectValue(payload.watchlist, 'watchlist', relevantAssets, 1),
    asset_rules: projectValue(payload.asset_rules, 'asset_rules', relevantAssets, 1),
    portfolio_summary: projectValue(payload.portfolio_summary, 'portfolio_summary', relevantAssets, 1),
    market_data_summary: projectValue(payload.market_data_summary, 'market_data_summary', relevantAssets, 1),
    foundation_agents: projectValue(payload.foundation_agents, 'foundation_agents', relevantAssets, 1),
    agent_council: projectValue(payload.agent_council, 'agent_council', relevantAssets, 1),
    execution_stats_24h: projectValue(payload.execution_stats_24h, 'execution_stats_24h', relevantAssets, 1),
    instruction: payload.instruction,
    __leo_safety_manifest: manifestObject(safetyFacts),
    __leo_context_v2: {
      version: VERSION,
      focused: true,
      relevantAssets: [...relevantAssets],
      safetyFactCount: safetyFacts.size,
      providerCallsAdded: 0,
      riskThresholdsModified: false,
      sizingModified: false,
      etoroOrderRuntimeModified: false
    }
  };
  for (const [key, value] of Object.entries(projected)) if (value === undefined) delete projected[key];
  return projected;
}

function fallbackSafetyProjection(payload) {
  const safetyFacts = contextV1.collectSafetyFacts(payload);
  const projected = {
    source: payload.source,
    time: payload.time,
    version: payload.version,
    trading_mode: payload.trading_mode,
    max_order_usd: payload.max_order_usd,
    preferred_next_assets: payload.preferred_next_assets,
    execution_window: payload.execution_window,
    portfolio_summary: contextV1.safetyProjection(payload.portfolio_summary, 'portfolio_summary', 0),
    market_data_summary: contextV1.safetyProjection(payload.market_data_summary, 'market_data_summary', 0),
    foundation_agents: contextV1.safetyProjection(payload.foundation_agents, 'foundation_agents', 0),
    agent_council: contextV1.safetyProjection(payload.agent_council, 'agent_council', 0),
    execution_stats_24h: contextV1.safetyProjection(payload.execution_stats_24h, 'execution_stats_24h', 0),
    instruction: payload.instruction,
    __leo_safety_manifest: manifestObject(safetyFacts),
    __leo_context_v2: {
      version: VERSION,
      focused: true,
      fallbackProjection: true,
      safetyFactCount: safetyFacts.size,
      providerCallsAdded: 0,
      riskThresholdsModified: false,
      sizingModified: false,
      etoroOrderRuntimeModified: false
    }
  };
  for (const [key, value] of Object.entries(projected)) if (value === undefined) delete projected[key];
  return projected;
}

function buildCouncilDiagnostics(council = {}) {
  const assets = council?.assets || {};
  const approvedBuys = [...new Set([...(council?.approvedBuyAssets || []), ...(council?.approved_buys || [])].map(normalizeAsset).filter(Boolean))];
  const approvedSells = [...new Set([...(council?.approvedSellAssets || []), ...(council?.approved_sells || [])].map(normalizeAsset).filter(Boolean))];
  const ranking = Array.isArray(council?.ranking) ? council.ranking : [];
  const candidates = ranking.length ? ranking : Object.entries(assets).map(([asset, report]) => ({ asset, ...report }));
  const compactCandidate = (item) => ({
    asset: normalizeAsset(item?.asset || item?.symbol),
    status: item?.status || null,
    recommendation: item?.recommendation || item?.action || null,
    buySupportPct: numberOrNull(item?.buySupportPct ?? item?.buy_support_pct),
    sellSupportPct: numberOrNull(item?.sellSupportPct ?? item?.sell_support_pct),
    disagreementPct: numberOrNull(item?.disagreementPct ?? item?.disagreement_pct),
    participationCount: numberOrNull(item?.participationCount ?? item?.participation_count),
    reasons: compactTextArray(item?.reasons || item?.reason),
    hardVetoes: compactTextArray(item?.hardVetoes || item?.hard_vetoes),
    supportingAgents: compactTextArray(item?.supportingAgents || item?.supporting_agents),
    opposingAgents: compactTextArray(item?.opposingAgents || item?.opposing_agents)
  });
  const topCandidates = candidates.slice(0, DIAGNOSTIC_TOP_N).map(compactCandidate);
  const vetoed = Object.entries(assets)
    .filter(([, report]) => /VETO|BLOCK|DISAGREEMENT|INSUFFICIENT/i.test(String(report?.status || '')) || (report?.hardVetoes?.length || report?.hard_vetoes?.length))
    .slice(0, 8)
    .map(([asset, report]) => compactCandidate({ asset, ...report }));
  return {
    status: council?.status || null,
    approvedBuys,
    approvedSells,
    topCandidates,
    vetoed
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function compactTextArray(value) {
  const array = Array.isArray(value) ? value : value == null ? [] : [value];
  return array.slice(0, 8).map((item) => {
    if (typeof item === 'string') return trimString(item, 240);
    if (isObject(item)) {
      return Object.fromEntries(Object.entries(item)
        .filter(([key]) => safeKey(key) && /^(agent|action|status|reason|rationale|confidence|hardVeto|asset)$/i.test(key))
        .map(([key, val]) => [key, typeof val === 'string' ? trimString(val, 240) : val]));
    }
    return String(item);
  });
}

function parseDecisionContent(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content);
    if (!isObject(parsed)) return null;
    return {
      action: parsed.action || null,
      asset: parsed.asset || null,
      amount_usd: numberOrNull(parsed.amount_usd ?? parsed.amountUsd ?? parsed.amount),
      confidence: numberOrNull(parsed.confidence),
      reason: trimString(parsed.reason || parsed.rationale || '', 320)
    };
  } catch { return null; }
}

function buildDiagnostics(payload, executionWindow, beforeChars, afterChars, compactionMode) {
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: payload?.source || null,
    tradingMode: payload?.trading_mode || null,
    preferredNextAssets: Array.isArray(payload?.preferred_next_assets) ? payload.preferred_next_assets.slice(0, 8) : [],
    council: buildCouncilDiagnostics(payload?.agent_council || {}),
    executionWindow: {
      bridgeMode: executionWindow?.bridgeMode || null,
      openMappedAssets: executionWindow?.openMappedAssets || [],
      closedMappedAssets: executionWindow?.closedMappedAssets || [],
      mappedAssets: executionWindow?.mappedAssets || {}
    },
    context: {
      beforeChars,
      afterChars,
      reductionPct: beforeChars > 0 ? Math.round((1 - afterChars / beforeChars) * 10000) / 100 : 0,
      mode: compactionMode,
      targetChars: TARGET_CHARS
    },
    providerDecision: null,
    providerError: null,
    governance: {
      providerCallsAdded: 0,
      riskThresholdsModified: false,
      sizingModified: false,
      etoroOrderRuntimeModified: false,
      liveExecutionArmedModified: false
    }
  };
}

function prepareDecisionParams(original = {}, date = new Date(), bridgeState = global.__LEO_ETORO_UCITS_EXECUTION_BRIDGE__) {
  const params = { ...original };
  if (!ENABLED || !Array.isArray(params.messages)) return { params, optimized: false, reason: ENABLED ? 'NO_MESSAGES' : 'DISABLED' };
  let targetIndex = -1;
  let payload = null;
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const parsed = contextV1.parseDecisionUserMessage(params.messages[i]);
    if (parsed) { targetIndex = i; payload = parsed; break; }
  }
  if (targetIndex < 0) return { params, optimized: false, reason: 'NON_DECISION_REQUEST' };

  const executionWindow = buildExecutionWindow(payload, date, bridgeState);
  const augmented = {
    ...payload,
    execution_window: executionWindow,
    instruction: executionAwareInstruction(payload.instruction, executionWindow)
  };
  const beforeText = safeJson(augmented);
  let nextPayload = augmented;
  let mode = 'EXECUTION_AWARE_ONLY';
  let safety = { ok: true, missing: null };

  if (beforeText.length > TARGET_CHARS) {
    nextPayload = focusedProjection(augmented);
    safety = v2SafetyCheck(augmented, nextPayload);
    mode = 'FOCUSED_CURRENT_STATE';
    if (!safety.ok || safeJson(nextPayload).length > TARGET_CHARS) {
      const fallback = fallbackSafetyProjection(augmented);
      const fallbackSafety = v2SafetyCheck(augmented, fallback);
      if (fallbackSafety.ok && safeJson(fallback).length <= TARGET_CHARS) {
        nextPayload = fallback;
        safety = fallbackSafety;
        mode = 'SAFETY_FOCUSED_FALLBACK';
      } else {
        nextPayload = augmented;
        safety = fallbackSafety.ok ? safety : fallbackSafety;
        mode = 'FAIL_CLOSED_FULL_CONTEXT';
      }
    }
  }

  const afterText = safeJson(nextPayload);
  const messages = params.messages.slice();
  messages[targetIndex] = { ...messages[targetIndex], content: afterText };
  params.messages = messages;
  const diagnostics = buildDiagnostics(augmented, executionWindow, beforeText.length, afterText.length, mode);
  return {
    params,
    optimized: true,
    reason: mode,
    payload: nextPayload,
    safety,
    executionWindow,
    diagnostics,
    beforeChars: beforeText.length,
    afterChars: afterText.length
  };
}

function log(event, details = {}, level = 'log') {
  const record = { component: 'LEO_DECISION_CONTEXT_V2', version: VERSION, event, at: new Date().toISOString(), ...details };
  lastEvent = record;
  (console[level] || console.log)(`[LEO_DECISION_CONTEXT_V2] ${JSON.stringify(record)}`);
}

function install() {
  if (!AUTO_INSTALL) return { installed: false, reason: 'AUTO_INSTALL_DISABLED', version: VERSION };
  class DecisionContextV2OpenAI extends CurrentOpenAI {
    constructor(options) {
      super(options);
      if (!this.chat?.completions?.create) return;
      const create = this.chat.completions.create.bind(this.chat.completions);
      this.chat.completions.create = async (originalParams, requestOptions) => {
        const prepared = prepareDecisionParams(originalParams || {}, new Date());
        if (!prepared.optimized) return create(originalParams, requestOptions);
        stats.decisionCalls += 1;
        stats.executionAwareCalls += 1;
        stats.charsBefore += prepared.beforeChars;
        stats.charsAfter += prepared.afterChars;
        if (prepared.reason === 'FOCUSED_CURRENT_STATE' || prepared.reason === 'SAFETY_FOCUSED_FALLBACK') stats.focusedCompactions += 1;
        lastDiagnostics = prepared.diagnostics;
        log('CONTEXT_PREPARED', {
          mode: prepared.reason,
          beforeChars: prepared.beforeChars,
          afterChars: prepared.afterChars,
          targetChars: TARGET_CHARS,
          safetyOk: prepared.safety?.ok !== false,
          openMappedAssets: prepared.executionWindow?.openMappedAssets || [],
          closedMappedAssets: prepared.executionWindow?.closedMappedAssets || [],
          providerCallsAdded: 0
        });
        try {
          const response = await create(prepared.params, requestOptions);
          const decision = parseDecisionContent(response);
          if (lastDiagnostics) {
            lastDiagnostics = { ...lastDiagnostics, completedAt: new Date().toISOString(), providerDecision: decision };
          }
          return response;
        } catch (error) {
          stats.providerErrors += 1;
          if (lastDiagnostics) {
            lastDiagnostics = {
              ...lastDiagnostics,
              completedAt: new Date().toISOString(),
              providerError: { name: error?.name || 'Error', code: error?.code || null, message: trimString(error?.message || 'Provider error', 240) }
            };
          }
          throw error;
        }
      };
    }
  }

  for (const key of Reflect.ownKeys(CurrentOpenAI)) {
    if (['length', 'name', 'prototype'].includes(String(key))) continue;
    try { const descriptor = Object.getOwnPropertyDescriptor(CurrentOpenAI, key); if (descriptor) Object.defineProperty(DecisionContextV2OpenAI, key, descriptor); } catch {}
  }
  DecisionContextV2OpenAI.OpenAI = DecisionContextV2OpenAI;
  DecisionContextV2OpenAI.default = DecisionContextV2OpenAI;
  if (require.cache[openAIPath]) require.cache[openAIPath].exports = DecisionContextV2OpenAI;
  return { installed: true, version: VERSION };
}

const autoInstalled = install();

global.__LEO_DECISION_CONTEXT_V2_STATE__ = () => ({
  version: VERSION,
  enabled: ENABLED,
  targetChars: TARGET_CHARS,
  maxArray: MAX_ARRAY,
  stats: { ...stats },
  lastEvent,
  governance: {
    providerCallsAdded: 0,
    riskThresholdsModified: false,
    sizingModified: false,
    etoroOrderRuntimeModified: false,
    liveExecutionArmedModified: false,
    directOrderAuthority: false
  }
});
global.__LEO_DECISION_DIAGNOSTICS__ = () => lastDiagnostics ? JSON.parse(JSON.stringify(lastDiagnostics)) : null;

log('STARTED', {
  enabled: ENABLED,
  autoInstalled: Boolean(autoInstalled?.installed),
  targetChars: TARGET_CHARS,
  executionWindowAware: true,
  scansRemain24x7: true,
  providerCallsAdded: 0,
  riskThresholdsModified: false,
  sizingModified: false,
  etoroOrderRuntimeModified: false,
  liveExecutionArmedModified: false,
  secretsLogged: false
});

module.exports = {
  VERSION,
  venueStatus,
  buildExecutionWindow,
  executionAwareInstruction,
  collectRelevantAssets,
  projectValue,
  focusedProjection,
  fallbackSafetyProjection,
  v2SafetyCheck,
  buildCouncilDiagnostics,
  parseDecisionContent,
  prepareDecisionParams,
  install,
  autoInstalled
};
