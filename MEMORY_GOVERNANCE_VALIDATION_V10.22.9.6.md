# LEO-AI v10.22.9.6 — Memory Governance Validation

## Production observation
During the successful 12:00 CEST GPT-5.6 Luna cycle, persisted Upstash state was about 590,539 bytes (65.62% of the configured 900,000-byte hard limit). Subsequent watches rose to 603,943 bytes (67.10%) by 12:50 CEST. The existing proactive target is 612,000 bytes / 68%.

That means the next important proof is not to lower limits blindly, but to verify that the existing `fitPersistentStateToBudget` compaction behaves correctly as the 68% target is crossed.

## Scope
This branch adds no production runtime code. It exercises the exact exported memory-governance implementation from `index.js` on synthetic states larger than the current production scale.

## Regression guarantees
The suite verifies:
- a >700k synthetic persisted state is reduced below a 260k test target without entering critical fallback;
- active execution intents survive compaction;
- automation guards, cooldowns, portfolio identity, execution milestones, risk high-water marks, active strategy and archive cursor survive;
- newest-at-end histories (equity, macro regime, point-in-time archive) retain the most recent tail;
- newest-at-front histories (logs, audit, risk-sell history, execution verification) retain the most recent head;
- trend memory retains the newest point for each asset and never shrinks below its configured safety floor in the test;
- section-size diagnostics remain sorted and usable for identifying future growth hotspots.

## Why validation-only first
The current production logs still report `pressure: OK`, `target_reached: true`, and no memory error. Changing production compaction before the 68% mechanism is proven would create unnecessary risk.

If the next real watch crosses 68%, the desired production evidence is:
- one or more entries in `reductions`;
- `target_reached: true`;
- usage falling back below the target;
- active intents / execution verification / identity state preserved;
- no `last_error`.

Only if that empirical behavior fails should the runtime implementation be changed.

## Safety
- no `index.js` modification;
- no package/start-command modification;
- no OpenAI call;
- no eToro call;
- no LIVE/strategy/sizing change;
- DRAFT validation branch only.
