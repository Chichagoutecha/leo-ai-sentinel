'use strict';

const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const SCRIPT = `
local stateKey, controlKey, leaseKey = KEYS[1], KEYS[2], KEYS[3]
local action, owner = ARGV[1], ARGV[2]
local revision = redis.call('HGET', controlKey, 'revision') or '0'
local lease = redis.call('GET', leaseKey)
local flight = redis.call('HGET', controlKey, 'flight')
local entries = redis.call('HGET', controlKey, 'entries') == '1'
local suspended = redis.call('HGET', controlKey, 'suspended') == '1'
if action == 'STATUS' then
  return cjson.encode({ writerActive = not not lease, ownLease = lease == ARGV[3],
    leaseRemainingMs = redis.call('PTTL', leaseKey), inFlight = not not flight,
    entriesBlocked = entries, suspended = suspended,
    liquidationRequested = redis.call('HEXISTS', controlKey, 'liquidation') == 1 })
end
if action == 'CONTROL' then
  local field = ARGV[3]
  if field ~= 'entries' and field ~= 'suspended' and field ~= 'liquidation' then return 'INVALID_CONTROL' end
  redis.call('HSET', controlKey, field, '1')
  return 'RECORDED'
end
local snapshot = redis.call('GET', stateKey)
local checksum = redis.sha1hex(snapshot or '')
if action == 'LOAD' then return cjson.encode({ snapshot = snapshot or cjson.null, revision = revision, checksum = checksum }) end
if revision ~= ARGV[3] or checksum ~= ARGV[4] then return 'SNAPSHOT_STALE' end
if action == 'SAVE' then
  if lease and string.sub(lease, 1, #owner + 1) ~= owner .. ':' then return 'WRITER_BUSY' end
  if not lease then
    local epoch = redis.call('HINCRBY', controlKey, 'epoch', 1)
    lease = owner .. ':' .. tostring(epoch)
  end
  local nextState = cjson.decode(ARGV[5])
  local resolved = false
  if flight then
    local sent = cjson.decode(flight)
    local intent = type(nextState.orderIntents) == 'table' and nextState.orderIntents[sent.id]
    local progress = type(intent) == 'table' and intent.orderProgress
    local proof = type(intent) == 'table' and intent.positionProof
    resolved = type(intent) == 'table' and intent.requestId == sent.requestId and type(progress) == 'table' and
      progress.verifiedForIntent == true and progress.binding == 'MATCH' and progress.reviewRequired ~= true and progress.terminal == true and type(proof) == 'table' and proof.matched == true
  end
  redis.call('SET', leaseKey, lease, 'PX', ARGV[6])
  redis.call('SET', stateKey, ARGV[5])
  local nextRevision = redis.call('HINCRBY', controlKey, 'revision', 1)
  if resolved then redis.call('HDEL', controlKey, 'flight') end
  return cjson.encode({ revision = tostring(nextRevision), checksum = redis.sha1hex(ARGV[5]), fence = lease })
end
if action == 'GRANT' then
  if not lease or lease ~= ARGV[5] or string.sub(lease, 1, #owner + 1) ~= owner .. ':' then return 'WRITER_LEASE_LOST' end
  if suspended or (entries and ARGV[8] == 'BUY') then return 'EXECUTION_PAUSED' end
  if flight then return 'EXECUTION_IN_FLIGHT_OR_UNCERTAIN' end
  if not snapshot then return 'INTENT_NOT_DURABLE' end
  local state = cjson.decode(snapshot)
  local intent = type(state.orderIntents) == 'table' and state.orderIntents[ARGV[6]]
  if type(intent) ~= 'table' or intent.status ~= 'ORDER_SENT' or intent.requestId ~= ARGV[7] or intent.type ~= ARGV[8] then
    return 'INTENT_NOT_DURABLE'
  end
  redis.call('HSET', controlKey, 'flight', cjson.encode({ id = ARGV[6], requestId = ARGV[7] }))
  return redis.call('PTTL', leaseKey)
end
return 'INVALID_ACTION'
`;

function createExecutionContinuity({ command, stateKey, leaseMs = 120000 }) {
  const owner = randomUUID();
  let baseline = null;
  let fence = null;
  const keys = [stateKey, stateKey + ':execution-control', stateKey + ':writer-lease'];
  const run = (action, ...args) => command(['EVAL', SCRIPT, keys.length, ...keys, action, owner, ...args]);
  const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
  return {
    async load(restore) {
      baseline = null;
      fence = null;
      const loaded = parse(await run('LOAD'));
      if (loaded.snapshot !== null && !restore(loaded.snapshot)) return false;
      baseline = { revision: loaded.revision, checksum: loaded.checksum };
      return loaded.snapshot !== null;
    },
    async save(payload) {
      if (!baseline) throw Error('PERSISTENT_BASELINE_UNAVAILABLE');
      const result = await run('SAVE', baseline.revision, baseline.checksum, payload, leaseMs);
      if (result === 'SNAPSHOT_STALE' || result === 'WRITER_BUSY') throw Error(result);
      const saved = parse(result);
      if (!saved?.fence || !saved.checksum || !saved.revision) throw Error('PERSISTENCE_UNVERIFIED');
      baseline = { revision: saved.revision, checksum: saved.checksum };
      fence = saved.fence;
    },
    async grant({ id, requestId, side }) {
      if (!baseline || !fence) return 'WRITER_LEASE_UNVERIFIED';
      const startedAt = performance.now();
      const result = await run('GRANT', baseline.revision, baseline.checksum, fence, id, requestId, side);
      return typeof result === 'number' ? { deadline: startedAt + result } : result;
    },
    async control(field) {
      return (await run('CONTROL', field)) === 'RECORDED';
    },
    async status() {
      return parse(await run('STATUS', fence || ''));
    }
  };
}

class ExecutionNotSent extends Error {}

const permit = Symbol('execution-permit');

function guardExecutionFetch(fetch) {
  return async (url, init = {}) => {
    let target;
    try { target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url); }
    catch { return fetch(url, init); }
    const method = String(init.method || url.method || 'GET').toUpperCase();
    if (target.origin !== 'https://public-api.etoro.com' ||
        !/^\/api\/v[0-9]+\/trading\/execution\//.test(target.pathname) ||
        ['GET', 'HEAD'].includes(method)) return fetch(url, init);
    const grant = init[permit];
    if (!grant || init.signal?.aborted) throw new ExecutionNotSent('EXECUTION_PERMISSION_UNAVAILABLE');
    const result = await grant(new Headers(init.headers).get('x-request-id'));
    if (typeof result === 'string') throw new ExecutionNotSent(result);
    if (!Number.isFinite(result?.deadline) || performance.now() >= result.deadline || init.signal?.aborted) {
      throw Error('EXECUTION_GRANT_EXPIRED');
    }
    const { [permit]: consumed, ...request } = init;
    return fetch(url, { ...request, redirect: 'error' });
  };
}

module.exports = { createExecutionContinuity, SCRIPT, guardExecutionFetch, permit, ExecutionNotSent };
