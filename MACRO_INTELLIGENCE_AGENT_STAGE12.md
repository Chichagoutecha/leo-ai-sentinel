# Stage 12 — Macro Intelligence Agent

Status: **SHADOW ONLY / TECHNICAL VALIDATION REQUIRED**.

## Purpose
Normalize macro observations from trusted adapters and produce an auditable macro regime without allowing trading or LIVE authorization.

## Inputs
Policy rate, CPI/core CPI, unemployment, payroll trend, PMI, 2Y/10Y yields, DXY trend, oil trend, credit spreads and VIX. Each observation must include value, timestamp and provenance.

## Guardrails
- stale/future observations are rejected;
- minimum six valid observations and two independent source groups;
- no network client in this module;
- zero OpenAI calls;
- zero eToro/execution calls;
- no mutation of strategy, sizing, allowlist or LIVE state.

## Outputs
Growth, inflation-pressure and financial-conditions scores plus a Shadow regime: `DISINFLATIONARY_GROWTH`, `LIQUIDITY_RISK_ON`, `INFLATION_PRESSURE`, `TIGHTENING_STRESS`, `RECESSION_RISK`, `FINANCIAL_STRESS`, `MIXED`, or `INCONCLUSIVE`.

## Acceptance gate
Dedicated tests and CI must pass. Real provider adapters and empirical calibration remain a separate validation step before any decision influence.

## Rollback
Remove the preload/import of `shadow-macro-intelligence-agent.js`; the module has no persistent trading side effects.
