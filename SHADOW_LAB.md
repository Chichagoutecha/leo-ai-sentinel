# LEO-AI SENTINEL — Shadow Intelligence Lab v10.23.0

## Purpose

The Shadow Intelligence Lab is a **read-only research layer**. It observes a wider universe than the LIVE allowlist, ranks candidates, creates hypothetical shadow signals, and measures their forward performance. It must never place, close, modify, or cancel an eToro order.

## Phase 1 — implemented

- Broader shadow-only universe (`shadow-universe.json`), initially 83 symbols across ETFs, big tech, semiconductors, AI/data, cyber, space, quantum, defense, healthcare, energy, finance, consumer, China and crypto.
- Exact eToro symbol -> instrument ID resolution through the official market-data Search endpoint.
- Instrument IDs cached persistently.
- Read-only eToro rate snapshots in batches.
- Deterministic candidate score using price freshness, spread and observed 24h / 3d / 7d shadow momentum.
- Hypothetical `SHADOW_BUY_CANDIDATE` signals only.
- Forward outcome tracking at J+1, J+3, J+7 and J+30.
- Hit rate, average return and median return by horizon.
- Separate persistent state from the production trading state.
- Upstash persistence when available, local-file fallback otherwise.
- Default scan schedule: `25 */4 * * *` to stay away from the production trade scan at minute 00 and the production watch schedule.
- Startup scan delayed by 12 minutes.
- Zero OpenAI calls and zero OpenAI cost in Phase 1.

## Hard safety boundary

The module contains no order-execution function. Its eToro helper is GET-only and explicitly rejects URLs containing `/trading/execution/`. It does not modify `LIVE_EXECUTION_ARMED`, `WATCHLIST`, allocation, sizing, the RiskController, or the ExecutionVerifier.

## Default runtime limits

- Maximum universe: 100 symbols.
- New eToro symbol resolutions per shadow scan: 16.
- Candidate leaderboard: top 15.
- New shadow signals per scan: max 5.
- Maximum accepted spread for a shadow candidate: 2.5%.
- No OpenAI calls.

These limits can be changed later through `SHADOW_LAB_*` environment variables without touching LIVE trading rules.

## What the plugins can help with

Connected ChatGPT plugins are useful as **research and development assistants**, but they are not automatically callable by the unattended Render process.

- **Alpaca**: independent historical OHLCV, quotes and market-data cross-checks; useful to validate whether eToro-derived shadow signals survive on an independent price source.
- **Quartr**: earnings calls, filings, slides and standardized company financials; useful for a later Fundamental Shadow Agent.
- **Exa**: current web/news/research discovery; useful for a later News/Research Shadow Agent and for discovering emerging candidate companies.

If one of these sources is later required inside the autonomous Render bot, it needs a proper runtime API integration/credential path. Until then, plugins should be used to validate and improve the research design without becoming a hidden LIVE dependency.

## Planned next phases

1. **Independent Data Validation** — compare selected shadow signals with Alpaca historical data and measure cross-provider agreement.
2. **Fundamental Shadow Agent** — add earnings/financial quality features, initially evaluated offline with Quartr research.
3. **News & Research Shadow Agent** — test whether fresh news/research improves forward returns versus the deterministic baseline.
4. **AI Value Test** — only after enough baseline observations, let a low-cost model review a small number of finalists and compare `quant-only` versus `quant + AI` performance and cost.
5. **Promotion Gate** — no new asset becomes LIVE-eligible until it has sufficient shadow observations, acceptable drawdown, stable data quality and explicit human approval.

## Promotion rule

A shadow asset is **not** a LIVE asset. Being present in `shadow-universe.json`, ranking highly, or producing good hypothetical returns never authorizes a real order. LIVE promotion must be a separate, explicit code/config change after validation.
