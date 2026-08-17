'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Run with both preloads active:
// node -r ./ai-cost-optimizer.js -r ./ai-luna-temperature-compat.js --test test-ai-luna-preload-integration.js

test('optimizer + Luna compat removes temperature before provider request and preserves a successful completion', async () => {
  let providerBody = null;
  const previousFetch = global.fetch;

  const fakeProviderFetch = async (_url, init = {}) => {
    providerBody = JSON.parse(String(init.body || '{}'));
    return new Response(JSON.stringify({
      id: 'chatcmpl-leo-test',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-5.6-luna',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"action":"HOLD"}' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 25,
        completion_tokens: 8,
        total_tokens: 33,
        prompt_tokens_details: { cached_tokens: 0 }
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  global.fetch = fakeProviderFetch;

  try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: 'test-key-not-a-secret', fetch: fakeProviderFetch });
    const response = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      temperature: 0.1,
      max_tokens: 5000,
      messages: [{ role: 'user', content: 'Return HOLD as JSON.' }],
      response_format: { type: 'json_object' }
    });

    assert.equal(response.model, 'gpt-5.6-luna');
    assert.ok(providerBody);
    assert.equal(providerBody.model, 'gpt-5.6-luna');
    assert.equal(Object.prototype.hasOwnProperty.call(providerBody, 'temperature'), false);
    assert.equal(providerBody.max_completion_tokens, 1200);
    assert.equal(Object.prototype.hasOwnProperty.call(providerBody, 'max_tokens'), false);

    const state = await global.__LEO_AI_COST_STATE__();
    assert.equal(state.primaryModel, 'gpt-5.6-luna');
    assert.equal(state.state.successfulCalls, 1);
    assert.equal(state.state.failedCalls, 0);
    assert.ok(state.state.monthCostUsd > 0);
  } finally {
    global.fetch = previousFetch;
  }
});
