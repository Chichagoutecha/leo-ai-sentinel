'use strict';

/**
 * LEO-AI SENTINEL v10.22.15.0 — execution-aware decision runtime.
 *
 * Adds current execution-venue availability to the existing decision payload and
 * emits explicit diagnostics explaining HOLD/BUY selection. It never places an
 * order, never changes council/risk thresholds, never changes sizing, and never
 * overrides a hard veto. It also moves the default 2-hour cron ten minutes past
 * the hour when the operator has not explicitly configured TRADE_CRON_SCHEDULE,
 * avoiding the LSE 08:00/08:05 boundary while retaining 24/7 crypto scans.
 */
const CurrentOpenAI = require('openai');
const openAIPath = require.resolve('openai');

const VERSION = 'v10.22.15.0-execution-aware-decision';
const ENABLED = process.env.EXECUTION_AWARE_DECISION_ENABLED !== 'false';
const DEFAULT_SCHEDULE = '10 */2 * * *';
const CRYPTO = new Set(['BTC','ETH','SOL']);
const EXECUTION_MAP = Object.freeze({
  SPY: Object.freeze({ executionSymbol: 'CSPX.L', venue: 'LSE' }),
  QQQ: Object.freeze({ executionSymbol: 'CNDX.L', venue: 'LSE' }),
  GLD: Object.freeze({ executionSymbol: 'IGLN.L', venue: 'LSE' }),
  SHY: Object.freeze({ executionSymbol: 'IBTA.L', venue: 'LSE' }),
  TLT: Object.freeze({ executionSymbol: 'DTLA.L', venue: 'LSE' }),
  XLV: Object.freeze({ executionSymbol: 'ZPDH.DE', venue: 'XETRA' }),
  XLP: Object.freeze({ executionSymbol: 'XDWS.DE', venue: 'XETRA' }),
  XLE: Object.freeze({ executionSymbol: 'ZPDE.DE', venue: 'XETRA' })
});

if (ENABLED && !process.env.TRADE_CRON_SCHEDULE) process.env.TRADE_CRON_SCHEDULE = DEFAULT_SCHEDULE;

let lastEvent = null;
let lastDiagnostics = null;
const stats = { augmentedDecisions: 0, responseDiagnostics: 0, holdDespiteExecutableApprovedBuy: 0 };

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function zonedClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { weekday: values.weekday, hour: Number(values.hour), minute: Number(values.minute) };
}
function venueConfig(symbol) {
  const safe = String(symbol || '').toUpperCase();
  if (safe.endsWith('.L')) return { timeZone: 'Europe/London', open: 8 * 60 + 5, close: 16 * 60 + 20 };
  if (safe.endsWith('.DE')) return { timeZone: 'Europe/Berlin', open: 9 * 60 + 5, close: 17 * 60 + 20 };
  return null;
}
function isVenueOpen(symbol, date = new Date()) {
  const config = venueConfig(symbol);
  if (!config) return false;
  const clock = zonedClock(date, config.timeZone);
  if (['Sat','Sun'].includes(clock.weekday)) return false;
  const minute = clock.hour * 60 + clock.minute;
  return minute >= config.open && minute <= config.close;
}
function approvedBuyAssets(council) {
  const explicit = Array.isArray(council?.approvedBuyAssets) ? council.approvedBuyAssets : [];
  if (explicit.length) return [...new Set(explicit.map((x) => String(x).toUpperCase()))];
  const assets = council?.assets;
  if (!isObject(assets)) return [];
  return Object.entries(assets)
    .filter(([, report]) => String(report?.status || '').toUpperCase() === 'APPROVED_BUY' || String(report?.recommendation || '').toUpperCase() === 'BUY')
    .map(([asset]) => String(asset).toUpperCase());
}
function buildExecutionAwareness(payload, date = new Date()) {
  const council = payload?.agent_council || payload?.foundation_agents?.agentCouncil || {};
  const approved = approvedBuyAssets(council);
  const mapped = {};
  const executableNow = [];
  const unavailableNow = [];
  for (const asset of approved) {
    if (CRYPTO.has(asset)) {
      mapped[asset] = { asset, kind: 'CRYPTO_24_7', executableNow: true, executionSymbol: asset, venue: '24/7' };
      executableNow.push(asset);
      continue;
    }
    const config = EXECUTION_MAP[asset];
    if (config) {
      const open = isVenueOpen(config.executionSymbol, date);
      mapped[asset] = { asset, kind: 'UCITS_BRIDGE', ...config, executableNow: open };
      (open ? executableNow : unavailableNow).push(asset);
      continue;
    }
    mapped[asset] = { asset, kind: 'DIRECT_EXISTING_GUARDS', executableNow: null, executionSymbol: null, venue: null };
    executableNow.push(asset);
  }
  return {
    generatedAt: date.toISOString(),
    approvedBuyAssets: approved,
    approvedBuyExecutableNow: executableNow,
    approvedBuyUnavailableNow: unavailableNow,
    mappedAssets: mapped,
    schedule: process.env.TRADE_CRON_SCHEDULE || DEFAULT_SCHEDULE,
    policy: 'A mapped UCITS BUY may be selected only while its execution venue is open. Crypto remains eligible 24/7. Direct assets keep all existing market/preflight guards. Never override a hard veto.'
  };
}
function parseDecisionPayload(message) {
  if (!message || message.role !== 'user' || typeof message.content !== 'string') return null;
  try {
    const payload = JSON.parse(message.content);
    return payload && payload.trading_mode && payload.portfolio_summary && payload.market_data_summary && payload.foundation_agents ? payload : null;
  } catch { return null; }
}
function augmentDecisionPayload(payload, date = new Date()) {
  const awareness = buildExecutionAwareness(payload, date);
  const instructionSuffix = ' EXECUTION-AWARE RULE: before selecting BUY, check execution_awareness. For mapped UCITS assets, BUY only if executableNow=true. If a mapped approved BUY is closed, do not send it; choose another council-approved executable asset or HOLD. Crypto may remain executable 24/7. This rule never overrides hard vetoes, risk limits, allocation limits or data-quality controls.';
  return {
    ...payload,
    execution_awareness: awareness,
    instruction: `${String(payload.instruction || '')}${instructionSuffix}`.trim()
  };
}
function extractDecision(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    try { return JSON.parse(content); } catch {}
  }
  if (isObject(response?.choices?.[0]?.message?.parsed)) return response.choices[0].message.parsed;
  return null;
}
function buildDiagnostics(payload, decision, awareness) {
  const action = String(decision?.action || 'UNKNOWN').toUpperCase();
  const asset = String(decision?.asset || 'NONE').toUpperCase();
  const executableApproved = awareness?.approvedBuyExecutableNow || [];
  const closedApproved = awareness?.approvedBuyUnavailableNow || [];
  const chosenExecution = awareness?.mappedAssets?.[asset] || null;
  return {
    generatedAt: new Date().toISOString(),
    action,
    asset,
    confidence: Number.isFinite(Number(decision?.confidence)) ? Number(decision.confidence) : null,
    reason: decision?.reason || null,
    approvedBuyAssets: awareness?.approvedBuyAssets || [],
    approvedBuyExecutableNow: executableApproved,
    approvedBuyUnavailableNow: closedApproved,
    holdDespiteExecutableApprovedBuy: action === 'HOLD' && executableApproved.length > 0,
    chosenExecution,
    councilStatus: payload?.agent_council?.status || null,
    councilApprovedBuyCount: awareness?.approvedBuyAssets?.length || 0
  };
}
function log(event, details = {}, level = 'log') {
  const record = { component: 'LEO_EXECUTION_AWARE_DECISION', version: VERSION, event, at: new Date().toISOString(), ...details };
  lastEvent = record;
  (console[level] || console.log)(`[LEO_DECISION_AWARE] ${JSON.stringify(record)}`);
}

class ExecutionAwareOpenAI extends CurrentOpenAI {
  constructor(options) {
    super(options);
    if (!this.chat?.completions?.create) return;
    const create = this.chat.completions.create.bind(this.chat.completions);
    this.chat.completions.create = async (originalParams, requestOptions) => {
      if (!ENABLED || !Array.isArray(originalParams?.messages)) return create(originalParams, requestOptions);
      let targetIndex = -1;
      let payload = null;
      for (let i = originalParams.messages.length - 1; i >= 0; i -= 1) {
        const parsed = parseDecisionPayload(originalParams.messages[i]);
        if (parsed) { targetIndex = i; payload = parsed; break; }
      }
      if (targetIndex < 0) return create(originalParams, requestOptions);

      const augmented = augmentDecisionPayload(payload);
      const awareness = augmented.execution_awareness;
      const messages = originalParams.messages.slice();
      messages[targetIndex] = { ...messages[targetIndex], content: JSON.stringify(augmented) };
      const params = { ...originalParams, messages };
      stats.augmentedDecisions += 1;
      log('DECISION_CONTEXT_AUGMENTED', {
        approvedBuyAssets: awareness.approvedBuyAssets,
        executableNow: awareness.approvedBuyExecutableNow,
        unavailableNow: awareness.approvedBuyUnavailableNow,
        schedule: awareness.schedule
      });

      const response = await create(params, requestOptions);
      const decision = extractDecision(response);
      if (decision) {
        lastDiagnostics = buildDiagnostics(augmented, decision, awareness);
        stats.responseDiagnostics += 1;
        if (lastDiagnostics.holdDespiteExecutableApprovedBuy) stats.holdDespiteExecutableApprovedBuy += 1;
        log('DECISION_DIAGNOSTICS', lastDiagnostics, lastDiagnostics.holdDespiteExecutableApprovedBuy ? 'warn' : 'log');
      }
      return response;
    };
  }
}

for (const key of Reflect.ownKeys(CurrentOpenAI)) {
  if (['length','name','prototype'].includes(String(key))) continue;
  try { const d = Object.getOwnPropertyDescriptor(CurrentOpenAI, key); if (d) Object.defineProperty(ExecutionAwareOpenAI, key, d); } catch {}
}
ExecutionAwareOpenAI.OpenAI = ExecutionAwareOpenAI;
ExecutionAwareOpenAI.default = ExecutionAwareOpenAI;
if (require.cache[openAIPath]) require.cache[openAIPath].exports = ExecutionAwareOpenAI;

global.__LEO_EXECUTION_AWARE_DECISION_STATE__ = () => ({
  version: VERSION,
  enabled: ENABLED,
  defaultTradeSchedule: DEFAULT_SCHEDULE,
  effectiveTradeSchedule: process.env.TRADE_CRON_SCHEDULE || DEFAULT_SCHEDULE,
  stats: { ...stats },
  lastDiagnostics,
  lastEvent,
  governance: {
    canPlaceOrder: false, canModifyOrder: false, canModifySizing: false,
    canOverrideHardVeto: false, canChangeRiskThresholds: false, providerCallsAdded: 0
  }
});

log('STARTED', {
  enabled: ENABLED,
  defaultTradeSchedule: DEFAULT_SCHEDULE,
  effectiveTradeSchedule: process.env.TRADE_CRON_SCHEDULE || DEFAULT_SCHEDULE,
  explicitSchedulePreserved: Boolean(process.env.TRADE_CRON_SCHEDULE && process.env.TRADE_CRON_SCHEDULE !== DEFAULT_SCHEDULE),
  canPlaceOrder: false,
  canOverrideHardVeto: false,
  secretsLogged: false
});

module.exports = {
  VERSION, EXECUTION_MAP, DEFAULT_SCHEDULE, isVenueOpen, approvedBuyAssets,
  buildExecutionAwareness, parseDecisionPayload, augmentDecisionPayload,
  extractDecision, buildDiagnostics
};
