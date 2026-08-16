# v10.22.10 — eToro execution safety gate

## Objective

Constrain the local ambiguity circuit breaker to **new position openings only** while preserving every close/reduce execution path.

This change is intentionally isolated from strategy, allocation, sizing, AI decisions, portfolio identity checks and `LIVE_EXECUTION_ARMED`.

## Official eToro execution families used as reference

- Open by amount: `POST /api/v1/trading/execution/market-open-orders/by-amount`
- Open by units: `POST /api/v1/trading/execution/market-open-orders/by-units`
- Close a position: `POST /api/v1/trading/execution/market-close-orders/positions/{positionId}`

Reference: eToro Developer Portal, **Open and close market orders**.

## Non-negotiable invariants

1. Every eToro execution write remains observable by the diagnostics layer.
2. Only `/trading/execution/market-open-orders/*` can be blocked by the ambiguity breaker.
3. `/trading/execution/market-close-orders/*` is never blocked by that breaker.
4. An ambiguous close/reduce response is logged but never arms the new-open breaker.
5. An ambiguous open response may arm the breaker and prevent a duplicate opening attempt.
6. The breaker never changes `LIVE_EXECUTION_ARMED`.
7. No secret value may be emitted in diagnostic logs.
8. A local breaker response must be explicit HTTP 409 and distinguishable from eToro responses.

## Automated acceptance tests

The dedicated test suite must prove:

- both official open-by-amount and open-by-units routes are breaker-eligible;
- the official close-position route is not breaker-eligible;
- an ambiguous close response does not arm the breaker;
- an ambiguous open response arms the breaker;
- a subsequent open request is blocked before the provider;
- a close request still reaches the provider while the breaker is active;
- empty 2xx, empty JSON, business acknowledgement, HTTP rejection and unrecognized 2xx are classified distinctly;
- known credentials are redacted.

## CI gate

Before this PR can be considered technically ready:

- `npm ci` must pass;
- `npm run check` must pass;
- `npm test` must pass;
- GitHub Actions must be green on the PR head;
- the PR must remain unmerged until the separate LIVE diagnostic cycle has been reviewed.

## Production validation gate

Automated tests prove the local safety invariant, not eToro business acceptance. Production validation still requires observing a real eligible execution and its post-order portfolio verification. A successful HTTP response alone is not sufficient proof of a trade.

## Rollback

If startup, diagnostics or execution behavior regresses after a future approved merge, rollback is simply to restore the previous `package.json` preload and previous diagnostics module commit. No portfolio state migration is required because this module stores only in-process diagnostic/breaker state.

## Known limitation

The breaker is intentionally process-local. A Render restart clears it. Duplicate protection must therefore continue to rely on the bot's persistent execution-intent/reconciliation layer as the durable source of truth.
