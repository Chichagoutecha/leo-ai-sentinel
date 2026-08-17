# Stage 9 — Adaptive AI Router

Status: **SHADOW POLICY ONLY**.

Chooses among `QUANT_ONLY`, `LUNA`, optional `PREMIUM_REVIEW`, or `BLOCK` using ambiguity, stakes, council conflict, data quality, remaining monthly AI budget and daily call capacity.

This module **does not call any model**. Budget exhaustion falls back to quant-only; poor data quality fails closed to BLOCK. Premium review is unavailable unless explicitly configured.

Acceptance requires routing tests, cost-savings measurement and later A/B value evidence. Rollback is removal of the policy module; no trading state is mutated.
