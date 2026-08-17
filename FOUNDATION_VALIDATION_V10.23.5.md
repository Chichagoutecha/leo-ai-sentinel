# LEO-AI SENTINEL v10.23.5 — Foundation Validation Cockpit

## Purpose

This layer does **not** trade. It aggregates the already-exposed state of roadmap stages 1–5 and turns it into explicit technical and empirical gates.

It exists to prevent two failure modes:

1. calling a stage “finished” because its code exists while the real-world proof is still missing;
2. stacking research modules on top of an unsafe execution preload.

No merge to `main`, no Render change and no LIVE promotion is authorized by this branch.

## Stage gates

### Stage 1 — eToro execution safety

Technical gate passes only when the loaded diagnostic reports:

- `breakerScope: NEW_OPEN_ORDERS_ONLY`
- `closeAndReduceRoutesNeverBlocked: true`

This is the v10.22.10 safety invariant. The legacy v10.22.8 diagnostic fails this gate because its breaker can intercept every execution write.

Even after the technical gate passes, empirical proof remains separate: a LIVE order must be business-acknowledged and then independently proven by a portfolio re-read. HTTP 2xx alone is not proof.

### Stage 2 — Shadow Intelligence Lab

Technical gate requires Shadow-only behavior with trading disabled and OpenAI disabled.

Calibration sample targets are intentionally modest first gates, not claims of statistical significance:

- J+1: 20 evaluated signals
- J+3: 15
- J+7: 10
- J+30: 5

The cockpit reports collection progress without changing the strategy.

### Stage 3 — Alpaca independent validator

Technical gate requires a provider-decoupled, research-only validator with no network client inside the validator module.

Initial calibration gate:

- at least 30 paired validations;
- at least 70% `CONFIRMED`;
- no more than 10% `DIVERGENT`.

These thresholds are calibration alarms, not a trading rule. Divergent prices are never averaged.

### Stage 4 — Quartr Fundamental Intelligence

Technical gate requires the research-only module to remain unable to trade or authorize LIVE.

Real connector/schema validation is still externally blocked until Quartr Pro access is available. Synthetic unit tests do not substitute for real connector validation.

### Stage 5 — Exa News & Catalyst

Technical gate requires research-only behavior, no embedded network client, and no execution of external instructions.

Initial source-quality sample target:

- at least 30 analyzed events;
- at least 5 `CONFIRMED_CATALYST` or `PRIMARY_SOURCE_CATALYST` events.

This does **not** complete predictive calibration. News value still has to be measured against later market outcomes.

## Stage 6 policy

`stage6ShadowBuildAllowed` is true only when all five technical gates are green in the same process.

This permits **Shadow development only**. It never authorizes LIVE promotion. LIVE promotion remains hard-coded false in the cockpit and requires a separate validation decision.

## Current integration rehearsal

The rehearsal branch now copies the exact v10.22.10 safe diagnostic and its dedicated tests from Stage 1, then changes the rehearsal `start` command to preload `etoro-execution-diagnostics-v10.22.10.js` instead of the legacy v10.22.8 diagnostic.

This is deliberately **not** a production merge. The purpose is to prove that the Stage 1 safety invariant and the Stage 2–5 Shadow stack can coexist before any separate LIVE validation decision.

The cockpit must report Stage 1 technical readiness only when the loaded diagnostic exposes `NEW_OPEN_ORDERS_ONLY` and confirms close/reduce routes can never be breaker-blocked. True eToro portfolio proof remains pending until a real accepted order is followed by a portfolio re-read.

## Cost and safety

The cockpit makes:

- 0 network calls;
- 0 eToro calls;
- 0 OpenAI calls;
- 0 strategy changes;
- 0 sizing changes;
- 0 LIVE allowlist changes;
- 0 automatic promotions.

It only reads globals exposed by the already-loaded modules and emits compact validation snapshots.
