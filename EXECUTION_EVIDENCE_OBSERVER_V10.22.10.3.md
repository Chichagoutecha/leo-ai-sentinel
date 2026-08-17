# LEO-AI SENTINEL v10.22.10.3 — Execution Evidence Observer

## Objective

Prepare the next natural LIVE execution for independent evidence collection **without placing a test order and without changing trading behavior**.

The observer wraps the existing `fetch` chain and correlates:

1. an already-existing eToro market-open request;
2. the most recent already-existing `GET /api/v1/trading/info/real/pnl` baseline;
3. later P&L reads already performed by LEO.

It never performs an additional API request.

## Evidence classes

- `POSITION_EVIDENCE`: a new position ID appears, or the position count for the requested instrument increases.
- `ORDER_EVIDENCE`: a new order ID appears, or the order count for the requested instrument increases.
- `NO_EFFECT_OBSERVED`: several later P&L snapshots show no position/order effect. This is explicitly **non-definitive** and does not authorize a retry by itself.
- `INSUFFICIENT_BASELINE`: the observer did not have a sufficiently recent pre-order P&L snapshot.
- `LOCAL_BLOCK_IGNORED`: the exact-open ambiguity breaker blocked the request locally, so the observer does not create a pending execution record.

## Safety invariants

- provider calls added: **0**;
- requests blocked: **0**;
- responses mutated: **0**;
- strategy modified: **false**;
- sizing modified: **false**;
- `LIVE_EXECUTION_ARMED` modified: **false**;
- `canTrade`: **false**;
- `canAuthorizeLive`: **false**.

The observer is a measurement layer only. It does not replace LEO's existing ExecutionVerifier and it does not treat an HTTP 2xx as proof of execution.

## eToro API grounding

The official eToro documentation identifies the two market-open creation endpoints as POST `market-open-orders/by-amount` and POST `market-open-orders/by-units`. Portfolio state is read through the real P&L endpoint. The observer only watches calls LEO already makes; it does not consume additional rate-limit quota.

## Promotion gate

This module must remain outside the default production start command until separately authorized. Before any activation:

1. unit/integration CI must be green;
2. `index.js` and `package.json` must remain unchanged from the parent safety release candidate;
3. no provider/network call may be introduced by the observer;
4. a real natural execution cycle must be reviewed together with the existing ExecutionVerifier and safe eToro diagnostic;
5. success requires position/order portfolio evidence, not HTTP status alone.

## Rollback

Because the module is a preload-only observer, rollback is simply removing its `-r` preload entry if it is ever separately activated. No persisted trading state or strategy migration is required.
