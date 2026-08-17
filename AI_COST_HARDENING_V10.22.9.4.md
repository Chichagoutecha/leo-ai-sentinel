# AI Cost Hardening — v10.22.9.4

## Purpose
Strengthen the $1/month OpenAI cost guard before any future production promotion. This branch is stacked on the production preload-preflight branch and remains DRAFT.

## Risks found
### Concurrent budget race
The previous budget gate checked only persisted `monthCostUsd`. Cost is added after a provider response, so several simultaneous calls could each see enough remaining budget and enter the provider concurrently. The daily call cap still applied, but the monthly dollar cap was not reserved atomically inside the process.

### Missing usage accounting
If a successful provider response omitted its `usage` object, token counts became zero and the call was accounted at $0 even though a provider call occurred.

### Error-message secret exposure
`safeError()` copied provider error messages directly into `[LEO_AI_COST]` logs. Provider errors normally do not contain credentials, but relying on that assumption is unnecessary. Known configured secrets and key/token-like strings should be redacted before logging.

## Hardening
- maintain `inFlightProjectedUsd` for calls that passed the budget gate but have not completed;
- monthly gate now checks `monthCostUsd + inFlightProjectedUsd + projectedCallCost`;
- reservations are released in `finally` on provider success/failure;
- cache hits reserve no budget and make no provider call;
- missing provider usage uses a conservative reserved/projected cost instead of zero;
- token/cost helpers reject non-finite/negative values;
- input-token projection now includes structured-output/tool metadata and a conservative buffer;
- known OpenAI/eToro/Upstash/BOT secrets plus key/token/Bearer patterns are redacted from optimizer error fields;
- runtime state exposes current in-flight projected dollars for observability.

## Dedicated tests
1. Three simultaneous calls with pricing/budget chosen so only two can be in flight: at least one must be budget-blocked before provider invocation.
2. A successful response without `usage`: monthly cost must increase and `CALL_COMPLETED` must report `CONSERVATIVE_RESERVED_FALLBACK`.
3. Secret-bearing synthetic errors: configured keys and token-like strings must not appear in sanitized output.
4. Existing GPT-5.6 Luna compatibility, production preload preflight and baseline tests must remain green.

## Safety
This branch does not change strategy, sizing, eToro code or Luna compatibility. It does not change the production monthly budget default ($1), daily call cap (18), or completion cap (1200). It is not merged and does not change the currently running Render process.