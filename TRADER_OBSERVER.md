# Read-only eToro trader observer

## Inspected code and live access

Inspected local branch before work: feat/instrument-eligibility-registry 714bed9.
GitHub main remains d247ce5b72c0eee7832494146bda6e202d51c3a1. Read-access audit
PR73 and eligibility PR74 remain open drafts, not merged. This feature starts
independently from main; it does not assume those clients are deployed. The access
audit reviewed in this conversation found no eToro keys in the accessible process.
Key-presence checks again found neither ETORO_API_KEY nor ETORO_USER_KEY.
There have been no authenticated eToro reads or execution calls in this task.

## Configuration and routes

Optional TRADER_OBSERVER_TRADERS_JSON uses stable REAL account IDs, not fuzzy names:

```json
[{"realCID":1563191,"expectedGcid":1536861}]
```

These numbers illustrate the documented schema; they are NOT recommended traders.
The default list is empty. Maximum five distinct realCID values. expectedGcid is
optional; once observed, the GCID is pinned and survives normal/critical persistence.
A changed name on the same identity updates the same trader. Duplicate profile
matches, conflicting configured GCIDs and changed pinned GCIDs fail closed. Before
and after username-addressed reads, the account is resolved again by realCID, so
renames during collection cannot silently substitute another trader.

No configuration was applied to Render. No automatic schedule/startup polling was
added. A future collector can call the bounded module; current collection is manual:

- GET /trader-observer-status: existing requireSecret authentication, cache-only,
  zero provider requests. Includes snapshots, coverage, capabilities and journal.
- POST /trader-observer-refresh: same authentication; JSON body {"realCID":1563191}.
  Only a configured ID is accepted, no force flag, arbitrary URL or method.

## Actual official endpoints, inspected 2026-10-30

| Dataset | GET endpoint | Official documentation |
| --- | --- | --- |
| Stable account -> current username | /api/v1/user-info/people?cidList={realCID} | https://api-portal.etoro.com/api-reference/users-info/get-user-profile-and-account-summary |
| Public live positions | /api/v1/user-info/people/{username}/portfolio/live | https://api-portal.etoro.com/api-reference/users-info/get-user-live-portfolio |
| Monthly/yearly performance | /api/v1/user-info/people/{username}/gain | https://api-portal.etoro.com/api-reference/users-info/get-user-performance-history |
| Aggregate trading/risk statistics | /api/v1/user-info/people/{username}/tradeinfo?period=LastTwoYears | https://api-portal.etoro.com/api-reference/users-info/get-user-trade-info |

The last endpoint returns aggregate statistics, NOT an individual transaction
history. Public portfolio fields include openTimestamp, openRate, investmentPct,
isBuy and leverage, but no documented units field. Invented units or transaction
arrays in responses are ignored. No hidden endpoint, scraping, user feed inference
or guessed pagination parameter is used.

The selected schemas do not document a page cursor or reliable completeness marker.
Each read records pagesFetched and complete=null / NOT_DOCUMENTED. Missing/truncated
rows cannot establish a full portfolio or a sale. Full history completeness remains
unknown even when performance arrays are available. Unknown update timestamps and
publication lag stay null. Position openTimestamp describes the reported position
opening, not snapshot freshness, transaction receipt or a verified executable fill.
Performance timestamps describe reported periods, not provider update times.

## Privacy and availability

AVAILABLE, PARTIAL, STALE, PRIVATE and UNAVAILABLE are exposed as the supported state
vocabulary. Current portfolio snapshots stay PARTIAL because completeness and source
update time cannot be established from this contract. Individual datasets such as
resolved identity and valid performance can be AVAILABLE. A stale collection is
STALE; failures remain visible with retained historical snapshots labeled historical.

PRIVATE is reserved: these documented responses do not define an unambiguous privacy
marker. A 403 is UNAVAILABLE / FORBIDDEN_PRIVACY_UNPROVEN, never falsely PRIVATE.
The profile's optOut flag has no sufficiently documented privacy semantics here and
is not interpreted as such. Future PRIVATE detection needs documented evidence.

## Journal semantics

Event identity hashes only canonical public observation data, never credentials.
Stable trader/account and position keys, prior/current observation IDs, collection
times, source, proof type and correction/late flags are retained. Replaying an
identical observation is idempotent. Corrected observations link their predecessor;
older received observations do not replace a newer baseline. New collection times
on unchanged data do not create trading events.

- POSITION_APPEARED: presence newly observed, not proof of an executed BUY.
- POSITION_DISAPPEARED: requires two explicitly complete normalized snapshots;
  the current public API adapter cannot certify this condition.
- WEIGHT_CHANGED: can reflect market-price movement; never converted into BUY/SELL.
- UNITS_CHANGED: distinct primitive for a future verified units adapter. The current
  API collector does not provide units and cannot emit this from raw unknown fields.
- INDETERMINATE: missing positions in partial data, conflicting direction/identity,
  or changed reported position details. No assumed trade.
- OBSERVATION_CORRECTED / LATE_OBSERVATION: explicitly distinguish revised or delayed
  evidence. All current events have transactionProven=false and effectiveAt unknown.

Explicit individual transactions remain UNAVAILABLE, not fabricated from tradeinfo
statistics. This observer supplies no strategy vote, order, copy or execution action.
Direct and socialTrades positions are retained in separate container namespaces;
there is no exposure summation or copied-account ownership inference in this module.

## Bounded collection and storage reuse

One collection at a time, >=15 minutes between attempts on a trader, <=5 GETs per
collection (profile before/after, portfolio, gain, statistics). No retries. 401/429
stop collection; a refusal on a single other dataset remains visible independently.
Timeout is 8 seconds/request (cap 10); bodies capped at 2 MiB; redirects prohibited.

The existing application has a bounded retry helper but no central shared eToro
quota allocator suitable for all these public reads. This client deliberately does
not inherit retry-on-429 behavior. It uses a conservative 20/minute observer budget
and a 429 cooldown. The current docs give a shared 60/min quota for profile and gain
and dedicated 60/min quotas for live portfolio/tradeinfo. Observer quota timestamps
and cooldown persist through the EXISTING runtimeState/Upstash/local JSON pipeline,
as do per-trader attempt times. No new database or autonomous process is created.
Other broker clients still consume their own quotas: a multi-replica/global quota
coordinator would be required before enabling broader automatic collection.

Persistence bounds: five traders, 100 current positions per snapshot, 100 journal
and observation-index entries, <=48 KB observer section by compaction; critical
budget target is 4 KB. Compaction marks historyTruncated, drops older evidence,
then trims snapshots with explicit reasons. Identity pins and attempt cooldowns
survive. Truncated baselines cannot generate synthetic removals or new appearances.
Dedupe outside the retained observation-index window is not guaranteed. Runtime
state restore re-applies bounds. Raw responses, names/biographies/avatars, provider
error text and keys are not stored; only public username, numeric identity and
allowlisted financial/position data needed for observation are retained.

Credential context is labeled unverified. A loaded agent key does not establish
access to the owner account or to any social dataset. Successful public reads do
not establish write permissions. Secret strings stay in private transport memory
only and are never hashed, logged or persisted.

## Verification

```sh
node --test test-trader-observer.js
npm run check
npm test
```

Synthetic fixtures test ambiguity, renames/races, duplication, partial pages,
corrections, late data, quotas, persistence, freshness and zero-execution boundaries.
No real trader data or account rights are claimed as verified by these tests.

Implementation results: 24 targeted tests and 167 full-suite tests passed;
`npm run check` and `git diff --check` passed. The contiguous execution section
(executeBuy through executeSell to scanMarket) and npm start were independently
compared to main and are unchanged. The credential-free local read diagnostic
returned UNAVAILABLE/CREDENTIALS_ABSENT, HTTP null and networkCalls=0.
