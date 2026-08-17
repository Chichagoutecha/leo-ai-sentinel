# v10.23.3 — Quartr Fundamental Intelligence Agent

## Purpose

Create a provider-decoupled, auditable fundamental-quality engine for the Shadow Research stack. It is designed to consume company-reported data, ideally normalized from Quartr filings/financials, without granting any ability to trade.

## Current Quartr connector status

A real connector check was attempted during development. The connected Quartr account currently requires a **Quartr Pro subscription** before the MCP/company-data tools can be used.

Therefore this version does **not** claim real Quartr payload validation. It implements and tests a strict normalized adapter contract. Once Quartr access is available, a separate adapter-validation pass must map actual `get_financials`, filings, guidance and transcript fields into this contract and add captured schema fixtures/tests before the connector can be considered validated.

No Quartr credential or subscription is required for this code to remain safely dormant.

## Normalized adapter contract

Each bundle contains:

- ticker/symbol and optional Quartr company ID/name;
- currency;
- at least two reporting periods;
- period end and reported/filed date;
- revenue;
- gross profit;
- operating income;
- net income;
- diluted EPS;
- operating cash flow;
- capital expenditures;
- cash and equivalents;
- total debt;
- optional guidance;
- optional normalized management-commentary score and summary;
- an auditable source reference.

The module derives free cash flow and profit/cash-flow margins from those inputs.

## Fundamental score

The generic non-financial-company score is intentionally transparent:

- revenue growth: 25%;
- profitability level/trend: 25%;
- free-cash-flow quality/trend: 20%;
- balance-sheet quality: 20%;
- earnings quality: 10%;
- bounded guidance adjustment.

Output status:

- `STRONG`;
- `HEALTHY`;
- `MIXED`;
- `WEAK`;
- `INCONCLUSIVE`.

Hard quality flags include revenue contraction, negative operating margin, negative free cash flow, very high debt/cash and deteriorating/withdrawn guidance.

## Important sector limitation

The generic debt/cash and margin model is **not appropriate for banks, insurers and some other financial institutions**. Balance-sheet leverage is structurally different in those businesses. Until a sector-specific financials model is added, outputs for names such as banks must remain research context only and must not be promoted to a LIVE decision gate from this generic score.

REITs, early-stage biotech, pre-revenue companies and commodity producers may also require sector-specific metrics before their fundamental score becomes decision-grade.

## Guidance and management commentary

Guidance can add or subtract only a bounded amount from the numeric score. It cannot override poor cash-flow/balance-sheet evidence.

Management commentary is sanitized before storage. Prompt-like instructions, HTML, raw links and trading commands are filtered. Commentary becomes a separate `MANAGEMENT_COMMENTARY` evidence item rather than executing or modifying any system instruction.

## Research evidence

Usable reports can emit:

- `FUNDAMENTAL`;
- `CASH_FLOW`;
- `BALANCE_SHEET`;
- `GUIDANCE` when present;
- `MANAGEMENT_COMMENTARY` when present.

All evidence is source-labelled `QUARTR`. Multiple evidence items from Quartr still count as **one independent source** inside the Shadow Research Layer.

## Safety invariants

- no Quartr network client inside the module;
- no eToro execution client;
- no OpenAI call;
- no `executeBuy`, `executeSell` or order surface;
- no automatic LIVE promotion;
- no automatic Shadow-universe mutation;
- stale/future-dated reports become `INCONCLUSIVE`;
- raw external instructions are never executed;
- `index.js` remains unchanged in the stacked Shadow PRs.

## Acceptance gate

Technical readiness requires:

- syntax checks green;
- existing Shadow/Alpaca tests remain green;
- strong synthetic company scores high with no false risk flags;
- deteriorating synthetic company is classified weak and produces the expected flags;
- stale and future reports are rejected as inconclusive;
- prompt-like commentary is sanitized;
- evidence types and source labels are correct;
- ingestion cannot expose a trading function;
- GitHub Actions is green.

## Connector validation gate

After Quartr Pro access is available:

1. validate company lookup/ticker mapping;
2. capture representative standardized financial payload schemas for several sectors;
3. map statement fields with units/currency/period semantics explicitly;
4. validate restatements and missing values;
5. validate latest filing/report timestamps;
6. map guidance and transcripts without treating generated summaries as company-reported numbers;
7. run regression fixtures for at least a profitable tech company, a cyclical company and a financial institution;
8. only then consider Quartr data acquisition connector-validated.

## Empirical gate

Even after connector validation, score weights must be evaluated in Shadow against forward outcomes and benchmarks. A high fundamental score is not itself a BUY signal.

## Rollback

Remove the fundamental-agent preload from `package.json`. Existing research evidence remains auditable and expires under the Shadow Research TTL policy. No LIVE state migration is required.
