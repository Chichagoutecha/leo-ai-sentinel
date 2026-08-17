# LEO-AI SENTINEL v10.22.10.7 — eToro v2 BUY Production Migration DRAFT

Status: **DRAFT transformer / candidate copy only / production runtime unchanged / no LIVE activation**.

## Why this gate exists
The v2 contract, one-shot integration boundary and persistent-intent mapping are already validated in the preceding stacked gates. Before editing the real runtime, this gate generates the exact prospective `index.js` candidate in CI and compiles/tests that copy.

A compatibility issue was found during review: the current production response compactor preserves `orderId`, `positionId` and `statusId`, but not the v2 `token` or `referenceId`. A migration that changed only the URL and request payload could therefore discard valid v2 acknowledgement evidence.

## Exactly four simulated replacements
The transformer requires exactly one match for each source fragment and refuses to continue if the source has drifted.

1. Extend `compactEtoroExecutionResponse` to preserve `token` and `referenceId`.
2. Extend `hasExecutionBusinessAcknowledgement` to recognize `token` and `referenceId`.
3. Replace the legacy BUY endpoint:
   - from `/api/v1/trading/execution/market-open-orders/by-amount`
   - to `/api/v2/trading/execution/orders`
4. Replace the legacy request body with the unified v2 BUY market-order body:
   - `action: "open"`
   - `transaction: "buy"`
   - `instrumentId`
   - `orderType: "mkt"`
   - `amount: safeAmount`
   - `orderCurrency: "usd"`
   - `leverage: 1`

## What is deliberately preserved
The candidate transformation explicitly checks that these protections remain present with identical occurrence counts:
- REAL portfolio preflight;
- `LIVE_EXECUTION_ARMED` gate;
- persistent `createOrderIntent`;
- `ORDER_SENT` before provider submission;
- exactly `retries: 0` for the LIVE BUY provider call;
- independent `verifyPortfolioAfterExecution`;
- persistent reconciliation after uncertain/not-found outcomes;
- cooldown only after business acknowledgement or observed portfolio effect;
- duplicate-intent blocking;
- existing sizing/risk/strategy logic;
- SELL path byte-identical from `executeSell` onward.

## No production mutation
`etoro-v2-buy-production-migration-draft.js` refuses input and output paths that are identical. The pull request does not modify `index.js`, `package.json` or Render. CI generates `/tmp/index-v2-buy-production-draft.js`, validates its syntax and audits its diff, then discards it with the runner.

## Promotion rule
A green result here means only that the exact candidate patch is mechanically compatible with the current code and existing safety regressions. It does **not** authorize LIVE execution.

The following step, if separately approved, can apply these exact four changes to a dedicated runtime branch. That applied branch should still remain DRAFT and undergo another production-safety gate before any merge/deploy decision.
