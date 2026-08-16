'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

process.env.SHADOW_ALPACA_VALIDATOR_ENABLED = 'true';
process.env.SHADOW_ALPACA_STATE_FILE = `/tmp/leo-alpaca-validator-test-${process.pid}.json`;
try { fs.unlinkSync(process.env.SHADOW_ALPACA_STATE_FILE); } catch {}

const validator = require('./shadow-alpaca-validator.js');

const NOW = Date.parse('2026-08-17T14:00:00Z');

function alpacaStock(symbol = 'SPY', price = 100, timestamp = '2026-08-17T13:58:00Z') {
  return {
    snapshots: {
      [symbol]: {
        symbol,
        latest_trade: { symbol, timestamp, price, size: 10 },
        latest_quote: {
          symbol,
          timestamp,
          bid_price: price - 0.02,
          ask_price: price + 0.02,
          bid_size: 100,
          ask_size: 100
        },
        minute_bar: { symbol, timestamp, close: price, volume: 1000 },
        daily_bar: {
          symbol,
          timestamp: '2026-08-17T04:00:00Z',
          open: 99.5,
          high: 101,
          low: 99,
          close: price,
          volume: 1000000,
          trade_count: 10000
        },
        previous_daily_bar: { symbol, timestamp: '2026-08-16T04:00:00Z', close: 99.5 }
      }
    }
  };
}

function etoro(symbol = 'SPY', mid = 100, timestamp = '2026-08-17T13:59:00Z') {
  return {
    symbol,
    mid,
    bid: mid - 0.02,
    ask: mid + 0.02,
    timestamp
  };
}

test('normalizes the connected Alpaca stock snapshot schema', () => {
  const normalized = validator.normalizeAlpacaSnapshot(alpacaStock(), 'SPY');
  assert.equal(normalized.symbol, 'SPY');
  assert.equal(normalized.priceBasis, 'QUOTE_MID');
  assert.equal(normalized.price, 100);
  assert.equal(normalized.quoteComplete, true);
  assert.ok(normalized.spreadPct > 0);
  assert.ok(normalized.dailyVolume > 0);
  assert.ok(normalized.dailyRangePct > 0);
});

test('normalizes crypto pair symbol to the eToro-style base ticker', () => {
  const payload = {
    snapshots: {
      'BTC/USD': {
        symbol: 'BTC/USD',
        latest_quote: {
          timestamp: '2026-08-17T13:59:00Z',
          bid_price: 62990,
          ask_price: 63010
        },
        daily_bar: {
          timestamp: '2026-08-17T00:00:00Z',
          high: 64000,
          low: 62000,
          close: 63000,
          volume: 10,
          trade_count: 1000
        },
        previous_daily_bar: { close: 62500 }
      }
    }
  };
  const normalized = validator.normalizeAlpacaSnapshot(payload, 'BTC');
  assert.equal(normalized.symbol, 'BTC');
  assert.equal(normalized.price, 63000);
});

test('confirms independent observations when fresh, liquid and price-aligned', () => {
  const report = validator.compareMarketObservations(etoro(), alpacaStock(), { nowMs: NOW });
  assert.equal(report.status, 'CONFIRMED');
  assert.equal(report.reason, 'INDEPENDENT_PRICE_CONFIRMATION');
  assert.ok(report.priceDivergencePct < 0.1);
  assert.ok(report.confidence > 0.7);
  assert.equal(report.canTrade, false);
  assert.equal(report.canAuthorizeLive, false);
});

test('flags material cross-provider divergence rather than averaging it away', () => {
  const report = validator.compareMarketObservations(etoro('SPY', 100), alpacaStock('SPY', 104), {
    nowMs: NOW,
    maxPriceDivergencePct: 0.8
  });
  assert.equal(report.status, 'DIVERGENT');
  assert.equal(report.reason, 'PRICE_DIVERGENCE');
  assert.ok(report.priceDivergencePct > 3);
});

test('rejects stale and future-dated provider observations', () => {
  const stale = validator.compareMarketObservations(
    etoro('SPY', 100, '2026-08-17T12:00:00Z'),
    alpacaStock(),
    { nowMs: NOW, etoroMaxAgeMinutes: 20 }
  );
  assert.equal(stale.status, 'STALE');
  assert.match(stale.reason, /ETORO_STALE/);

  const future = validator.compareMarketObservations(
    etoro(),
    alpacaStock('SPY', 100, '2026-08-17T14:20:00Z'),
    { nowMs: NOW, alpacaMaxAgeMinutes: 20 }
  );
  assert.equal(future.status, 'STALE');
  assert.match(future.reason, /ALPACA_TIMESTAMP_FROM_FUTURE/);
});

test('builds research evidence only from usable validation reports', () => {
  const confirmed = validator.compareMarketObservations(etoro(), alpacaStock(), { nowMs: NOW });
  const evidence = validator.evidenceFromValidation(confirmed);
  assert.ok(evidence.some((item) => item.kind === 'MARKET_CONFIRMATION'));
  assert.ok(evidence.some((item) => item.kind === 'LIQUIDITY'));
  assert.ok(evidence.some((item) => item.kind === 'VOLATILITY'));
  assert.ok(evidence.every((item) => item.source === 'ALPACA'));

  const stale = validator.compareMarketObservations(
    etoro('SPY', 100, '2026-08-17T10:00:00Z'),
    alpacaStock(),
    { nowMs: NOW }
  );
  assert.deepEqual(validator.evidenceFromValidation(stale), []);
});

test('ingestion delegates only normalized evidence to Shadow Research and exposes no trade function', async () => {
  const accepted = [];
  global.__LEO_SHADOW_RESEARCH_BULK_INGEST__ = async (items) => {
    accepted.push(...items);
    return items.map((evidence) => ({ ok: true, evidence }));
  };

  const result = await validator.ingestValidation(etoro(), alpacaStock(), { nowMs: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.report.status, 'CONFIRMED');
  assert.ok(accepted.length >= 1);
  assert.equal('executeBuy' in validator, false);
  assert.equal('executeSell' in validator, false);
  assert.equal('placeOrder' in validator, false);

  const snapshot = await validator.stateSnapshot();
  assert.equal(snapshot.safety.canTrade, false);
  assert.equal(snapshot.safety.canAuthorizeLive, false);
  assert.equal(snapshot.safety.networkClientPresent, false);
  assert.equal(snapshot.stats.executionCalls, 0);
  assert.equal(snapshot.stats.openAiCalls, 0);
});
