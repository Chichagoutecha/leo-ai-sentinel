# Stage 7 — Dynamic Universe Manager

Status: **SHADOW ONLY**.

Maintains only the Shadow research universe. New assets require persistent eligibility across multiple runs plus data-quality, liquidity, spread and freshness gates. Quarantined or weak assets can be audited/removed under explicit rules. Universe size is capped.

The module cannot alter the LIVE allowlist, cannot trade and cannot authorize LIVE. Acceptance requires tests/CI plus observation of churn, false additions and persistence behavior. Rollback is removal of the module import/preload.
