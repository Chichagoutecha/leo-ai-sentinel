# LEO-AI SENTINEL v10.23.5 — Foundation Runtime Preflight

## Why this exists

The Stage 1–5 integration rehearsal can be technically correct on paper and still be unsafe if Render/Node loads the wrong preload composition. Two concrete production lessons are now encoded as regression gates:

1. the legacy v10.22.8 eToro diagnostic must never be used in the combined rehearsal because its ambiguity breaker can intercept close/reduce execution routes;
2. GPT-5.6 Luna must receive the validated temperature-compatibility shim after the AI cost optimizer, because the optimizer can force-route an older requested model name to Luna.

This preflight checks the **actual Node `-r/--require` preload order** in the running rehearsal process. It does not trust the version string in `index.js` as proof of what auxiliary modules are loaded.

## Required order

The combined rehearsal requires, at minimum:

1. `etoro-execution-diagnostics-v10.22.10.js`
2. `ai-cost-optimizer.js`
3. `ai-luna-temperature-compat.js`
4. Shadow research modules
5. `foundation-calibration-bench.js`
6. `foundation-validation-cockpit.js`
7. `foundation-runtime-preflight.js`
8. `index.js`

The preflight fails closed if the legacy `etoro-execution-diagnostics.js` is present or if the optimizer is loaded after the Luna shim.

## Runtime checks

The preflight verifies without network access:

- safe eToro breaker scope is `NEW_OPEN_ORDERS_ONLY`;
- close/reduce routes are declared never blocked by the diagnostic;
- AI cost optimizer preload is present;
- Luna compatibility preload is present and ordered after the optimizer;
- the Luna sanitizer really removes explicit `temperature` when the effective forced model is GPT-5.6 Luna;
- the caller request object is not mutated by the sanitizer;
- all Stage 2–5 research state surfaces, Calibration Bench and Validation Cockpit are loaded.

`readyForStage1To5IntegrationRehearsal` becomes true only when every check passes in the same process.

## What it does NOT authorize

Even a fully green preflight does **not** authorize LIVE promotion.

`readyForLivePromotion` is hard-coded to `false` because the independent empirical gates remain:

- true eToro business acknowledgement plus portfolio re-read proof;
- Shadow J+1/J+3/J+7/J+30 outcomes;
- enough paired eToro/Alpaca observations;
- real Quartr connector validation when access exists;
- Exa predictive-value calibration on subsequent outcomes.

## Safety contract

The module performs:

- 0 network calls;
- 0 market-data calls;
- 0 eToro execution calls;
- 0 OpenAI calls;
- 0 strategy mutations;
- 0 sizing mutations;
- 0 `LIVE_EXECUTION_ARMED` mutations;
- 0 automatic LIVE promotion.

It is observability and regression protection only.
