'use strict';

/**
 * LEO-AI SENTINEL v10.22.9.7 — shadow-only deterministic no-action analyzer.
 *
 * This preload NEVER changes an OpenAI request or response and NEVER skips a
 * provider call. It only observes LEO decision payloads and records cases where
 * a future deterministic HOLD gate could safely avoid an unnecessary LLM call.
 */

const CurrentOpenAI = require('openai');
const openAIPath = require.resolve('openai');
const VERSION = 'v10.22.9.7-deterministic-no-action-shadow';
const ENABLED = process.env.AI_NO_ACTION_SHADOW_ENABLED !== 'false';

const stats = { observedDecisionCalls: 0, wouldHold: 0, passThrough: 0 };
let lastEvent = null;

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function parsePayload(message) {
  if (!message || message.role !== 'user' || typeof message.content !== 'string') return null;
  try {
    const value = JSON.parse(message.content);
    return isObject(value) && value.trading_mode && value.portfolio_summary && value.market_data_summary && value.foundation_agents && typeof value.instruction === 'string' ? value : null;
  } catch { return null; }
}
function decisionPayloadFromParams(params = {}) {
  if (!Array.isArray(params.messages)) return null;
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const payload = parsePayload(params.messages[i]);
    if (payload) return payload;
  }
  return null;
}
function councilFromPayload(payload = {}) {
  return payload.agent_council || payload.foundation_agents?.agentCouncil || null;
}
function analyzeNoAction(payload) {
  if (!isObject(payload)) return { wouldHold: false, reason: 'NO_DECISION_PAYLOAD' };
  const portfolio = payload.portfolio_summary || {};
  const council = councilFromPayload(payload);
  if (!isObject(council)) return { wouldHold: false, reason: 'NO_COUNCIL' };

  const positions = Number(portfolio.uniquePositionsCount ?? portfolio.positionsCount ?? 0);
  if (!Number.isFinite(positions) || positions !== 0) return { wouldHold: false, reason: 'OPEN_POSITION_REQUIRES_FULL_REVIEW' };

  const summary = council.summary || {};
  const analyzed = Number(summary.analyzedAssets ?? Object.keys(council.assets || {}).length ?? 0);
  const vetoed = Number(summary.vetoed ?? council.vetoedAssets?.length ?? 0);
  const approvedBuys = Number(summary.approvedBuys ?? council.approvedBuyAssets?.length ?? 0);
  const approvedSells = Number(summary.approvedSells ?? council.approvedSellAssets?.length ?? 0);

  if (!Number.isFinite(analyzed) || analyzed <= 0) return { wouldHold: false, reason: 'COUNCIL_EMPTY_OR_INCOMPLETE' };
  if (approvedBuys > 0 || approvedSells > 0) return { wouldHold: false, reason: 'COUNCIL_HAS_ACTIONABLE_APPROVAL' };
  if (!Number.isFinite(vetoed) || vetoed !== analyzed) return { wouldHold: false, reason: 'NOT_ALL_ANALYZED_ASSETS_VETOED' };

  const rows = Object.values(council.assets || {});
  if (rows.length > 0 && rows.some((row) => String(row?.status || '').toUpperCase() !== 'VETOED')) {
    return { wouldHold: false, reason: 'COUNCIL_SUMMARY_ASSET_STATUS_MISMATCH' };
  }

  return {
    wouldHold: true,
    reason: 'EMPTY_PORTFOLIO_ALL_COUNCIL_ASSETS_VETOED',
    analyzedAssets: analyzed,
    vetoedAssets: vetoed,
    approvedBuys,
    approvedSells
  };
}
function log(event, details = {}) {
  const record = { component: 'LEO_AI_NO_ACTION_SHADOW', version: VERSION, event, at: new Date().toISOString(), ...details };
  lastEvent = record;
  console.log(`[LEO_AI_NO_ACTION_SHADOW] ${JSON.stringify(record)}`);
}

class NoActionShadowOpenAI extends CurrentOpenAI {
  constructor(options) {
    super(options);
    if (!this.chat?.completions?.create) return;
    const create = this.chat.completions.create.bind(this.chat.completions);
    this.chat.completions.create = async (originalParams, requestOptions) => {
      const payload = ENABLED ? decisionPayloadFromParams(originalParams || {}) : null;
      if (payload) {
        stats.observedDecisionCalls += 1;
        const analysis = analyzeNoAction(payload);
        if (analysis.wouldHold) {
          stats.wouldHold += 1;
          log('WOULD_HOLD_WITHOUT_LLM', {
            reason: analysis.reason,
            analyzedAssets: analysis.analyzedAssets,
            vetoedAssets: analysis.vetoedAssets,
            requestActuallySkipped: false,
            responseModified: false,
            strategyModified: false,
            sizingModified: false,
            etoroModified: false,
            liveExecutionArmedModified: false
          });
        } else {
          stats.passThrough += 1;
        }
      }
      return create(originalParams, requestOptions);
    };
  }
}

for (const key of Reflect.ownKeys(CurrentOpenAI)) {
  if (['length', 'name', 'prototype'].includes(String(key))) continue;
  try { const d = Object.getOwnPropertyDescriptor(CurrentOpenAI, key); if (d) Object.defineProperty(NoActionShadowOpenAI, key, d); } catch {}
}
NoActionShadowOpenAI.OpenAI = NoActionShadowOpenAI;
NoActionShadowOpenAI.default = NoActionShadowOpenAI;
if (require.cache[openAIPath]) require.cache[openAIPath].exports = NoActionShadowOpenAI;

global.__LEO_AI_NO_ACTION_SHADOW_STATE__ = () => ({
  version: VERSION,
  enabled: ENABLED,
  stats: { ...stats },
  lastEvent,
  safety: {
    requestActuallySkipped: false,
    responseModified: false,
    strategyModified: false,
    sizingModified: false,
    etoroModified: false,
    liveExecutionArmedModified: false,
    providerCallsAdded: 0
  }
});

log('STARTED', { enabled: ENABLED, shadowOnly: true, requestActuallySkipped: false, responseModified: false });

module.exports = { VERSION, parsePayload, decisionPayloadFromParams, analyzeNoAction };
