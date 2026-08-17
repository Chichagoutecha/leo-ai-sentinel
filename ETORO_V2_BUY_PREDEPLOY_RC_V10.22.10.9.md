# LEO-AI SENTINEL — eToro v2 BUY Predeploy RC v10.22.10.9

## Purpose

This branch is a **pre-deployment release candidate only**. It sits directly on the green v10.22.10.8 runtime migration head (`7a43d645575401ba6824f58f067a4eb340d36701`) and intentionally adds no runtime, package, Render, strategy, sizing, or LIVE-authority change.

## What is being validated

1. `index.js` remains byte-identical to the exact v10.22.10.7 validated transform already applied in PR #43.
2. The default production start command uses only the hardened AI preload chain:
   - `ai-cost-optimizer.js`
   - `ai-luna-temperature-compat.js`
   - `ai-context-optimizer.js`
   - `production-ai-preflight.js`
   - `index.js`
3. Legacy/new eToro diagnostic helpers and the passive observer remain outside the default production start command.
4. `LIVE_EXECUTION_ARMED` remains a separate explicit environment gate.
5. REAL portfolio preflight, persistent BUY intent creation, `ORDER_SENT`, `retries: 0`, post-order portfolio verification and evidence-based cooldown remain present.
6. BUY has exactly one execution transport: the current eToro v2 unified-order route; the deprecated v1 by-amount BUY route is absent from `index.js`.
7. Full stacked eToro and production-AI regressions remain green.

## Important repository finding

The repository default branch `main` is not a safe direct promotion target for this eToro patch. At the time this RC was created, #43 is 81 commits ahead of `main`, and `main/package.json` still uses the older preload command containing `etoro-execution-diagnostics.js`. The v10.22.10.8 branch instead uses the hardened production preload chain above.

Therefore this RC deliberately targets the validated #43 lineage, not `main`.

## Render boundary

There is no tracked `render.yaml` or `render.yml` in this lineage. GitHub alone therefore cannot prove:

- which Git branch the Render service currently deploys;
- whether Render Auto-Deploy is enabled;
- the current values of `TRADING_MODE`, `AUTO_TRADE`, `ALLOW_LEGACY_AUTO_TRADE`, `LIVE_EXECUTION_ARMED`, portfolio identity variables, or eToro credentials;
- whether a deploy hook or manual deploy is configured.

Those values must be checked in Render **before any deployment action**.

## Required Render state before a controlled deployment

No deployment is authorized by this document. Before a later explicit deployment approval, verify in Render that:

- the service branch is identified and intentionally selected;
- Auto-Deploy behavior is known;
- `LIVE_EXECUTION_ARMED` is **not enabled for the first deployment validation**;
- no legacy environment combination can unexpectedly move the bot into LIVE without deliberate intent;
- required eToro portfolio identity variables are present and correspond to the intended REAL portfolio;
- the start command resolves to the repository `package.json` start script unless an explicit override has been reviewed.

## Promotion rule

A green v10.22.10.9 RC means only that the GitHub candidate is technically ready for a **Render configuration audit**. It does not authorize merging to `main`, changing Render's branch, deploying, enabling Auto-Deploy, arming LIVE, or sending any eToro order.
