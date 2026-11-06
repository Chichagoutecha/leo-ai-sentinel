'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

test('complete npm-start preload order and server initialization stay isolated behind simulated transport, listener and schedulers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'leo-startup-'));
  const script = String.raw`
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const path = require('node:path');
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
    let network = 0, writes = 0, listening = 0, scheduled = 0;
    global.fetch = async (url, init = {}) => {
      network++;
      if (String(url).includes('/trading/execution/') && !['GET', 'HEAD'].includes(String(init.method || 'GET').toUpperCase())) writes++;
      return new Response('{}', { status: 403 });
    };
    const load = Module._load;
    Module._load = function(name, ...args) {
      const exported = load.call(this, name, ...args);
      if (name === 'express') exported.application.listen = function(_port, ready) {
        listening++; ready?.(); return { close() {} };
      };
      if (name === 'node-cron') exported.schedule = () => { scheduled++; return { stop() {}, start() {} }; };
      return exported;
    };
    (async () => {
      const pkg = require('./package.json');
      const tokens = pkg.scripts.start.split(' ');
      let preloaded = 0;
      for (let i = 1; i < tokens.length - 1; i += 2) {
        assert.equal(tokens[i], '-r');
        require(path.resolve(tokens[i + 1])); preloaded++;
      }
      const app = require('./index');
      await app.startServer();
      assert.equal(listening, 1);
      const rate = { mid: 100, bid: 100, ask: 100, date: new Date().toISOString(), priceStatus: 'FRESH', eligibleForTrade: true, ageMinutes: 0 };
      const market = { normalized: { ratesByAsset: { MSFT: rate } } };
      app.ensurePaperPortfolio({ availableCash: 1000, aggregatedPositions: [] }, market.normalized);
      const buy = await app.executeBuy('MSFT', 10, market);
      assert.equal(buy.simulated, true);
      const sell = await app.executeSell('MSFT', market);
      assert.equal(sell.simulated, true);
      assert.equal(network, 0);
      try { await global.fetch('https://public-api.etoro.com/api/v2/trading/execution/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-request-id': 'fixture-request' },
        body: JSON.stringify({ action: 'open', transaction: 'buy', instrumentId: 8757, amount: 10, orderType: 'mkt', leverage: 1 })
      }); } catch { /* a bare dispatch has no durable permit */ }
      assert.equal(writes, 0);
      process.stdout.write(JSON.stringify({ preloaded, scheduled, listenerSimulated: true, simulatedReadCalls: network, executionTransportCalls: writes, externalNetwork: 0, virtualBuy: buy.simulated, virtualSell: sell.simulated }));
      process.exit(0);
    })().catch(error => { process.stdout.write(JSON.stringify({ failure: error.message })); process.exit(1); });
  `;
  try {
    const child = spawnSync(process.execPath, ['-e', script], { cwd: __dirname, timeout: 15000, encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_ENV: 'test', TRADING_MODE: 'SHADOW', PAPER_SEED_FROM_REAL: 'false',
        PAPER_PERFORMANCE_MODE: 'advisory', STATE_FILE: join(directory, 'state.json'), POINT_IN_TIME_ARCHIVE_FILE: join(directory, 'archive.ndjson') } });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.executionTransportCalls, 0);
    assert.equal(result.externalNetwork, 0);
    assert.equal(result.preloaded, 14);
    assert.equal(result.listenerSimulated, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
