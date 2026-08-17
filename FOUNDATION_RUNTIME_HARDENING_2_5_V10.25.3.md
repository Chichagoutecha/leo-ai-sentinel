# Foundation Runtime Hardening — stages 2–5

## Purpose
Harden the older Shadow foundation layers against malformed provider/adaptor payloads and runtime exceptions before they are composed with roadmap stages 6–15.

This work is deliberately isolated from Stage 1 eToro execution safety and from production `main`/Render.

## What the adversarial pass found
Normal unit tests for the foundation stack were green, but malformed-input tests exposed three real runtime exception paths in public/adaptor boundaries:

1. **Stage 3 — Alpaca Validator**
   - `compareMarketObservations(null, null, null)` could reach `normalizeEtoroObservation()` with a null object and throw while reading `symbol`.

2. **Stage 4 — Quartr Fundamental Agent**
   - `scoreFundamentalBundle(null, ...)` could reach `normalizeFundamentalBundle()` with a null object and throw while reading `symbol`.

3. **Stage 5 — Exa Catalyst Agent**
   - `analyzeEventGroup(..., null)` could throw while reading `options.nowMs`.

These failures are in Shadow/research adapter surfaces. They are not evidence of a current LIVE trading failure, but they are exactly the kind of integration defects that must be removed before enabling a larger Shadow pipeline.

## Runtime guard strategy
Instead of immediately rewriting the three mature modules and risking regression in already-tested provider logic, this branch adds `shadow-foundation-runtime-guard.js` as a fail-closed compatibility boundary.

The guard wraps the public/adaptor surfaces for Alpaca, Quartr and Exa:

- malformed synchronous calls become `INCONCLUSIVE` / empty evidence rather than an uncaught exception;
- malformed Alpaca/Quartr ingestion becomes `ok:false` with no evidence and no promotion authority;
- malformed Exa batch ingestion becomes an explicit guarded no-op with no reports/evidence;
- adapter globals are repointed to the guarded ingestion functions;
- caught runtime exceptions are counted by component/operation without logging secrets or raw provider payloads.

The guard itself has:
- `canTrade:false`;
- `canAuthorizeLive:false`;
- `livePromotionAllowed:false`;
- 0 OpenAI calls;
- 0 execution calls;
- 0 market/network calls of its own.

## Stage 2 / Shadow Research checks
The adversarial suite also verifies that:

- Shadow Lab rejects malformed rates and all eToro execution URLs;
- non-eToro hosts are rejected by the read-only URL guard;
- malformed or junk research evidence cannot become promotion-eligible;
- source/kind contract violations remain rejected.

## Stage 5 security regression
The Exa boundary is re-tested for:

- prompt-injection-like external text detection/removal;
- secret-like URL parameter stripping (`token`, `api_key`, etc.);
- no catalyst evidence produced from malformed batches.

## Deterministic fuzz sweep
The dedicated runtime-hardening test executes 100 deterministic malformed-input iterations across Alpaca, Quartr and Exa public boundaries. Assertions require:

- no uncaught runtime exception;
- no `canTrade:true`;
- no `canAuthorizeLive:true`.

## CI gates
The PR CI requires:

1. syntax checks;
2. all existing Stage 2–5 unit tests to remain green;
3. guarded adversarial runtime tests to pass;
4. `index.js`, production `package.json` and Stage 1 safe eToro diagnostic to remain unchanged;
5. no LIVE authority in foundation modules/runtime guard;
6. no eToro execution endpoint or OpenAI dependency in the runtime guard.

## What this does not prove
Passing these tests does not prove provider correctness or predictive value. It does not validate Quartr Pro access, Alpaca/eToro empirical calibration or Exa predictive accuracy.

It proves a narrower but important property: malformed adapter inputs are contained at the Shadow foundation boundary instead of crashing the larger agent pipeline or silently acquiring trading authority.

No production promotion is authorized by this document or PR.