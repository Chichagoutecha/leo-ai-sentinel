# Isolated eToro read-access audit

Inspected 2026-10-30: main d247ce5; local exposure branch 4f6cf85; GitHub PRs
71 (SHADOW accounting) and 72 (exposures) remain open drafts, not merged.
This branch starts from that main; it requires neither pending PR.
Production npm start preloads scope compatibility and execution observers. This
audit imports none of them, index.js, Express, scheduling or execution logic.

## Execution in the existing credential environment

Use Node >=18 in a private authorized shell already containing the eToro keys:

```sh
env -u NODE_OPTIONS node etoro-read-access-audit.js
```

Do not use npm start, production preloads, curl with literal secrets, shell tracing,
or paste keys into chat. Do not change Render variables/start command, restart or
deploy a service to run this diagnostic. If the script is not available in the
credential environment, arrange an authorized one-off execution separately.
The script does not read .env files, fetch secrets remotely or persist reports.
Its CLI prints only an allowlisted minimal report. `env -u NODE_OPTIONS` prevents
inherited startup preloads in this isolated process; the script itself cannot
undo preloads that already ran. Use a trusted Node binary and unmodified transport.

Inputs, read from the existing process environment only:
- ETORO_API_KEY / ETORO_USER_KEY: secret headers, never output or hashed.
- ETORO_ACCOUNT_ENV: REAL (default) or DEMO, never silently swapped on refusal.
- ETORO_PORTFOLIO_CONTEXT: configured assertion only, not identity evidence.
- ETORO_EXPECTED_AGENT_PORTFOLIO_ID (legacy alias ETORO_EXPECTED_PORTFOLIO_ID),
  ETORO_EXPECTED_AGENT_PORTFOLIO_GCID, ETORO_EXPECTED_MIRROR_ID:
  all supplied selectors must match one and only one metadata row.
- ETORO_EXPECTED_USER_TOKEN_ID: selects metadata inside that agent only.
  A match does NOT bind the loaded secret to this metadata row.

No identifiers, names, balances, positions, scope strings from the provider,
credential fingerprints, request headers, raw responses or error text are emitted.
Current-credential scope assertions from /me are reported separately from selected
agent-token metadata; neither proves usable write access. Numeric legacy 200/202
and modern 211/212 are recognized without importing the production wrapper.
Contradictory names versus numeric IDs are flagged, never optimistically unioned.
A list of available scope types is deliberately not requested: it would not prove
granted permissions and is unnecessary for this minimal audit.

## Official read allowlist and sources

Only GET requests on https://public-api.etoro.com are allowed, with exact paths,
no query strings or redirects:

| Path | Evidence | Official documentation |
| --- | --- | --- |
| /api/v1/me | Current authenticated GCID and reported scopes | https://api-portal.etoro.com/api-reference/identity/get-authenticated-user-profile |
| /api/v1/agent-portfolios | Owner-visible agent metadata, not proof of loaded token identity | https://api-portal.etoro.com/api-reference/agent-portfolios/get-agent-portfolios |
| /api/v1/trading/info/real/pnl | REAL portfolio read with expected portfolio structure | https://api-portal.etoro.com/guides/calculate-profit-loss |
| /api/v1/trading/info/demo/pnl | DEMO equivalent, only when explicitly selected | https://api-portal.etoro.com/guides/calculate-profit-loss |

Only three paths are attempted per run. Six network attempts maximum, timeout
8 seconds per attempt (hard cap 10 seconds), one retry on network failures/5xx,
none on 401, 403 or 429. Bodies are limited to 2 MiB and filtered in memory;
oversized/invalid/unexpected responses never become verified reads.
Each endpoint's result is independent. A discovery refusal does not suppress PnL.
No POST/PATCH/PUT/DELETE, token-management path, copy or order endpoint is allowed.

## Interpretation and limits

VERIFIED_READ means an authenticated read returned the minimum expected structure;
it is not a proof of PnL completeness, balances or execution rights. In particular,
PnL attribution remains UNVERIFIED because this script does not assume undocumented
identity fields in the PnL response. A matched /me GCID and agent metadata provide
an identity correlation; configured context alone never establishes that correlation.
An owner-visible agent listing does not prove that /me belongs to a selected child.
Missing selectors never trigger first-row selection, even for a single listed agent.
Multiple matching rows/tokens are AMBIGUOUS. Conflicting selectors yield MISMATCH.
TOKEN_BINDING_UNVERIFIED remains explicit because these read responses do not bind
a configured userTokenId to the secret loaded into x-user-key.

To resolve remaining attribution, obtain documented current-principal/account
binding evidence in the authorized environment; do not decode a token, compare
secret hashes or place an order. A current-credential write scope, if reported,
remains a permission assertion, not a successful execution test.

## Local result

The available local process has neither eToro key. No secure Render execution
connector is exposed here; no production secret was accessed. Running the CLI
returns requests=0, all three checks NOT_TESTED / CREDENTIALS_ABSENT, agent/account
identity UNVERIFIED and TOKEN_BINDING_UNVERIFIED. These are not 401/403 findings.
No authenticated eToro API verification was performed.

Tests use synthetic responses only:

```sh
node --test test-etoro-read-access-audit.js
npm run check
npm test
```
