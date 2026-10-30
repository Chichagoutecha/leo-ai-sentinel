'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('./trade-universe-policy');

test('mode resolution fails closed and never enables LIVE through legacy flags', () => {
  assert.equal(policy.resolveTradingMode({}).mode, 'SHADOW');
  assert.equal(policy.resolveTradingMode({ AUTO_TRADE: 'true', ALLOW_LEGACY_AUTO_TRADE: 'true' }).mode, 'SHADOW');
  assert.equal(policy.resolveTradingMode({ TRADING_MODE: 'typo', AUTO_TRADE: 'true' }).mode, 'OFF');
  assert.equal(policy.resolveTradingMode({ TRADING_MODE: 'PAPER' }).mode, 'SHADOW');
  assert.equal(policy.resolveTradingMode({ TRADING_MODE: 'DEMO' }).internalMode, 'DEMO');
});

test('LIVE and DEMO each require explicit mode-specific arming', () => {
  assert.equal(policy.liveBuyReady({ TRADING_MODE: 'LIVE', LIVE_EXECUTION_ARMED: 'true' }), false);
  assert.equal(policy.liveBuyReady({ TRADING_MODE: 'LIVE', LIVE_EXECUTION_ARMED: 'true', LIVE_BUY_CONFIRMATION: policy.LIVE_BUY_CONFIRMATION }), true);
  assert.equal(policy.demoBuyReady({ TRADING_MODE: 'DEMO', DEMO_EXECUTION_ARMED: 'true', ETORO_ACCOUNT_ENV: 'REAL' }), false);
  assert.equal(policy.demoBuyReady({ TRADING_MODE: 'DEMO', DEMO_EXECUTION_ARMED: 'true', ETORO_ACCOUNT_ENV: 'DEMO' }), true);
});

test('universe separates ETFs, stocks, crypto and analysis-only candidates', () => {
  const rows = policy.buildUniverse({ SPY: 1, NVDA: 2, BTC: 3 }, {
    SPY: { category: 'ETF_CORE' }, NVDA: { category: 'AI_BIG_TECH' }, BTC: { category: 'CRYPTO_MAJOR' }
  }, [{ symbol: 'PORT-1', category: 'SMART_PORTFOLIO' }]);
  assert.deepEqual(rows.map((x) => [x.symbol, x.category, x.tradable]), [
    ['SPY', 'ETF', true], ['NVDA', 'STOCK', true], ['BTC', 'CRYPTO', true], ['PORT-1', 'SMART_PORTFOLIO', false]
  ]);
});

test('trade allowlist intersects the current instrument registry and applies exclusions', () => {
  assert.deepEqual(policy.resolveTradeAllowlist({ SPY: 1, BTC: 2, NVDA: 3 }, {
    TRADE_ALLOWED_ASSETS: 'SPY,BTC,UNKNOWN', TRADE_EXCLUDED_ASSETS: 'BTC'
  }), ['SPY']);
  assert.deepEqual(policy.resolveTradeAllowlist({ SPY: 1 }, {}), []);
  assert.deepEqual(policy.resolveTradeAllowlist({ SPY: 1, BTC: 2 }, {
    TRADE_ALLOWED_ASSETS: 'SPY,BTC', TRADE_EXCLUSIONS_JSON: '{"BTC":"Review required"}'
  }), ['SPY']);
  assert.deepEqual(policy.resolveTradeAllowlist({ SPY: 1 }, {
    TRADE_ALLOWED_ASSETS: 'SPY', TRADE_EXCLUSIONS_JSON: '{bad-json'
  }), []);
  assert.deepEqual(policy.resolveAllowedCategories({ TRADE_ALLOWED_CATEGORIES: 'ETF,CRYPTO,SMART_PORTFOLIO' }), ['CRYPTO', 'ETF']);
  assert.equal(policy.parseExclusionReasons({ TRADE_EXCLUSIONS_JSON: '{"BTC":"Volatility policy"}' }).BTC, 'Volatility policy');
});

test('buy policy blocks missing freshness, excess order, duplicate and unsafe mode', () => {
  const base = { mode: 'LIVE', armed: true, confirmation: policy.LIVE_BUY_CONFIRMATION,
    asset: 'SPY', category: 'ETF', allowedAssets: ['SPY'], allowedCategories: ['ETF'], amount: 10, maxOrderUsd: 10,
    minOrderUsd: 1, quoteFresh: true, availableCash: 25, minimumCashReserve: 10,
    currentPositionCount: 3, maxPositions: 12 };
  assert.equal(policy.evaluateBuyPolicy(base).allowed, true);
  assert.ok(policy.evaluateBuyPolicy({ ...base, amount: 11 }).blockers.includes('ORDER_AMOUNT_ABOVE_HARD_CAP'));
  assert.ok(policy.evaluateBuyPolicy({ ...base, duplicateOrPending: true }).blockers.includes('DUPLICATE_OR_PENDING_ORDER'));
  assert.ok(policy.evaluateBuyPolicy({ ...base, quoteFresh: false }).blockers.includes('FRESH_QUOTE_REQUIRED'));
  assert.equal(policy.evaluateBuyPolicy({ ...base, mode: 'SHADOW' }).allowed, false);
});
