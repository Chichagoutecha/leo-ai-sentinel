# LEO-AI SENTINEL — Shadow Intelligence Lab v10.23.1

## Purpose

The Shadow Intelligence Lab is a **read-only research layer**. It observes a wider universe than the LIVE allowlist, ranks candidates, creates hypothetical shadow signals, measures their forward performance, and now combines market evidence with plugin-assisted research evidence. It must never place, close, modify, or cancel an eToro order.

## Phase 1 — deterministic market lab

- Broader shadow-only universe (`shadow-universe.json`), initially 83 symbols across ETFs, big tech, semiconductors, AI/data, cyber, space, quantum, defense, healthcare, energy, finance, consumer, China and crypto.
- Exact eToro symbol -> instrument ID resolution through the official market-data Search endpoint.
- Instrument IDs cached persistently.
- Read-only eToro rate snapshots in batches.
- Deterministic candidate score using price freshness, spread and observed 24h / 3d / 7d shadow momentum.
- Hypothetical `SHADOW_BUY_CANDIDATE` signals only.
- Forward outcome tracking at J+1, J+3, J+7 and J+30.
- Hit rate, average return and median return by horizon.
- Separate persistent state from production trading state.
- Default scan schedule: `25 */4 * * *`.
- Zero OpenAI calls and zero OpenAI cost.

## Phase 2 — Plugin Research Layer — implemented on this branch

`shadow-research-layer.js` is an auditable evidence registry for research produced with sources such as Alpaca, Quartr and Exa. The connected ChatGPT plugins themselves are **not** assumed to exist inside Render; the layer defines a safe normalized boundary so research can be tested without creating a hidden LIVE dependency.

Source contracts are stored in `shadow-research-sources.json`:

- **Alpaca** — independent market confirmation, OHLCV/quote/liquidity/volatility research.
- **Quartr** — company-reported fundamentals, earnings, guidance, balance sheet, cash flow and management commentary.
- **Exa** — current news, research, catalysts, risks and discovery of emerging companies.
- **eToro Shadow** — read-only broker market observations.
- **Manual Research** — auditable human/ChatGPT notes with deliberately lower default reliability.

Each evidence item has a symbol, source, evidence kind, directional score, confidence, timestamp and expiry. Old evidence decays/expires, contradictory evidence receives a conflict penalty, and source reliability is explicit.

A single source is never sufficient for promotion eligibility. Default research promotion requirements are:

- at least **2 independent sources**;
- research score >= **70/100**;
- confidence >= **0.65**;
- still **no automatic universe mutation and no LIVE promotion**.

## Phase 3 — Opportunity Discovery Agent — implemented on this branch

`shadow-opportunity-discovery.js` combines:

- the latest deterministic Shadow Lab market ranking;
- the normalized Research Layer score;
- independent-source count and confidence;
- shadow-universe priority/theme;
- spread and data freshness penalties.

It produces two research-only outputs:

1. `PRIORITY_SHADOW_RESEARCH` for existing shadow assets worth deeper study.
2. `ELIGIBLE_FOR_SHADOW_UNIVERSE_REVIEW` for research-discovered symbols outside the current 83-symbol universe when at least two independent sources support them strongly.

Crucially, `ELIGIBLE_FOR_SHADOW_UNIVERSE_REVIEW` means **review only**. The agent does not edit `shadow-universe.json`, does not edit the LIVE `WATCHLIST`, and cannot trade.

Default discovery schedule: `38 */4 * * *`, after the Shadow market scan at minute 25.

## Hard safety boundary

- No order-execution function in the Shadow modules.
- Shadow eToro helper is GET-only and explicitly rejects `/trading/execution/` URLs.
- No modification of `LIVE_EXECUTION_ARMED`, production `WATCHLIST`, allocation, sizing, RiskController or ExecutionVerifier.
- `automaticLivePromotion: false`.
- `automaticShadowUniverseMutation: false`.
- Zero OpenAI calls in current Shadow market/research/discovery phases.

## Plugin workflow

Plugins can already help the R&D process from ChatGPT:

1. **Alpaca** cross-checks whether a promising eToro shadow signal is supported by an independent market-data source.
2. **Quartr** checks whether company fundamentals/results support or contradict the market signal.
3. **Exa** searches for current catalysts, risks, academic/industry research and previously unknown candidate companies.
4. The findings are normalized into the Shadow Research Layer and evaluated against future returns.

Only if a source proves useful statistically should we consider integrating its runtime API directly into Render.

## What comes next

1. **Independent Data Validation experiment** — use Alpaca on selected signals and quantify eToro/Alpaca agreement.
2. **Fundamental Shadow experiment** — use Quartr evidence and test whether fundamental quality improves J+7/J+30 outcomes.
3. **News/Catalyst experiment** — use Exa and test whether fresh catalysts improve returns or merely add noise.
4. **Profitability Guard** — measure gains/losses, infrastructure cost and AI cost per useful decision.
5. **AI Value Test** — only after enough deterministic observations, let a cheap model review a few finalists and compare `quant-only` vs `quant + AI`.
6. **Promotion Gate** — no new asset becomes LIVE-eligible without sufficient observations, acceptable drawdown, stable data quality and explicit approval.

## Promotion rule

A shadow asset is **not** a LIVE asset. Ranking highly, being supported by plugins, or generating good hypothetical returns never authorizes a real order. LIVE promotion remains a separate, explicit code/config change after validation.
