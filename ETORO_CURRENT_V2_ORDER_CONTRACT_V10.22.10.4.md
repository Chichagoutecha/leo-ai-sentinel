# LEO-AI SENTINEL v10.22.10.4 — Current eToro v2 order contract

Status: **DRAFT / Shadow contract only / no LIVE authority**.

## Production evidence that triggered this audit
On 2026-08-17 at 16:00Z, LEO autonomously selected BUY GLD for 523.95 USD with 92% confidence and risk approval. The existing v1 by-amount execution returned no confirmed order/position. Reconciliation stayed `EXECUTION_UNCERTAIN` through 16:20Z and resolved to `ORDER_NO_EFFECT` at 16:35Z with positions still 0 and cash unchanged at 9981.45 USD.

## Documentation finding
The current eToro documentation index lists **Create an order** in the current Trading - Real API and places the old **Open market order by cash amount** and **Open market order by units** references in the deprecated API section. Current eToro Builders material identifies the unified real execution route as:

`POST https://public-api.etoro.com/api/v2/trading/execution/orders`

with a market-open amount shape based on lowercase fields such as `action`, `transaction`, `instrumentId`, `orderType`, `amount`, `orderCurrency`, and `leverage`.

The older market-orders guide still describes the v1 `market-open-orders/by-amount` route, so the public documentation is not perfectly synchronized. For safety, this PR treats v2 as a **migration candidate requiring controlled validation**, not as permission to change LIVE immediately.

## What this PR does
- encodes the current unified-order route and documented market BUY payload as pure functions;
- explicitly classifies the two old v1 market-open routes as deprecated migration inputs;
- fails closed on invalid instrument ID, amount, leverage or unsupported currency;
- never accepts HTTP 2xx alone as business proof;
- recognizes token/order/position/reference evidence in top-level or `data` response shapes;
- makes zero network calls and zero eToro execution calls.

## What this PR does NOT do
- does not change `index.js`;
- does not change Render;
- does not send a v2 order;
- does not add fallback or dual-submit behavior;
- does not alter strategy, sizing or LIVE arming;
- does not merge or promote anything to production.

## Critical migration rule
There must never be a same-cycle fallback that submits both the legacy v1 route and the v2 route. A future migration must select exactly one execution transport for an intent, preserve the existing intent/reconciliation guard, and require portfolio/order evidence before any retry.

## Next gate
Build a separate DRAFT integration patch for `executeBuy` using the v2 contract, with mocked transport and reconciliation tests. Only after that passes may a controlled LIVE/main migration be proposed for separate authorization.
