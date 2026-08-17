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
7. Crisis risk must not be scored safer than the calm deterministic panel.
8. Every layer remains `canTrade:false`, `canAuthorizeLive:false`; harness network/OpenAI/execution calls are exactly zero.

## Stage 14 defect found during hardening
The first Stage 14 cap implementation could cap weights and then renormalize them. When too few eligible assets existed for the requested cap, the final normalization could raise weights back above `maxWeight` (for example two eligible assets with a 25% cap).

### Fix
`cappedNormalize()` now:
- detects whether the cap is mathematically feasible (`ceil(1 / maxWeight)` positive-score assets required);
- uses deterministic water-filling for feasible allocations;
- verifies final sum and max observed weight;
- returns `CONSTRAINT_INFEASIBLE` / `INCONCLUSIVE` instead of weakening the constraint.

This is a Shadow correctness fix only. It does not touch `index.js`, Render, eToro or LIVE sizing/execution.

## What passing means
Passing means the technical composition of stages 11–15 is internally consistent under this deterministic stress matrix and is ready for empirical Shadow calibration.

It does **not** mean:
- predictive accuracy is proven;
- macro/event windows are calibrated;
- VaR/CVaR is validated on sufficient real history;
- the optimizer is production-approved;
- any layer may influence LIVE.

Production promotion remains a separate explicit validation gate.