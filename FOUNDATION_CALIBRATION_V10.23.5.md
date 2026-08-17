# LEO-AI SENTINEL v10.23.5 — Foundation Calibration Bench

## Objective

Measure two things that code-only tests cannot prove:

1. whether Alpaca independently confirms eToro market observations often enough for the validator thresholds to be credible;
2. whether Exa catalyst classifications have measurable directional value after the event.

The bench is **Shadow-only**. It never sends an order, never requests market data, never calls OpenAI and never changes the LIVE universe or strategy.

## Inputs

The bench reads only snapshots already exposed inside the same Node.js process:

- `__LEO_SHADOW_LAB_STATE__`
- `__LEO_ALPACA_VALIDATOR_STATE__`
- `__LEO_EXA_CATALYST_STATE__`

It does not contain an Alpaca client, an Exa client or an eToro market-data client.

## Persistence

Calibration state is isolated from the production bot state.

Preferred backend: Upstash when the existing Upstash environment variables are present.

Fallback: local JSON file.

Default key:

`leo:foundation-calibration:v10.23.5`

No secret value is written to logs or calibration records.

## Alpaca calibration ledger

The bench deduplicates validator audit records by ID and accumulates them beyond the validator's short recent-audit window.

Metrics:

- total paired observations;
- count by `CONFIRMED`, `DIVERGENT`, `STALE`, `INCONCLUSIVE`;
- confirmed percentage;
- divergent percentage;
- average absolute price divergence recorded by the validator.

The bench does not average eToro and Alpaca prices. Divergence remains a quality signal.

## Exa predictive outcome ledger

For each Exa event, the bench stores:

- symbol;
- event key/type;
- catalyst status;
- direction score;
- confidence;
- source-group count;
- conflict/rumor ratios;
- a Shadow price anchor when the event and available Shadow price are close enough in time.

The default maximum anchor lag is 360 minutes. An event without a sufficiently close Shadow price remains unanchored rather than receiving a fabricated baseline.

Once anchored, later Shadow snapshots can produce outcomes at:

- J+1 / 24h;
- J+3 / 72h;
- J+7 / 168h.

For directional events, the bench calculates:

- directional hit/miss;
- raw return;
- signed edge (`return × sign(directionScore)`);
- aggregate hit rate;
- average signed edge.

This is a measurement layer, not a trading threshold. Positive early results are not sufficient to authorize LIVE use.

## Safety invariants

The module has:

- no eToro execution endpoint;
- no OpenAI client;
- no market-data client;
- no function able to trade or authorize LIVE;
- no automatic promotion path.

The only optional network activity is persistence to the already-configured Upstash store.

## Interpretation

The calibration bench should answer questions such as:

- “Out of the last 100 eToro/Alpaca comparisons, how often were they independently confirmed?”
- “How often did confirmed Exa catalysts point in the correct direction after 24h?”
- “Did rumor/conflicting classifications avoid creating false positive catalyst evidence?”
- “Is the average signed edge positive after enough observations, or is the apparent news value noise?”

No conclusion should be drawn from a tiny sample. The Cockpit keeps empirical readiness separate from technical readiness for exactly this reason.
