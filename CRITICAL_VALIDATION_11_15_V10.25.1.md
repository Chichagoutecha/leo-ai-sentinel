# Critical Shadow Validation — stages 11–15

## Purpose
Stress the highest-priority roadmap layers together before any production promotion. This branch remains Shadow/research-only and is stacked on the full 6–15 integration rehearsal.

## Deterministic scenario matrix
The validation harness runs without network access, provider credentials, OpenAI or eToro execution:

- `GOLDILOCKS`: broad growth, contained inflation, easy credit/volatility conditions.
- `INFLATION_SHOCK`: elevated CPI/core inflation, oil shock, rising front-end yields.
- `CREDIT_CRUNCH`: weak growth, wide credit spreads, high volatility, poor breadth.
- `FOMC_WINDOW`: macro/market neutral-ish but inside an explicit FOMC event-risk window.

Each scenario passes through Stage 12 Macro Intelligence → Stage 13 Event Risk → Stage 11 Market Regime 2.0. Portfolio/risk validation then exercises Stages 14 and 15 on deterministic calm and crisis return panels.

## Acceptance invariants
1. Macro regime inputs require sufficient coverage and at least two independent source groups.
2. Market-regime probabilities must sum to ~1.
3. Inflation/credit stress cannot produce a looser Shadow risk multiplier than the goldilocks baseline in the fixed scenario set.
4. FOMC risk may block a new BUY but must never gain SELL/trading authority.
5. Portfolio target weights must sum to 1 and obey the configured per-asset cap.
6. An infeasible portfolio cap must fail closed as `INCONCLUSIVE`; it must never silently violate the cap.
7. Institutional risk must reject incomplete history for any positively weighted asset.
8. Institutional risk must reject a missing stress-test set and reject stress scenarios that omit any positively weighted asset.
9. Invalid timestamps, malformed top-level payloads and invalid numeric options must never crash stages 11–15.
10. Non-finite return values must never leak `NaN`/`Infinity` into portfolio or institutional-risk metrics.
11. Crisis risk must not be scored safer than the calm deterministic panel.
12. Every layer remains `canTrade:false`, `canAuthorizeLive:false`; harness network/OpenAI/execution calls are exactly zero.

## Stage 14 defects found during hardening
The first Stage 14 cap implementation could cap weights and then renormalize them. When too few eligible assets existed for the requested cap, the final normalization could raise weights back above `maxWeight` (for example two eligible assets with a 25% cap).

A second runtime issue existed around malformed numerical inputs: invalid `maxWeight` / `minObservations`, non-array return payloads or non-finite observations could propagate into covariance/variance calculations or weaken validation thresholds.

### Fix
Stage 14 now:
- detects whether the cap is mathematically feasible (`ceil(1 / maxWeight)` positive-score assets required);
- uses deterministic water-filling for feasible allocations;
- verifies final sum and max observed weight;
- returns `CONSTRAINT_INFEASIBLE` / `INCONCLUSIVE` instead of weakening the constraint;
- applies safe defaults for malformed numeric options;
- sanitizes return series and pairwise covariance inputs;
- fails closed with `INCOMPLETE_CURRENT_PORTFOLIO_HISTORY` when a currently held asset lacks enough usable observations;
- never emits `NaN`/`Infinity` portfolio volatility or marginal-variance metrics from malformed series.

## Stage 15 completeness and runtime defects found during hardening
The first institutional-risk foundation could understate risk in incomplete-data cases:

1. A positively weighted asset with no return history could effectively contribute zero to the portfolio series because the minimum-length calculation ignored zero-length arrays.
2. A stress scenario that omitted a positively weighted asset treated that missing shock as `0`, which could make the scenario look safer than the supplied data justified.
3. Non-finite values inside return arrays could be converted to zero or poison covariance/risk metrics.
4. An empty stress-scenario set could still produce a seemingly complete institutional risk status despite having no actual stress evidence.
5. Invalid `minObservations` or timestamps could weaken gates or trigger runtime exceptions.

### Fix
Stage 15 now fails closed before calculating VaR/CVaR or stress metrics with:
- `INCOMPLETE_WEIGHTED_HISTORY` when any positively weighted asset has fewer than the required usable observations;
- `NO_STRESS_SCENARIOS` when no explicit stress scenarios are supplied;
- `INCOMPLETE_STRESS_COVERAGE` when a stress scenario omits any positively weighted asset;
- `INSUFFICIENT_SYNCHRONIZED_HISTORY` when the cross-asset overlap after removing invalid rows is too short;
- `NON_FINITE_RISK_METRIC` if a non-finite metric somehow survives upstream sanitization;
- `NO_POSITIVE_WEIGHTS` when there is no valid portfolio to assess.

Successful assessments explicitly report complete weighted history, synchronized history and stress coverage.

## Runtime crash-resistance hardening across 11–15
A dedicated adversarial test suite now exercises malformed inputs that normal scenario tests do not cover:

- `null` / wrong-shape top-level inputs;
- invalid dates that would otherwise crash `toISOString()`;
- invalid previous-regime names and hysteresis options;
- non-array event collections;
- invalid optimizer thresholds;
- `NaN`, `Infinity`, strings and missing return observations;
- missing current-portfolio history;
- missing and incomplete institutional stress scenarios.

Stages 11–15 now normalize or fail closed on these cases rather than throwing runtime exceptions or silently weakening safety gates.

These are Shadow correctness fixes only. They do not touch `index.js`, Render, eToro, LIVE sizing or execution.

## What passing means
Passing means the technical composition of stages 11–15 is internally consistent under the deterministic stress matrix and adversarial malformed-input suite and is ready for empirical Shadow calibration.

It does **not** mean:
- predictive accuracy is proven;
- macro/event windows are calibrated;
- VaR/CVaR is validated on sufficient real history;
- the optimizer is production-approved;
- any layer may influence LIVE.

Production promotion remains a separate explicit validation gate.