'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function decisionPayload() {
  const history = Array.from({ length: 700 }, (_, i) => ({ t: i, px: 100 + i / 100, note: 'redundant-history-'.repeat(10) }));
  return {
    source: 'auto-trade-cron', time: new Date().toISOString(), version: 'test', trading_mode: 'LIVE',
    max_order_usd: 523.95,
    progressive_order_policy: { maximumOrderUsd: 523.95, status: 'ACTIVE' },
    starter_portfolio_mode: true,
    preferred_next_assets: ['SPY','GLD','SHY'],
    watchlist: { SPY: 1, GLD: 2, SHY: 3 },
    asset_rules: { SPY: { category: 'ETF' } },
    portfolio_summary: { availableCash: 9981.45, totalTrackedValue: 9981.45, uniquePositionsCount: 0, performanceHistory: history },
    market_data_summary: { overallStatus: 'MIXED', SPY: { symbol: 'SPY', status: 'FRESH', tradable: true, history }, GLD: { symbol: 'GLD', status: 'CLOSED', tradable: false, reason: 'MARKET_CLOSED', history } },
    foundation_agents: { HealthAgent: { circuitBreakerOpen: false, status: 'OK' }, agentCouncil: { status: 'VETOED', approved: false, votes: [{ asset: 'GLD', action: 'VETO', hardVeto: true, reason: 'MARKET_CLOSED' }] } },
    agent_council: { status: 'VETOED', approved: false, votes: [{ asset: 'GLD', action: 'VETO', hardVeto: true, reason: 'MARKET_CLOSED' }] },
    execution_stats_24h: { total: 0, status: 'OK' },
    instruction: 'Choisis une seule décision et respecte tous les hard veto.'
  };
}

test('cost -> Luna -> context preload chain compacts before provider and preserves veto', async () => {
  let providerBody = null;
  const previousFetch = global.fetch;
  const fakeProviderFetch = async (_url, init = {}) => {
    providerBody = JSON.parse(String(init.body || '{}'));
    return new Response(JSON.stringify({
      id: 'chatcmpl-context-test', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'gpt-5.6-luna',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"action":"HOLD","asset":"NONE","amount_usd":0,"confidence":80,"reason":"Veto respected"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7000, completion_tokens: 40, total_tokens: 7040, prompt_tokens_details: { cached_tokens: 0 } }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  global.fetch = fakeProviderFetch;
  try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: 'test-key-not-secret', fetch: fakeProviderFetch });
    const originalPayload = decisionPayload();
    const originalChars = JSON.stringify(originalPayload).length;
    const response = await client.chat.completions.create({
      model: 'gpt-4.1-mini', temperature: 0.1, max_tokens: 5000,
      messages: [{ role: 'system', content: 'Return a safe JSON decision.' }, { role: 'user', content: JSON.stringify(originalPayload) }],
      response_format: { type: 'json_object' }
    });

    assert.equal(response.model, 'gpt-5.6-luna');
    assert.ok(providerBody);
    assert.equal(providerBody.model, 'gpt-5.6-luna');
    assert.equal(Object.prototype.hasOwnProperty.call(providerBody, 'temperature'), false);
    assert.equal(providerBody.max_completion_tokens, 1200);
    const sent = JSON.parse(providerBody.messages[1].content);
    const sentChars = providerBody.messages[1].content.length;
    assert.ok(sentChars < originalChars * 0.3, `expected >70% reduction (${originalChars} -> ${sentChars})`);
    assert.match(JSON.stringify(sent), /MARKET_CLOSED/);
    assert.match(JSON.stringify(sent), /VETO/);

    const contextState = global.__LEO_AI_CONTEXT_STATE__();
    assert.equal(contextState.stats.optimized, 1);
    assert.equal(contextState.stats.safetyFallbacks, 0);
    const costState = await global.__LEO_AI_COST_STATE__();
    assert.equal(costState.state.successfulCalls, 1);
    assert.ok(costState.state.monthCostUsd > 0);
  } finally {
    global.fetch = previousFetch;
  }
});
