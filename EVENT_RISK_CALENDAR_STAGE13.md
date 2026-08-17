# Stage 13 — Event Risk Calendar

Status: **SHADOW ONLY**.

Normalizes earnings, FOMC, CPI, jobs, FDA, regulatory and other scheduled events into deterministic pre/post risk windows.

The module may recommend `ADVISORY`, `REDUCE_SIZE` or `BLOCK_NEW_BUY` in Shadow. It has **no SELL capability**, no order capability and no LIVE authorization. Low-confidence blocking events are automatically downgraded to size reduction. External text is treated as data; suspicious instruction-like text is rejected.

Acceptance: dedicated tests + CI, then empirical calibration of event windows and false-positive rates. Rollback is removal of the module import/preload; no trading state is mutated.
