# Support Runtime Hardening — roadmap stages 6–10

## Purpose
Harden the support layers that feed the higher-priority risk/macro stack. This branch is stacked on the critical 11–15 hardening branch and remains Shadow/research-only.

## Stage 6 — Opportunity Discovery 2.0
Hardening added:
- safe handling of null/wrong-shape universe/options;
- safe fallback for invalid timestamps and shortlist/finalist thresholds;
- symbol-level deduplication;
- conflicting duplicate eligibility fails safe as `DUPLICATE_CONFLICT` instead of allowing the best-looking duplicate to win;
- no AI/network/execution authority added.

## Stage 7 — Dynamic Universe Manager
Hardening added:
- safe handling of malformed current universe/candidates/options;
- bounded policy defaults for data quality, liquidity, spread, freshness, universe size and persistence;
- duplicate candidates collapse conservatively: any ineligible duplicate blocks addition;
- protected/core assets are not silently deleted to satisfy a cap;
- if only protected assets keep the universe above the configured cap, status is explicit `UNIVERSE_CAP_UNRESOLVED` rather than pretending the cap is respected.

## Stage 8 — Profitability & Cost Guard
Hardening added:
- safe handling of malformed record arrays/options/timestamps;
- all cost fields are clamped non-negative so malformed negative costs cannot inflate profitability;
- exact duplicate accounting rows are excluded to reduce replay/double-counting risk;
- received/used/duplicate counts are observable.

## Stage 9 — Adaptive AI Router
Hardening added:
- missing data quality now fails closed instead of defaulting to perfect quality;
- safe handling of malformed context/options/timestamps;
- model names are normalized with safe defaults;
- invalid call-cost settings fall back safely;
- an explicit zero AI call-cost limit means no AI spend and routes to `QUANT_ONLY`;
- the router itself still performs zero model calls.

## Stage 10 — AI Value Experiment
Hardening added:
- safe handling of malformed records/options/timestamps;
- invalid signed-return/notional rows are excluded;
- negative AI/other costs are clamped to zero;
- duplicate arm rows for the same opportunity disqualify that opportunity from the matched experiment instead of allowing last-write-wins bias;
- invalid/duplicate counts are observable;
- matched same-opportunity protocol and no-LIVE promotion remain enforced.

## Adversarial test matrix
A dedicated deterministic suite tests:
- null and wrong-shape top-level inputs;
- invalid dates and numeric options;
- conflicting duplicate symbols/candidates;
- oversized protected Shadow universes;
- negative cost corruption and exact duplicate accounting rows;
- missing AI data quality and zero-cost AI routing;
- invalid Stage 10 metrics and duplicate experiment arms;
- 100 deterministic malformed-input iterations across stages 6–10 with assertions that no runtime exception occurs and no LIVE authority appears.

## Safety
This hardening does not touch `index.js`, production `package.json`, Render, eToro, OpenAI production calls, strategy sizing or `LIVE_EXECUTION_ARMED`.

Passing means the support layers are technically more resistant to malformed inputs and accounting/duplication errors. It does not constitute empirical or LIVE validation.