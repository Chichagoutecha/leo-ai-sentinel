# v10.22.9.7 — Deterministic No-Action Shadow

## Goal
Measure how often LEO pays for an LLM decision when the deterministic state already proves that no action is possible.

The first production GPT-5.6 Luna success on 2026-08-17 used 130,028 input tokens and returned HOLD while the portfolio had 0 positions and the MultiAgentCouncil reported all 8 analyzed assets vetoed with 0 approved buys and 0 approved sells.

## Shadow condition
The analyzer emits `WOULD_HOLD_WITHOUT_LLM` only when all of these are true:

1. the request is a recognized LEO decision payload;
2. the portfolio contains exactly 0 open positions;
3. the council analyzed at least one asset;
4. approved buys = 0;
5. approved sells = 0;
6. vetoed assets = analyzed assets;
7. when per-asset council states are present, every state is `VETOED`.

Any open position disables the candidate gate so SELL/exit review always remains available.

## Critical safety property
This version is observation-only.

- It does **not** skip the OpenAI request.
- It does **not** modify the request.
- It does **not** modify the provider response.
- It does **not** change strategy, sizing, eToro, LIVE execution or health accounting.

The purpose is to collect evidence before a future core-level deterministic prefilter is considered.

## Promotion criteria
A future real prefilter must remain a separate change and requires, at minimum:

- repeated Shadow observations showing the condition always maps to a safe HOLD;
- explicit protection for SELL/exit paths;
- no masking of OpenAI provider health;
- deterministic audit logging;
- regression tests proving actionable council states always reach the normal decision path;
- separate LIVE validation and rollback plan.

No automatic promotion is permitted.
