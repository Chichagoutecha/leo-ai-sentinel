'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('shadow analyzer records would-HOLD but still sends the original request and returns provider response unchanged', async () => {
  let calls = 0;
  let providerBody = null;
  const fakeFetch = async (_url, init = {}) => {
    calls += 1;
    providerBody = JSON.parse(String(init.body || '{}'));
    return new Response(JSON.stringify({
      id: 'chatcmpl-shadow-test',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-5.6-luna',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"decision":"HOLD","asset":"NONE","amount_usd":0,"confidence":80}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 0 } }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const payload = {
    trading_mode: 'LIVE',
    portfolio_summary: { uniquePositionsCount: 0 },
    market_data_summary: { overallStatus: 'OK' },
    foundation_agents: { agentCouncil: { summary: { analyzedAssets: 2, approvedBuys: 0, approvedSells: 0, vetoed: 2 } } },
    agent_council: {
      assets: { SPY: { status: 'VETOED' }, GLD: { status: 'VETOED' } },
      summary: { analyzedAssets: 2, approvedBuys: 0, approvedSells: 0, vetoed: 2 },
      approvedBuyAssets: [], approvedSellAssets: []
    },
    instruction: 'Choisis une seule décision.'
  };

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: 'test-key', fetch: fakeFetch });
  const originalContent = JSON.stringify(payload);
  const response = await client.chat.completions.create({
    model: 'gpt-5.6-luna',
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: originalContent }],
    response_format: { type: 'json_object' }
  });

  assert.equal(calls, 1, 'provider must still be called in shadow mode');
  assert.equal(providerBody.messages[1].content, originalContent, 'shadow analyzer must not modify the request');
  assert.equal(response.choices[0].message.content, '{"decision":"HOLD","asset":"NONE","amount_usd":0,"confidence":80}');
  const state = global.__LEO_AI_NO_ACTION_SHADOW_STATE__();
  assert.equal(state.stats.observedDecisionCalls, 1);
  assert.equal(state.stats.wouldHold, 1);
  assert.equal(state.safety.requestActuallySkipped, false);
  assert.equal(state.safety.responseModified, false);
});
