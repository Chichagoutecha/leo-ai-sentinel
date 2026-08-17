'use strict';

/**
 * LEO-AI SENTINEL v10.22.9.1 — GPT-5.6 Luna Chat Completions compatibility shim.
 *
 * Loaded AFTER ai-cost-optimizer.js and BEFORE index.js.
 * It removes only the explicit `temperature` field when the effective model is
 * GPT-5.6 Luna. This includes the production case where ai-cost-optimizer.js
 * force-routes a request from another model name to Luna.
 *
 * No strategy, sizing, eToro, LIVE execution, budget or prompt content is modified.
 */

const CurrentOpenAI = require('openai');
const openAIPath = require.resolve('openai');
const VERSION = 'v10.22.9.1-luna-temperature-compat';
const PRIMARY_MODEL = String(process.env.AI_PRIMARY_MODEL || 'gpt-5.6-luna').trim();
const FORCE_PRIMARY = process.env.AI_FORCE_PRIMARY_MODEL !== 'false';

function isLunaModel(model) {
  return String(model || '').trim().toLowerCase().includes('gpt-5.6-luna');
}

function sanitizeLunaParams(original = {}, options = {}) {
  const params = { ...original };
  const primaryModel = String(options.primaryModel ?? PRIMARY_MODEL).trim();
  const forcePrimaryModel = options.forcePrimaryModel ?? FORCE_PRIMARY;
  const effectiveLuna = isLunaModel(params.model) || (Boolean(forcePrimaryModel) && isLunaModel(primaryModel));

  if (effectiveLuna && Object.prototype.hasOwnProperty.call(params, 'temperature')) {
    delete params.temperature;
  }
  return params;
}

class LunaCompatibleOpenAI extends CurrentOpenAI {
  constructor(options) {
    super(options);
    if (!this.chat?.completions?.create) return;
    const create = this.chat.completions.create.bind(this.chat.completions);
    this.chat.completions.create = async (originalParams, requestOptions) => {
      return create(sanitizeLunaParams(originalParams || {}), requestOptions);
    };
  }
}

for (const key of Reflect.ownKeys(CurrentOpenAI)) {
  if (['length', 'name', 'prototype'].includes(String(key))) continue;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(CurrentOpenAI, key);
    if (descriptor) Object.defineProperty(LunaCompatibleOpenAI, key, descriptor);
  } catch {}
}

LunaCompatibleOpenAI.OpenAI = LunaCompatibleOpenAI;
LunaCompatibleOpenAI.default = LunaCompatibleOpenAI;
if (require.cache[openAIPath]) require.cache[openAIPath].exports = LunaCompatibleOpenAI;

console.log(`[LEO_AI_LUNA_COMPAT] ${JSON.stringify({
  component: 'LEO_AI_LUNA_COMPAT',
  version: VERSION,
  event: 'STARTED',
  behavior: 'REMOVE_EXPLICIT_TEMPERATURE_WHEN_EFFECTIVE_MODEL_IS_GPT_5_6_LUNA',
  primaryModel: PRIMARY_MODEL,
  forcePrimaryModel: FORCE_PRIMARY,
  strategyModified: false,
  sizingModified: false,
  etoroModified: false,
  liveExecutionArmedModified: false,
  budgetModified: false,
  secretsLogged: false
})}`);

module.exports = {
  VERSION,
  PRIMARY_MODEL,
  FORCE_PRIMARY,
  isLunaModel,
  sanitizeLunaParams
};
