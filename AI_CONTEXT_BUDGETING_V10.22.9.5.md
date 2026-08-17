# LEO-AI v10.22.9.5 — AI Context Budgeting

## Why
The first successful production GPT-5.6 Luna decision after the compatibility fix used 130,028 input tokens for a HOLD decision. At the configured Luna pricing this single call cost about $0.0263. The model is inexpensive; the payload is not.

## Objective
Reduce repeated/historical decision context before the provider call without weakening current safety information or changing strategy, sizing, eToro execution, LIVE arming or the $1/month budget.

## Design
`ai-context-optimizer.js` is a preload loaded after:
1. `ai-cost-optimizer.js`
2. `ai-luna-temperature-compat.js`

and before `production-ai-preflight.js` / `index.js`.

It only recognizes the LEO decision payload shape (`trading_mode`, `portfolio_summary`, `market_data_summary`, `foundation_agents`, `instruction`). Other OpenAI requests are passed through unchanged.

### What is compacted
- long historical/reconstructible arrays such as histories, archives, logs, audit trails, candles/bars, Strategy Lab runs and leaderboards;
- oversized generic arrays, while prioritizing veto/block/error/risk items;
- oversized free-text fields.

### What is protected
The optimizer derives current safety facts before and after compaction. Asset-specific VETO/BLOCK/ERROR/FAIL/CLOSED/STALE/RISK facts, hard-veto flags, current safety booleans and relevant action/status/reason fields must remain present.

If a protected fact would be lost, compaction is rejected and the original payload is sent unchanged.

If a safely compacted payload still exceeds the configured maximum (`120000` characters by default), the optimizer also sends the original payload unchanged rather than deleting current scalar facts.

This means cost reduction never has authority to weaken a current hard safety signal.

## Observability
Logs use `[LEO_AI_CONTEXT]` and report only sizes/percentages and safety-fact counts, never the decision payload itself.

Expected events:
- `STARTED`
- `CONTEXT_COMPACTED`
- `CONTEXT_PASSTHROUGH`

Runtime state is available through `global.__LEO_AI_CONTEXT_STATE__` for tests/rehearsal.

## Safety invariants
- no new OpenAI/provider call;
- no eToro endpoint;
- no trading/execution function;
- no strategy or sizing modification;
- no `LIVE_EXECUTION_ARMED` modification;
- no automatic LIVE promotion;
- non-decision OpenAI traffic is byte-for-byte unchanged.

## Validation gate before any production merge
- adversarial synthetic payload must exceed 300k characters and be reduced by >=70%;
- current negative safety facts must survive;
- optimizer + Luna + cost guard provider-boundary test must pass;
- existing concurrency/missing-usage/preflight regressions must remain green;
- `index.js` and eToro execution files must remain unchanged;
- separate production authorization is still required.

## Production target
The current measured 130,028-token input is the baseline. The first production validation, if separately authorized, should compare actual `LEO_AI_COST inputTokens` before/after. A useful target is <=40k input tokens without any change in council/risk veto behavior. If the safety guard cannot prove preservation, the optimization must fall back to the original context.
