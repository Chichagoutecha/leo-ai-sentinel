# v10.25.5 — Critical property/fuzz validation for stages 11–15

This branch adds a deterministic, zero-network, zero-OpenAI, zero-trading property test layer over the critical Shadow stack.

## What it checks
- Stage 11 regime probabilities remain finite, normalized and inside the known regime set.
- Stage 11 risk multiplier remains bounded.
- Stages 12–13 never gain LIVE authority under varied macro/event inputs.
- Stage 14 target weights sum to 1 when conclusive, remain non-negative and respect the configured cap.
- Stage 14 turnover and concentration metrics stay finite and bounded.
- Stage 15 risk metrics, contributions and stress outputs stay finite when conclusive.
- Stage 15 risk contribution weights sum to 1 and risk multiplier stays bounded.
- Every stage remains Shadow-only with zero provider/trading authority.

The harness uses a seeded PRNG so failures are reproducible exactly. The default quality gate runs 300 varied cases plus a determinism regression.

## Scope
No `index.js` changes. No package/start change. No Render change. No eToro/OpenAI call. No LIVE promotion. Passing this gate means stronger technical robustness only; empirical calibration remains separate.