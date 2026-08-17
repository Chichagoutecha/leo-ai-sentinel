# v10.23.4 — Exa News & Catalyst Agent

## Purpose

Turn current news/research discovery into auditable Shadow evidence without letting raw web content, rumors, duplicated press releases or prompt-like instructions influence LIVE execution directly.

The module is deliberately **provider-decoupled**: Exa can be used by the connected ChatGPT research workflow to search/fetch sources, but the unattended Render process does not automatically inherit that plugin connection.

## Exa schema validation performed

During development, the connected Exa tools were exercised on a real current-company research query and on full-page fetches. The observed search/fetch output reliably exposed the information needed by the normalized adapter:

- title;
- URL;
- publication date when available;
- author when available;
- highlights/content;
- multiple results from both company-primary and independently related domains.

The normalized contract used by the agent adds explicit fields that search alone cannot safely infer without a research adapter: ticker, event type, directional score, confidence, source class and source group.

## Source classes

Each observation must declare one allowed source class with a bounded reliability prior:

- regulator;
- government;
- company primary;
- partner primary;
- exchange primary;
- reputable media;
- trade media;
- research institution;
- blog;
- social;
- unknown.

Reliability is only one factor. A high-reliability source can still be stale, contradictory or insufficiently independent.

## Independence versus duplication

Two URLs are not automatically two independent sources.

For example, a company's investor-relations site and newsroom are treated as the same source group when they belong to the same organization. A second announcement from an independent partner/regulator/media organization can provide genuine corroboration.

The agent deduplicates both exact pages and multiple pages from the same source group for the same event. This prevents a syndicated press release from creating artificial consensus.

## Event statuses

- `CONFIRMED_CATALYST` — at least the configured minimum independent source groups, directional agreement and adequate source quality;
- `PRIMARY_SOURCE_CATALYST` — authoritative primary source, but not yet independently corroborated;
- `POSSIBLE_CATALYST` — usable but limited corroboration;
- `RUMOR_RISK` — rumor/anonymous/low-trust evidence dominates;
- `CONFLICTING` — materially opposed credible evidence;
- `STALE` — no fresh usable evidence;
- `INCONCLUSIVE` — malformed, injection-rejected or otherwise insufficient evidence.

The system never resolves credible disagreement by averaging it into a fake neutral/positive consensus.

## Rumor safety

Rumor-like phrases and anonymous-source flags reduce evidence weight. A single low-trust rumor cannot become a confirmed catalyst. `RUMOR_RISK` emits risk evidence, never positive catalyst evidence.

This is deliberately conservative because false positives in fast-moving news can be more damaging than missing one opportunity.

## Prompt-injection defense

Raw external text is treated as untrusted data, never instructions.

The agent detects common prompt-injection/trading-command patterns before scoring. Suspect observations are excluded from usable evidence. Stored titles/summaries are sanitized and length-limited; secret-like URL query parameters are removed.

The module never executes text such as “ignore previous instructions”, “reveal secret”, “buy now” or “place order”.

## Time integrity

Every usable observation requires a valid publication/observation timestamp. Future-dated data outside a small tolerance and stale events are excluded from fresh catalyst evidence.

Default maximum event age is 96 hours, configurable by caller. Event-specific policies may later shorten this substantially for high-frequency catalysts or lengthen it for structural research themes.

## Research evidence

Depending on status/direction, reports may produce:

- `NEWS`;
- `CATALYST`;
- `RISK`.

`CONFIRMED_CATALYST` receives the strongest bounded catalyst evidence. `PRIMARY_SOURCE_CATALYST` is intentionally lower-confidence. `CONFLICTING` and `RUMOR_RISK` produce risk/context evidence instead of a positive catalyst.

## Safety invariants

- no Exa network client in the module;
- no eToro execution client;
- no OpenAI call;
- no `executeBuy`, `executeSell` or order surface;
- no automatic LIVE promotion;
- no automatic Shadow-universe mutation;
- raw external instructions are never executed;
- evidence is normalized before entering Shadow Research;
- `index.js` remains unchanged in the Shadow stack.

## Acceptance gate

Technical readiness requires:

- real Exa search/fetch output structure inspected;
- syntax checks green;
- existing Shadow, Alpaca and Fundamental tests remain green;
- independent corroboration test passes;
- same-organization duplicates cannot fake corroboration;
- rumor-only evidence cannot produce a confirmed catalyst;
- material source disagreement becomes `CONFLICTING`;
- stale/future-dated evidence cannot produce a fresh catalyst;
- prompt-injection-like content is rejected;
- evidence is source-labelled and auditable;
- no trading functions are exposed;
- GitHub Actions is green.

## Empirical calibration gate

Before news evidence can carry larger decision weight, Shadow observation must measure:

- precision of confirmed catalysts;
- false-positive rate by source class;
- latency from event publication to observation;
- benefit of one primary source versus two independent sources;
- rumor false-positive/false-negative rates;
- forward returns after positive/negative event classes;
- performance after transaction-cost/slippage assumptions;
- whether adding news improves the quant-only Shadow baseline.

## Runtime integration gate

If Exa proves valuable enough for autonomous Render use, runtime API integration must be a separate PR with explicit credentials, rate-limit/cost controls, caching, retry/backoff, domain/source policies and a hard budget. The ChatGPT connector must never be treated as a hidden server dependency.

## Rollback

Remove the Exa catalyst-agent preload from `package.json`. Existing normalized evidence remains auditable and expires according to the Shadow Research TTL rules. No LIVE state migration is required.
