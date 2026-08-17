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

## Current integration rehearsal expectation

The v10.23.4 research stack still preloads the legacy `etoro-execution-diagnostics.js`. Therefore the first cockpit snapshot is expected to mark Stage 1 as `INTEGRATION_BLOCKED` until the v10.22.10 safe diagnostic is integrated into the stacked rehearsal branch.

That failure is intentional and useful: the cockpit must expose unsafe composition rather than hide it.

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
