'use strict';

/**
 * LEO-AI SENTINEL v10.22.9.1 — GPT-5.6 Luna Chat Completions compatibility shim.
 *
 * Loaded AFTER ai-cost-optimizer.js and BEFORE index.js.
 * It removes only the explicit `temperature` field for GPT-5.6 Luna requests,
 * because Luna accepts only its default temperature. No strategy, sizing,
 * eToro, LIVE execution, budget or prompt content is modified.
 */

const CurrentOpenAI = require('openai');
const openAIPath = require.resolve('openai');
const VERSION = 'v10.22.9.1-luna-temperature-compat';

function isLunaModel(model) {
  return String(model || '').trim().toLowerCase().includes('gpt-5.6-luna');
}

function sanitizeLunaParams(original = {}) {
  const params = { ...original };
  if (isLunaModel(params.model) && Object.prototype.hasOwnProperty.call(params, 'temperature')) {
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
  behavior: 'REMOVE_EXPLICIT_TEMPERATURE_FOR_GPT_5_6_LUNA_ONLY',
  strategyModified: false,
  sizingModified: false,
  etoroModified: false,
  liveExecutionArmedModified: false,
  budgetModified: false,
  secretsLogged: false
})}`);

module.exports = {
  VERSION,
  isLunaModel,
  sanitizeLunaParams
};
