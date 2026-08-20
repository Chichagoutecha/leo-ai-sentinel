'use strict';

/**
 * DEMO-ONLY eToro execution probe.
 *
 * Safety properties:
 * - never reads ETORO_USER_KEY;
 * - requires ETORO_DEMO_USER_KEY;
 * - hardcodes DEMO PnL and DEMO execution endpoints;
 * - defaults to read-only / dry-run;
 * - requires ETORO_DEMO_TEST_ARMED=true before POSTing an order.
 *
 * This script is intentionally isolated from Sentinel's LIVE decision engine.
 */

const { randomUUID } = require('crypto');

const API_ORIGIN = 'https://public-api.etoro.com';
const DEMO_PNL_URL = `${API_ORIGIN}/api/v1/trading/info/demo/pnl`;
const DEMO_OPEN_BY_AMOUNT_URL = `${API_ORIGIN}/api/v1/trading/execution/demo/market-open-orders/by-amount`;
const DEFAULT_INSTRUMENT_ID = 100109; // BTC in Sentinel's current watchlist.
const DEFAULT_AMOUNT_USD = 10;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} manquante`);
  return value;
}

function headers(apiKey, demoUserKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'x-user-key': demoUserKey,
    'x-request-id': randomUUID()
  };
}

async function readResponse(response) {
  const raw = await response.text();
  let data = null;
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw: raw.slice(0, 4000) };
    }
  }
  return { raw, data };
}

function listPositions(pnl) {
  const direct = Array.isArray(pnl?.positions) ? pnl.positions : [];
  const mirrors = Array.isArray(pnl?.mirrors) ? pnl.mirrors : [];
  const mirrored = mirrors.flatMap((mirror) => Array.isArray(mirror?.positions) ? mirror.positions : []);
  return [...direct, ...mirrored];
}

function instrumentIdOf(position) {
  return Number(
    position?.instrumentID ??
    position?.instrumentId ??
    position?.InstrumentID ??
    position?.InstrumentId
  );
}

function compactPnl(pnl, instrumentId) {
  const positions = listPositions(pnl);
  const matching = positions.filter((position) => instrumentIdOf(position) === instrumentId);
  return {
    credit: Number.isFinite(Number(pnl?.credit)) ? Number(pnl.credit) : null,
    positionsCount: positions.length,
    matchingInstrumentPositions: matching.length,
    matchingPositionIds: matching
      .map((position) => position?.positionID ?? position?.positionId ?? position?.PositionID ?? position?.PositionId ?? null)
      .filter((value) => value != null)
      .slice(0, 20)
  };
}

async function fetchDemoPnl(apiKey, demoUserKey) {
  const response = await fetch(DEMO_PNL_URL, {
    method: 'GET',
    headers: headers(apiKey, demoUserKey)
  });
  const { data } = await readResponse(response);
  return { response, data };
}

async function main() {
  const apiKey = requiredEnv('ETORO_API_KEY');
  const demoUserKey = requiredEnv('ETORO_DEMO_USER_KEY');
  const armed = String(process.env.ETORO_DEMO_TEST_ARMED || '').toLowerCase() === 'true';
  const instrumentId = Number(process.env.ETORO_DEMO_TEST_INSTRUMENT_ID || DEFAULT_INSTRUMENT_ID);
  const amountUsd = Number(process.env.ETORO_DEMO_TEST_AMOUNT_USD || DEFAULT_AMOUNT_USD);

  if (!Number.isInteger(instrumentId) || instrumentId <= 0) {
    throw new Error('ETORO_DEMO_TEST_INSTRUMENT_ID invalide');
  }
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 100) {
    throw new Error('ETORO_DEMO_TEST_AMOUNT_USD doit être > 0 et <= 100 pour ce probe');
  }

  const before = await fetchDemoPnl(apiKey, demoUserKey);
  console.log(JSON.stringify({
    probe: 'ETORO_DEMO_EXECUTION',
    stage: 'DEMO_READ_PREFLIGHT',
    endpoint: DEMO_PNL_URL,
    httpStatus: before.response.status,
    httpOk: before.response.ok,
    instrumentId,
    amountUsd,
    armed,
    portfolio: before.response.ok ? compactPnl(before.data, instrumentId) : null,
    error: before.response.ok ? null : before.data
  }));

  if (!before.response.ok) {
    process.exitCode = 2;
    return;
  }

  if (!armed) {
    console.log(JSON.stringify({
      probe: 'ETORO_DEMO_EXECUTION',
      stage: 'DRY_RUN_COMPLETE',
      orderSent: false,
      reason: 'ETORO_DEMO_TEST_ARMED n’est pas true',
      nextRequiredScope: 203,
      endpointThatWouldBeCalled: DEMO_OPEN_BY_AMOUNT_URL,
      payload: {
        InstrumentId: instrumentId,
        Amount: amountUsd,
        Leverage: 1,
        IsBuy: true
      }
    }));
    return;
  }

  const requestHeaders = headers(apiKey, demoUserKey);
  const payload = {
    InstrumentId: instrumentId,
    Amount: amountUsd,
    Leverage: 1,
    IsBuy: true
  };

  const orderResponse = await fetch(DEMO_OPEN_BY_AMOUNT_URL, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(payload)
  });
  const orderBody = await readResponse(orderResponse);

  console.log(JSON.stringify({
    probe: 'ETORO_DEMO_EXECUTION',
    stage: 'DEMO_ORDER_RESPONSE',
    endpoint: DEMO_OPEN_BY_AMOUNT_URL,
    requestId: requestHeaders['x-request-id'],
    httpStatus: orderResponse.status,
    httpOk: orderResponse.ok,
    payload,
    response: orderBody.data
  }));

  if (!orderResponse.ok) {
    process.exitCode = 3;
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await fetchDemoPnl(apiKey, demoUserKey);
  const beforeCompact = compactPnl(before.data, instrumentId);
  const afterCompact = after.response.ok ? compactPnl(after.data, instrumentId) : null;

  console.log(JSON.stringify({
    probe: 'ETORO_DEMO_EXECUTION',
    stage: 'DEMO_POST_ORDER_VERIFY',
    httpStatus: after.response.status,
    httpOk: after.response.ok,
    before: beforeCompact,
    after: afterCompact,
    observedPositionCountIncrease: Boolean(
      afterCompact && afterCompact.matchingInstrumentPositions > beforeCompact.matchingInstrumentPositions
    ),
    note: 'Une absence de variation immédiate ne prouve pas un échec; conserver le requestId et vérifier eToro avant toute répétition.'
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    probe: 'ETORO_DEMO_EXECUTION',
    stage: 'PROBE_ERROR',
    error: error && error.message ? error.message : String(error),
    realUserKeyRead: false
  }));
  process.exitCode = 1;
});
