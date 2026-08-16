# v10.23.2 — Alpaca Independent Data Validator

## Purpose

Use Alpaca as a genuinely independent market-data source to challenge eToro Shadow observations before a candidate receives stronger research confidence.

This is **research-only**. The validator cannot place an order, cannot authorize LIVE, and does not contain an Alpaca network client.

## Why no runtime Alpaca client yet

The connected Alpaca plugin is available to the ChatGPT research workflow, but Render does not automatically inherit that connection. Treating a ChatGPT plugin as if it were a server credential would create a hidden and fragile production dependency.

Therefore v10.23.2 deliberately separates:

1. **data acquisition** — supplied by a trusted research adapter/plugin;
2. **normalization and comparison** — implemented in `shadow-alpaca-validator.js`;
3. **persistent research evidence** — delegated to `shadow-research-layer.js`.

A future runtime API integration must be a separate reviewed change with explicit credentials, rate-limit handling and cost analysis.

## Supported observations

The normalizer accepts the Alpaca snapshot structure used by the connected plugin:

- `latest_quote`;
- `latest_trade`;
- `minute_bar`;
- `daily_bar`;
- `previous_daily_bar`.

It handles stocks/ETFs such as `SPY` and crypto pairs such as `BTC/USD`, normalizing the latter to the eToro-style base symbol (`BTC`).

## Cross-provider gates

A report is classified as:

- `CONFIRMED` — both providers are fresh, spreads acceptable, and prices agree within the configured divergence threshold;
- `DIVERGENT` — both providers are usable but the price difference exceeds the threshold;
- `STALE` — a required provider timestamp is too old or materially future-dated;
- `INCONCLUSIVE` — malformed symbol/data, missing quote quality, excessive spread, or other insufficient-quality state.

The validator **never averages away a material disagreement** between providers.

Default divergence limits:

- stocks/ETFs: 0.8%;
- crypto: 1.5%.

Default maximum ages are 20 minutes and are intentionally configurable by the caller. During weekends/closed equity sessions the caller should not pretend that a Friday quote is live; it should either use an appropriate market-session policy or leave the result stale/inconclusive.

## Alpaca feed caveat

The free IEX feed is useful as an independent price source, but it is not the complete US consolidated tape. Its absolute volume/trade-count values must not be treated as equivalent to SIP/full-market volume. Liquidity evidence therefore emphasizes quote quality/spread and treats volume as contextual research only.

A paid SIP feed should only be considered later if measured trading value justifies its cost.

## Evidence written to Shadow Research

Usable reports can emit ALPACA evidence of these kinds:

- `MARKET_CONFIRMATION`;
- `LIQUIDITY`;
- `VOLATILITY`.

Stale/inconclusive reports emit no active research evidence. Divergent fresh reports emit negative market-confirmation evidence rather than disappearing from the audit trail.

## Safety invariants

- no `executeBuy`, `executeSell` or order function;
- no Alpaca or eToro network client;
- no OpenAI call;
- no automatic Shadow-universe mutation;
- no automatic LIVE promotion;
- no modification of `index.js`;
- persisted audit stores only normalized metrics, not credentials or raw secret-bearing responses.

## Acceptance gate

Before v10.23.2 is considered technically ready:

- syntax checks pass;
- existing Shadow tests remain green;
- Alpaca tests prove stock and crypto normalization;
- aligned observations are confirmed;
- material divergence is rejected as `DIVERGENT`;
- stale/future timestamps are rejected;
- stale data creates no active evidence;
- the module exposes no trading function;
- stacked PR CI is green.

## Empirical gate

Technical readiness is not statistical proof. Before Alpaca evidence receives any stronger production role, collect enough paired eToro/Alpaca observations to measure:

- median and tail price divergence;
- false divergence rate;
- divergence by asset class and market session;
- freshness failures;
- usefulness of IEX versus any future paid feed.

## Rollback

Remove the validator preload from `package.json` and delete/ignore the validator module. Research evidence already stored remains auditable but expires according to the Shadow Research TTL rules. No LIVE state migration is required.
