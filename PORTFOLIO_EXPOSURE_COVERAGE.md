# Read-only portfolio exposure

Inspected starting point: main d247ce5b72c0eee7832494146bda6e202d51c3a1.
The separate SHADOW accounting PR is not a dependency of this change.

`GET /portfolio-universe-status` keeps its existing authenticated REAL portfolio
read. It adds no requests, execution routes, permissions, or constituent provider.
The analysis watchlist and configured analysis candidates are not holdings.

## Actual sources and limits

- Positions come from the existing `getPortfolio({environment: 'REAL'})` response.
  Values use invested amount plus reported profit. Missing profit is already
  treated as zero by the existing normalizer; these are estimates, not verified
  market values, gross/notional exposures, or leverage-adjusted CFD risks.
- USD is the application's existing account valuation convention. This is not a
  currency risk classification or a newly verified account currency field.
- Instrument names come from WATCHLIST mapping. Unknown instrument IDs are retained
  individually instead of being merged under UNKNOWN. Missing identities/values
  and conflicting repeated position IDs make totals incomplete.
- No accessible, documented ETF or Smart Portfolio constituent feed is configured.
  The route passes an empty composition collection and explicitly reports this.
  It does not fetch guessed URLs, scrape, or infer holdings from analysis lists.
- Sector, issuer, geographic and economic currency metadata are unavailable in
  this route. No sector is inferred from internal strategy category names.
- Cash is reported separately when available and is not counted as a security.

## Deterministic composition contract (not a data connector)

The pure calculator can validate supplied official eToro snapshots; sourceType,
sourceUrl and documentationUrl are caller provenance assertions, not independent
verification. No production adapter currently supplies them. Tests use synthetic
fixtures, not a claimed official constituent endpoint.

A snapshot must have both asOf and capturedAt, no future dates, asOf <= capturedAt,
and age <= 7 days by default for both dates. It must declare complete=true,
contain unique nonempty symbols, finite weights from 0 to 100 summing to 100
within 0.01 percentage point, and match the account valuation currency. It must
not contain nested ETF/Smart Portfolio components. Multiple snapshots for a held
basket are rejected conservatively rather than choosing an optimistic version.
The basket value comes only from held positions, never a snapshot's claimed value.

Valid baskets replace the wrapper value in combined instrument exposure, avoiding
double counting. Direct holdings remain separately visible. Partial, stale and
unknown baskets do not contribute to combined totals: combined=null, with known
subtotals clearly labeled. Reported constituents remain inspectable even when
unusable. Unknown dimension metadata is listed separately and never allocated to
zero or interpreted as diversification. Composition weights and USD value estimates
do not establish correlations, loss forecasts or future performance.

Identical repeated position IDs count once; conflicting duplicates are excluded
and flagged. Distinct position IDs on one instrument add together. Without position
IDs, separate rows are retained because multiple genuine lots cannot be reliably
deduplicated. Numeric contributions are sorted before summation for reproducibility.
Smart Portfolio components are analysis-only and never copied or ordered.
