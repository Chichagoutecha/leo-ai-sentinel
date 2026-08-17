# Production Entrypoint Hygiene — v10.22.9.2

## Problem found
The currently running Render service is explicitly configured with the validated command:

`node -r ./ai-cost-optimizer.js -r ./ai-luna-temperature-compat.js index.js`

However, repository `main/package.json` was stale in two important ways:

1. `npm start` still preloaded the legacy `etoro-execution-diagnostics.js` v10.22.8, whose breaker scope is known to be too broad for production promotion.
2. `npm test` referenced `test-v10.10.js`, a file that does not exist on current `main`, so a clean repository test command would fail immediately.
3. The repository default start command did not include the GPT-5.6 Luna temperature compatibility shim that is currently required by the validated Render deployment.

The Render override means the currently running service is not using the stale `npm start`. This PR is repository hygiene to prevent a future deploy/operator from accidentally falling back to the unsafe/stale defaults.

## Proposed script alignment
- `npm start`: AI Cost Optimizer → Luna compatibility → `index.js`, matching the currently validated Render command.
- `npm run check`: syntax-check production entrypoint and both active AI preloads/tests.
- `npm test`: run the Luna compatibility unit suite that exists on `main`.
- `npm run test:ai-preload`: run the optimizer + Luna end-to-end preload regression.

## Deliberate exclusion
The legacy eToro diagnostic preload is removed from the default repository start command. The safer Stage 1 v10.22.10 diagnostic remains in its separate DRAFT validation path and is **not** introduced here.

## Safety
This PR changes only repository scripts/documentation/CI. It does not modify:
- `index.js`;
- strategy or sizing;
- eToro execution code;
- `LIVE_EXECUTION_ARMED`;
- Render configuration;
- OpenAI budget values.

It remains DRAFT until separately reviewed for production merge.