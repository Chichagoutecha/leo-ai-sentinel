# LEO-AI SENTINEL — Historical Replay 11→15 v10.25.6

## Purpose

Add a reproducible replay/calibration layer over roadmap stages 11–15 while LIVE eToro waits for a **natural** valid BUY opportunity.

This harness is **Shadow only**. It has no network client, no OpenAI calls, no eToro calls and no authority to trade, block LIVE, size LIVE orders or promote itself.

## Important data-status rule

The built-in fixture is explicitly `HISTORICAL_STYLE_SYNTHETIC`.

It exercises historical-like transitions — calm growth, inflation/rate shock, credit stress and recovery — but it is **not** presented as empirical market history. Passing the fixture means only that the replay engine and the critical agents are technically ready to receive a real point-in-time historical dataset.

A future empirical gate must preserve provenance for every row and avoid look-ahead information.

## Point-in-time replay contract

Each row must provide:

- `at`: strictly increasing unique timestamp;
- `macro`: macro values available at that replay timestamp;
- `market`: market/regime features available at that timestamp;
- optional `events`: point-in-time event-calendar entries;
- `returns`: synchronized rolling return history for the weighted universe;
- optional `expectedReturns`, `currentWeights`, `dataQuality`;
- explicit stress scenarios, or the documented fixed Shadow stress set.

The harness rejects malformed timestamps, duplicate/non-monotonic rows and missing risk history before calibration.

## Cross-stage path

For every replay row:

1. Stage 12 normalizes/scorers macro observations.
2. Stage 13 evaluates event risk.
3. Stage 11 computes probabilistic market regime with hysteresis.
4. Stage 14 optimizes portfolio weights subject to hard max-weight and history constraints.
5. Stage 15 computes institutional risk only when weighted history and stress coverage are complete.

No step may create SELL authority, an order, provider traffic or LIVE authorization.

## Acceptance metrics

The technical fixture requires:

- regime probabilities normalize and risk multipliers remain finite;
- portfolio target weights sum to 1 and respect the hard cap whenever Stage 14 is READY;
- Stage 15 metrics remain finite whenever risk is conclusive;
- all five stages retain Shadow/no-LIVE authority;
- at least 90% optimizer coverage and 90% institutional-risk coverage on the complete fixture;
- inflation and credit stress do not receive a looser regime risk multiplier than calm conditions;
- recovery improves the regime risk multiplier versus credit stress;
- regime transition rate remains bounded to detect pathological churn.

## Fail-closed validation

Tests deliberately corrupt the weighted-history input. The replay must fail calibration instead of treating missing SPY history as a safe portfolio.

## What passing does NOT prove

A green CI result does **not** prove historical profitability, forward predictive value, production readiness, eToro execution reliability or permission to merge roadmap stages into LIVE.

The next empirical milestone is to feed this exact contract with real timestamped history from independent sources, then measure transition timing, false-defensive rate, missed-risk rate, turnover, regime persistence and stress response out of sample.
