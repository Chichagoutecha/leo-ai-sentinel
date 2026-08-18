# LEO-AI SENTINEL v10.22.11.0 — Clean eToro v2 Production RC

## Purpose
Prepare a minimal production promotion from the current `main` branch without carrying the stacked eToro DRAFT/shadow scaffolding into production.

## Runtime files promoted from the already-green v10.22.10.9 predeploy RC
- `index.js` — exact validated eToro v2 BUY runtime (`+14/-2` versus current main).
- `ai-cost-optimizer.js` — concurrency/missing-usage hardened cost guard.
- `ai-context-optimizer.js` — fail-safe decision-context compaction.
- `production-ai-preflight.js` — startup composition guard.
- `package.json` — canonical hardened production preload chain.

`ai-luna-temperature-compat.js` is already byte-identical on `main`, so it is not changed by this RC.

## Canonical Render Start Command after promotion
`node -r ./ai-cost-optimizer.js -r ./ai-luna-temperature-compat.js -r ./ai-context-optimizer.js -r ./production-ai-preflight.js index.js`

The currently configured Render command omits the final two preloads. Do not change the Render Start Command until this code exists on the branch/commit intended for deployment.

## eToro execution invariants
- real BUY transport: `POST /api/v2/trading/execution/orders` only;
- deprecated v1 BUY-by-amount endpoint absent from runtime;
- no automatic retry (`retries: 0`);
- persistent execution intent created before provider transport;
- duplicate/unresolved intent protection retained;
- REAL portfolio preflight retained;
- independent post-order portfolio verification retained;
- v2 `token` and `referenceId` retained as provider acknowledgement evidence;
- SELL path, strategy and sizing are not intentionally changed by the v2 transport migration.

## Render boundary
Observed service configuration before this RC:
- linked branch: `main`;
- Auto-Deploy: `Off`;
- Build Command: `npm install`;
- current custom Start Command: `node -r ./ai-cost-optimizer.js -r ./ai-luna-temperature-compat.js index.js`;
- LIVE-related environment values remain under separate Render control.

This RC does not modify Render, does not merge to `main`, does not trigger a deploy and does not send an eToro order.

## Promotion gates
1. Clean RC CI must be green.
2. Separate explicit authorization is required before merging this PR into `main`.
3. Because Render Auto-Deploy is Off, merging alone is not deployment authority.
4. After merge, update the Render Start Command to the canonical four-preload command.
5. Trigger a manual deploy only as a separate deployment action.
6. Validate startup logs and eToro portfolio identity before relying on the new LIVE transport.
