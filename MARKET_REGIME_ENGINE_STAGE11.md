# Stage 11 — Market Regime Engine 2.0

Status: **SHADOW ONLY**.

Combines macro state, market breadth/trend/volatility, credit/rate stress and event risk into a probabilistic regime distribution. A hysteresis gate prevents weak regime flips.

Outputs a Shadow advisory `riskMultiplier` capped to 0.5–1.1. It has no execution surface and cannot authorize LIVE decisions.

Regimes: `RISK_ON`, `NEUTRAL`, `RISK_OFF`, `INFLATION`, `RATE_SHOCK`, `CREDIT_STRESS`.

Acceptance: probabilities normalize, stress cases classify correctly, transition stability is measurable, and empirical calibration is performed before any decision influence. Rollback is removal of the module import/preload.
