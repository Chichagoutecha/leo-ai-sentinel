# Account-scoped instrument eligibility registry

## Starting point and actual access

Inspected main: d247ce5b72c0eee7832494146bda6e202d51c3a1.
The local previous branch was read-access-audit 886e88f. PRs 71, 72 and 73
were open drafts, not merged, when checked on 2026-10-30. This feature starts
independently from main and does not broaden or import PR73's GET-only diagnostic.
Neither ETORO_API_KEY nor ETORO_USER_KEY is present in the accessible local process.
All broker-response tests are synthetic. Actual account permissions remain NOT_TESTED.
No production environment, permission or key was modified or copied.

## Official contract

Source inspected 2026-10-30:
https://api-portal.etoro.com/api-reference/trading--real/check-instrument-trading-eligibility

- Fixed informational POST https://public-api.etoro.com/api/v2/trading/info/eligibility.
  Returns account-specific trading configuration; it is not an order operation.
- Keys x-api-key and x-user-key are used as a pair, with x-request-id.
  Documentation describes OAuth alternatives; the rendered page did not establish
  the exact named OAuth scope for this operation. Do not infer a write permission
  from POST, assume a particular read scope suffices, or alter token permissions.
  Successful authenticated access remains unverified here.
- Body: instrumentIds (int32 array), symbols (string array), currency. At least one
  identifier/symbol, combined maximum 100 per request. Currency currently USD only.
- Dedicated quota: 20 requests / 60 seconds. Configuration can be reused in-session.
- Response: currency, eligibilities, notFoundInstrumentIds, notFoundSymbols.
  Configurations include flags, amount/exposure/unit limits, quantity/order behavior,
  margin fields and leverage configurations by settlement type and direction.

The client accepts only that body and internally constructs the exact URL/method.
There is no arbitrary URL, generic POST, order, copy, fallback endpoint or redirect.
REAL only: a DEMO selection is explicitly refused, never redirected to REAL.

## Read-only views and explicit refresh

Two routes use the existing requireSecret authentication:

- GET /instrument-eligibility-status: reports the current analysis universe and
  cached evidence. It sends zero broker/provider requests.
- POST /instrument-eligibility-refresh: explicit information refresh; accepts only
  the official eligibility body, maximum 100 combined identifiers/symbols. This
  returns a sanitized result and never changes the trade allowlist.

Example JSON body (instrument IDs are examples from the existing registry and
must be verified for the intended instrument, not treated as proof of eligibility):

```json
{"instrumentIds":[3417],"currency":"USD"}
```

No automatic startup, schedule or scan refresh was added. There is no connection
from the information registry to order execution or live arming. Production start
preloads are unchanged. Unknown configured candidates stay subject to the existing
WATCHLIST/allowlist intersection; discovery is not authorization.

For an isolated, explicit information check in an already authorized credential
shell, without starting the app or inheriting production Node preloads:

```sh
env -u NODE_OPTIONS node -e 'const m=require("./etoro-instrument-eligibility"); const r=m.createEligibilityRegistry(); r.refresh({instrumentIds:[3417],currency:"USD"}).then(v=>console.log(JSON.stringify(v))).catch(()=>{console.log("INVALID_ELIGIBILITY_REQUEST");process.exitCode=1})'
```

Do not paste literal keys, log headers, enable HTTP debug or export keys from Render.
This command was not used to perform an authenticated request during implementation.

## Cache and context isolation

The cache is in memory only, bounded to 100 request entries; TTL defaults to 30
minutes (configurable up to 24 hours). Returned objects are cloned; raw provider
responses and provider error text are never stored in the registry. Known fields
are projected with strict types, preserving absent versus explicit null values.
Unknown provider fields are discarded. Known credential strings are screened out
of returned string fields; no key or secret-derived fingerprint is emitted.
Credentials remain only in private transport memory as needed for headers/rotation.

Changes to either loaded key, account environment, configured context, expected
agent/portfolio ID, GCID, mirror or token ID invalidate the cache. The public context
is a process-local generation number, never a secret hash. Responses crossing a
context change are discarded. Configured identifiers isolate cache entries but do
not verify account ownership or binding to the loaded token: identity remains
UNVERIFIED until a future documented identity-binding integration establishes it.

Identical concurrent refreshes coalesce. refreshMany accepts at most 1000 inputs,
validates all batches before sending any and sends sequential batches of <=100.
It stops on 401/403/429/missing credentials. The transport never retries. It caps
actual requests at 20 per rolling minute even across credential rotations; a 429
also activates at least a 60-second cooldown. Use one shared client per process;
multiple replicas need a shared limiter before enabling automatic collection.
Requests have an 8-second deadline (hard cap 10), 2 MiB body limit and no redirects.

## Interpretation

Inspection keeps discovery, unique identification, technical configuration,
caller-supplied LEO authorization and current quote/portfolio freshness separate.
The GET view deliberately does not invent operation parameters or freshness: it
shows CONFIGURATION_AVAILABLE_NOT_EVALUATED for fresh stored configurations.

Explicit operation evaluation supports conservative OPEN MARKET amount checks and
CLOSE flags. It checks exact settlement/direction/leverage, potential flags, quantity
support, supplied units versus max units and minimum amount/exposure. CLOSE needs
an explicit partial/full choice. Known W8 prerequisites remain unverified. Other
order types/quantity modes are retained as metadata but not optimistically evaluated.
These checks do not establish settlement availability beyond the returned config,
margin/buffer sufficiency, cost, tax/compliance readiness, accurate unit estimation,
market opening, account identity or actual executable order size. ALLOWED_CONFIGURATION
is not an execution permit. No eligibility result can alter LEO authorization.

Omitted requested instruments are PARTIAL/INCOMPLETE; explicit not-found results
remain NOT_FOUND. Duplicate IDs/symbols, found/not-found conflicts, bad field types,
contradictory limits and mismatched configured identity fail closed. USD mismatches
are rejected, never converted. STALE configurations remain labeled; no stale success
is used after a newer access failure. No partial response is interpreted as zero.

## Verification

```sh
node --test test-etoro-instrument-eligibility.js
npm run check
npm test
```

Only simulation and syntax checks are needed in the credential-free workspace.
index.js execution paths and start scripts are not changed by this feature.

Implementation validation: 21 targeted tests and 164 full-suite tests passed;
`npm run check` and `git diff --check` passed. An independent comparison against
main confirmed the contiguous executeBuy/executeSell execution section and npm
start command unchanged. A local credential-presence diagnostic returned
NOT_TESTED / CREDENTIALS_ABSENT, HTTP status null, networkCalls=0. There are no
verified live account rights or fills from this implementation session.
