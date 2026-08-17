# LEO-AI SENTINEL v10.22.10.5 — eToro v2 BUY integration DRAFT

Status: **DRAFT / mocked transport integration / no production routing / no LIVE authority**.

## Purpose
This gate turns the v10.22.10.4 unified-order contract into an executable integration boundary without connecting it to `index.js` or to eToro by default.

The current official eToro Builders material documents real market execution through:

`POST https://public-api.etoro.com/api/v2/trading/execution/orders`

The production runtime still uses the legacy v1 path. This DRAFT intentionally does not replace it yet.

## What is added
- `executeBuyV2Draft(...)` consuming the audited v2 serializer from v10.22.10.4;
- injected transport only: there is no built-in `fetch` and therefore no default eToro network authority;
- mandatory intent guard before any transport call;
- duplicate intent blocking before a second submission can occur;
- exactly one transport attempt per invocation;
- no automatic retry after an ambiguous 2xx or transport exception;
- classification of eToro response evidence using token/order/position/reference identifiers;
- injected reconciliation hook to confirm portfolio/order evidence after the response;
- fail-closed `EXECUTION_UNCERTAIN` when neither the response nor reconciliation proves execution;
- mocked tests covering confirmation, ambiguity, duplicate blocking, invalid sizing, absent transport and transport exceptions.

## Safety invariants
1. `index.js` is unchanged.
2. Render configuration is unchanged.
3. No default network transport exists in the integration module.
4. No same-cycle fallback from v2 to v1 exists.
5. The same intent cannot be submitted twice through the DRAFT guard.
6. A 2xx response alone is never enough to mark a position confirmed.
7. A network exception after a possible send is treated as uncertain and is never automatically retried.
8. LIVE promotion requires a separate authorization and a separate production patch.

## Local validation before publication
The isolated DRAFT suite passed 7/7 tests with Node's built-in test runner before the branch was published.

## Next gate after CI
If this DRAFT and the existing execution-safety regressions are green, the next proposal may adapt the existing persistent intent/reconciliation machinery in `index.js` to this v2 boundary while still keeping the real v2 transport disabled. Only after that shadow wiring is reviewed should a one-transport production migration be considered.
