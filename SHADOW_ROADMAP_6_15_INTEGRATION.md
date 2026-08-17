# Roadmap 6–15 — Shadow Integration Rehearsal

This branch composes the technical foundations for Stages 6–15 without changing `index.js` or production `main`.

## Priority sequence implemented
12 Macro → 13 Event Risk → 11 Regime 2.0 → 14 Portfolio Optimizer → 15 Institutional Risk, then support layers 6 Discovery 2.0 → 7 Dynamic Universe → 8 Profitability/Cost → 9 Adaptive AI Router → 10 AI Value Experiment.

## Safety contract
- all ten modules expose `canTrade:false` and `canAuthorizeLive:false`;
- the combined preflight requires all ten modules to be present and Shadow-safe;
- the roadmap rehearsal makes zero market/network/model/execution calls by itself;
- `index.js` remains untouched;
- production `start` is not changed into the roadmap rehearsal;
- `start:shadow-roadmap` is a research-only preflight command and must never start the trading application;
- no automatic LIVE promotion.

## Validation state
Passing unit/CI means **technically built**, not empirically proven. Each stage retains its own calibration/observation requirement. Production promotion remains a separate decision even after the full stack is technically green.
