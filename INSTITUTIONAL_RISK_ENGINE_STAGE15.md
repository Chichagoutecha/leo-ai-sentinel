# Stage 15 — Institutional Risk Engine

Status: **SHADOW ONLY**.

Computes historical VaR 95%, CVaR 95%, annualized volatility, max drawdown, concentration HHI, per-asset risk contributions and user-supplied stress scenarios. Produces `NORMAL`, `WATCH`, `DEFENSIVE` or `CRITICAL` plus a Shadow risk multiplier.

The engine cannot trade, block a LIVE order, authorize LIVE, or call OpenAI. Insufficient history returns `INCONCLUSIVE`.

Acceptance requires unit/CI success followed by calibration on long out-of-sample histories and stress scenarios before any production influence. Rollback is removal of the module import/preload.
