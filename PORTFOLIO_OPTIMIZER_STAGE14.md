# Stage 14 — Portfolio Optimizer 2.0

Status: **SHADOW ONLY**.

Builds diversified target weights from return histories, expected-return inputs and data-quality scores. Computes covariance, concentration, turnover, portfolio variance and marginal variance contribution.

Hard safeguards: minimum history, per-asset weight cap, no negative weights, no order generation, no LIVE authorization, no OpenAI calls.

Acceptance: weights normalize, caps hold, insufficient-history assets are excluded, risk metrics remain finite, and out-of-sample calibration is completed before any decision influence. Rollback is removal of the module import/preload.
