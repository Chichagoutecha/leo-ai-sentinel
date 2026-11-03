'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { createExecutionContinuity, SCRIPT, guardExecutionFetch, permit, ExecutionNotSent } = require('./execution-continuity');

const url = 'https://public-api.etoro.com/api/v2/trading/execution/orders';

test('execution boundary denies missing, vetoed, timed-out and unverified permission while keeping reads', async () => {
  const calls = [];
  const fetch = guardExecutionFetch(async (...args) => calls.push(args));
  const options = { method: 'POST', headers: { 'x-request-id': 'request' } };
  await assert.rejects(fetch(url, options), ExecutionNotSent);
  await assert.rejects(fetch(url, { ...options, [permit]: async () => 'EXECUTION_PAUSED' }), ExecutionNotSent);
  await assert.rejects(fetch(url, { ...options, [permit]: async () => { throw Error('storage unreachable'); } }), /storage unreachable/);
  await assert.rejects(fetch(url, { ...options, [permit]: async () => ({ deadline: performance.now() - 1 }) }), /GRANT_EXPIRED/);
  assert.equal(calls.length, 0);
  await fetch(url);
  await fetch(url, { ...options, [permit]: async requestId => {
    assert.equal(requestId, 'request');
    return { deadline: performance.now() + 1000 };
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].redirect, 'error');
  assert.equal(calls[1][1][permit], undefined);
});

test('invalid or unavailable restoration cannot reuse a previously loaded baseline', async () => {
  let unavailable = false;
  const coordinator = createExecutionContinuity({ stateKey: 'state', command: async args => {
    if (unavailable) throw Error('storage unavailable');
    if (args[6] === 'LOAD') return { snapshot: '{}', revision: '0', checksum: 'old' };
    if (args[6] === 'SAVE') return { revision: '1', checksum: 'new', fence: 'fence' };
    assert.fail('Unexpected command');
  } });
  assert.equal(await coordinator.load(() => true), true);
  await coordinator.save('{}');
  unavailable = true;
  await assert.rejects(coordinator.load(() => true), /storage unavailable/);
  assert.equal(await coordinator.grant({ id: 'intent' }), 'WRITER_LEASE_UNVERIFIED');
  await assert.rejects(coordinator.save('{}'), /BASELINE_UNAVAILABLE/);
  unavailable = false;
  assert.equal(await coordinator.load(() => false), false);
  await assert.rejects(coordinator.save('{}'), /BASELINE_UNAVAILABLE/);
});

const lua = spawnSync('texlua', ['--version'], { encoding: 'utf8' });
test('atomic script handles competing owners, lost lease, controls, in-flight sends and restoration', { skip: Boolean(lua.error) }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'leo-execution-'));
  try {
    const file = join(directory, 'test.lua');
    writeFileSync(file, `
local script = assert(load([==[${SCRIPT}]==]))
local hash, values, objects = {}, {}, {}
local now, expiry, sequence = 0, 0, 0
cjson = { null = function() end }
cjson.encode = function(object)
  sequence = sequence + 1
  objects[tostring(sequence)] = object
  return tostring(sequence)
end
cjson.decode = function(key) return assert(objects[key], key) end
redis = { sha1hex = function(value) return value end }
redis.call = function(op, key, field, value, option)
  if op == 'GET' then
    if key == 'lease' and now >= expiry then return false end
    return values[key] or false
  end
  if op == 'SET' then
    values[key] = field
    if value == 'PX' then expiry = now + tonumber(option) end
    return 'OK'
  end
  if op == 'PTTL' then return now < expiry and expiry - now or -2 end
  if op == 'HGET' then return hash[field] or false end
  if op == 'HSET' then hash[field] = value; return 1 end
  if op == 'HEXISTS' then return hash[field] and 1 or 0 end
  if op == 'HDEL' then hash[field] = nil; return 1 end
  if op == 'HINCRBY' then
    hash[field] = tostring(tonumber(hash[field] or 0) + value)
    return tonumber(hash[field])
  end
  error(op)
end
KEYS = {'state','control','lease'}
local function run(...) ARGV = {...}; return script() end
local function decode(...) return cjson.decode(run(...)) end
local initial = decode('LOAD', 'a')
local buy = { status = 'ORDER_SENT', requestId = 'buy', type = 'BUY', orderProgress = cjson.null }
local sell = { status = 'ORDER_SENT', requestId = 'sell', type = 'SELL' }
local state = cjson.encode({ orderIntents = { b = buy, s = sell } })
local a = decode('SAVE', 'a', initial.revision, initial.checksum, state, 100)
assert(run('SAVE', 'b', initial.revision, initial.checksum, state, 100) == 'SNAPSHOT_STALE')
assert(run('SAVE', 'b', a.revision, a.checksum, state, 100) == 'WRITER_BUSY')
assert(run('CONTROL', 'operator', 'liquidation') == 'RECORDED')
assert(run('CONTROL', 'operator', 'entries') == 'RECORDED')
assert(run('GRANT', 'a', a.revision, a.checksum, a.fence, 'b', 'buy', 'BUY') == 'EXECUTION_PAUSED')
assert(run('GRANT', 'a', a.revision, a.checksum, a.fence, 's', 'wrong', 'SELL') == 'INTENT_NOT_DURABLE')
assert(run('GRANT', 'a', a.revision, a.checksum, a.fence, 's', 'sell', 'SELL') == 100)
assert(run('GRANT', 'a', a.revision, a.checksum, a.fence, 's', 'sell', 'SELL') == 'EXECUTION_IN_FLIGHT_OR_UNCERTAIN')
assert(run('CONTROL', 'operator', 'suspended') == 'RECORDED')
assert(decode('STATUS', 'a', a.fence).inFlight)
now = 101
assert(run('GRANT', 'a', a.revision, a.checksum, a.fence, 's', 'sell', 'SELL') == 'WRITER_LEASE_LOST')
local restored = decode('LOAD', 'b')
assert(restored.snapshot == state)
local b = decode('SAVE', 'b', restored.revision, restored.checksum, state, 100)
assert(a.fence ~= b.fence)
assert(run('SAVE', 'a', a.revision, a.checksum, state, 100) == 'SNAPSHOT_STALE')
local status = decode('STATUS', 'b', b.fence)
assert(status.ownLease and status.suspended and status.liquidationRequested and status.inFlight)
assert(run('GRANT', 'b', b.revision, b.checksum, b.fence, 's', 'sell', 'SELL') == 'EXECUTION_PAUSED')
sell.orderProgress = { verifiedForIntent = true, terminal = false, binding = 'MATCH' }
sell.positionProof = { matched = true }
b = decode('SAVE', 'b', b.revision, b.checksum, cjson.encode({ orderIntents = { s = sell } }), 100)
assert(decode('STATUS', 'b', b.fence).inFlight)
sell.orderProgress.terminal = true
sell.orderProgress.reviewRequired = true
b = decode('SAVE', 'b', b.revision, b.checksum, cjson.encode({ orderIntents = { s = sell } }), 100)
assert(decode('STATUS', 'b', b.fence).inFlight)
sell.orderProgress.reviewRequired = false
b = decode('SAVE', 'b', b.revision, b.checksum, cjson.encode({ orderIntents = { s = sell } }), 100)
assert(not decode('STATUS', 'b', b.fence).inFlight)
`);
    const result = spawnSync('texlua', [file], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
