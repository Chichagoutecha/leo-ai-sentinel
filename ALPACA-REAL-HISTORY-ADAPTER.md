# Alpaca real-history adapter — Stage 11-15 calibration bridge

Status: **Shadow only / DRAFT / no LIVE authority**.

## Why
The real-history contract now needs actual provider data without introducing lookahead leakage or redistributing raw vendor datasets in the repository. This adapter accepts already-retrieved Alpaca daily bars and converts them into the existing point-in-time row schema.

## Conservative availability rule
For daily bars, bar `i-1` is not used until the timestamp of the next common session `i`. This intentionally gives up some timing precision to avoid accidentally treating a session close as known before it was available.

Each generated row carries Alpaca provenance (`provider`, `dataset`, `symbol`, `field`, `observedAt`, `availableAt`, `retrievedAt`) and is validated by `shadow-real-history-contract-11-15.js`.

## What is derived from price history
Only price-derived fields are emitted: breadth, SPY trend proxy, SPY realized-volatility proxy and XLE energy trend proxy. The adapter deliberately does **not** invent VIX, credit stress or macro observations. Output status is therefore `READY_FOR_MACRO_ENRICHMENT`, not full Stage 11-15 empirical validation.

## Connected-provider smoke, 2026-08-17
A read-only Alpaca historical-data smoke query successfully returned 1-day IEX bars for SPY, QQQ, GLD, TLT, XLV and XLE over 2022-01-03 through 2022-03-31: **372 records total, 62 per symbol**. Raw vendor bars are intentionally not committed here.

This proves provider access and symbol coverage only. It does not prove profitability, predictive value, or full historical calibration.

## Safety
- zero network calls inside the adapter;
- zero OpenAI calls;
- zero eToro calls;
- no `index.js` change;
- no production start change;
- `canTrade=false`, `canAuthorizeLive=false`, `livePromotionAllowed=false`.

## Next
Acquire a longer approved historical window, enrich rows with point-in-time macro/event provenance, then run expanding/rolling walk-forward replay out of sample and score detection latency, false-defensive rate, missed-risk rate, turnover and recovery lag.
