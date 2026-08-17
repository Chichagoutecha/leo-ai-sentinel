# LEO-AI SENTINEL v10.22.10.6 — eToro v2 Persistent Intent Shadow

Status: **SHADOW / persistent-state compatibility / no provider transport / no LIVE authority**.

## Purpose
This gate proves that the audited eToro v2 unified BUY contract can fit LEO's existing persistent execution-intent state machine without changing the production runtime.

The production runtime already persists and reconciles these execution states:
- `ORDER_INTENT_CREATED`
- `ORDER_SENT`
- `ORDER_ACCEPTED_BY_ETORO`
- `POSITION_CONFIRMED`
- `ORDER_REJECTED`
- `POSITION_NOT_FOUND`
- `ORDER_NO_EFFECT`
- `EXECUTION_UNCERTAIN`
- `DUPLICATE_BLOCKED`

The bridge mirrors those exact values and uses the existing v2 contract serializer from v10.22.10.4.

## Shadow rules
1. Only a `LIVE` `BUY` intent in `ORDER_INTENT_CREATED` may produce a first v2 request plan.
2. An intent already `ORDER_SENT`, accepted, not found or uncertain can never produce a second submission plan.
3. Any other active LIVE intent blocks a new first submission until reconciliation closes it.
4. `leverage` must equal `1`.
5. A stable `x-request-id` is mandatory and is bound to the persistent intent in a deterministic fingerprint.
6. The request plan uses only `POST /api/v2/trading/execution/orders` and the unified lowercase payload.
7. The bridge has no built-in network transport and cannot call eToro.
8. A v2 response containing token/order/position/reference identifiers may acknowledge the order, but does not by itself confirm a portfolio position.
9. Fresh independent portfolio evidence remains authoritative: a confirmed new position maps to `POSITION_CONFIRMED`; a completed unchanged portfolio check maps to `POSITION_NOT_FOUND` even if the provider response carried an acknowledgement.
10. An ambiguous 2xx plus unavailable portfolio verification maps to `EXECUTION_UNCERTAIN`.
11. No ambiguous, accepted, not-found or uncertain result permits an automatic retry.
12. There is no v1 fallback and no dual-submit path.

## Production invariants
This gate does not modify:
- `index.js`
- `package.json`
- Render configuration
- the current production start command
- the current LIVE BUY route

Therefore this PR cannot place a v2 order and cannot change current LIVE behavior.

## Next gate
After this Shadow bridge and all existing execution-safety regressions are green, the next change may prepare a **production migration patch in DRAFT** that replaces only the old v1 BUY transport/payload inside `executeBuy` while preserving the current preflight, persistent intent, request-id, post-order verification, reconciliation, cooldown and no-retry logic. That production patch must remain separately reviewed and must not be activated merely by merging this Shadow gate.
