'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('safe eToro breaker coexists with GPT-5.6 Luna AI stack without blocking close routes', async () => {
  const providerCalls = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    providerCalls.push({ url, method: String(init.method || input?.method || 'GET').toUpperCase() });
    if (url.includes('api.openai.com')) {
      return new Response(JSON.stringify({
        id: 'chatcmpl-safety-stack',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-5.6-luna',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"decision":"HOLD","asset":"NONE","amount_usd":0,"confidence":80}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50, prompt_tokens_details: { cached_tokens: 0 } }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  process.env.ETORO_EMPTY_2XX_BREAKER_MINUTES = '720';
  process.env.AI_REQUEST_CACHE_MINUTES = '0';
  process.env.AI_MONTHLY_BUDGET_USD = '1';

  require('./etoro-execution-diagnostics-v10.22.10.js');
  require('./ai-cost-optimizer.js');
  require('./ai-luna-temperature-compat.js');
  require('./ai-context-optimizer.js');

  const openUrl = 'https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-amount';
  const closeUrl = 'https://public-api.etoro.com/api/v1/trading/execution/market-close-orders/positions/123';

  const firstOpen = await global.fetch(openUrl, {
    method: 'POST',
    headers: { 'x-request-id': 'stack-open-1' },
    body: JSON.stringify({ InstrumentId: 3417, Amount: 10, Leverage: 1, IsBuy: true })
  });
  assert.equal(firstOpen.status, 200);
  const stateAfterOpen = global.__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__();
  assert.equal(stateAfterOpen.breakerActive, true);
  assert.equal(stateAfterOpen.breakerScope, 'NEW_OPEN_ORDERS_ONLY');

  const providerCountBeforeBlockedOpen = providerCalls.length;
  const secondOpen = await global.fetch(openUrl, {
    method: 'POST',
    headers: { 'x-request-id': 'stack-open-2' },
    body: JSON.stringify({ InstrumentId: 3417, Amount: 10, Leverage: 1, IsBuy: true })
  });
  assert.equal(secondOpen.status, 409);
  assert.equal(providerCalls.length, providerCountBeforeBlockedOpen, 'blocked second open must not reach provider');

  const close = await global.fetch(closeUrl, {
    method: 'POST',
    headers: { 'x-request-id': 'stack-close-1' },
    body: JSON.stringify({ UnitsToDeduct: 1 })
  });
  assert.equal(close.status, 200);
  assert.equal(providerCalls.at(-1).url, closeUrl, 'close must reach provider while open-order breaker is active');

  const payload = {
    trading_mode: 'LIVE',
    portfolio_summary: { uniquePositionsCount: 0, availableCash: 9981.45 },
    market_data_summary: { overallStatus: 'OK', assets: {} },
    foundation_agents: { HealthAgent: { circuitBreakerOpen: false } },
    agent_council: { summary: { analyzedAssets: 0, approvedBuys: 0, approvedSells: 0, vetoed: 0 } },
    instruction: 'Choisis une seule décision.'
  };
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: 'test-key', fetch: global.fetch });
  const aiResponse = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.1,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    response_format: { type: 'json_object' }
  });
  assert.equal(aiResponse.model, 'gpt-5.6-luna');
  assert.match(aiResponse.choices[0].message.content, /HOLD/);

  const aiState = await global.__LEO_AI_COST_STATE__();
  assert.equal(aiState.state.successfulCalls, 1);
  assert.equal(aiState.state.failedCalls, 0);
  assert.ok(aiState.state.monthCostUsd > 0);

  const diagState = global.__LEO_ETORO_EXECUTION_DIAGNOSTICS_STATE__();
  assert.equal(diagState.closeAndReduceRoutesNeverBlocked, true);
});
