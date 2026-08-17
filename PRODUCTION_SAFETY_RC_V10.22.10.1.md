# v10.22.10.1 — Production Safety Release Candidate

## Purpose
Combine the already-green production AI hardening stack with the corrected eToro execution diagnostic in one isolated rehearsal branch.

## Important: the eToro diagnostic is NOT activated
`package.json` and the current production start chain are intentionally unchanged from the AI release candidate. The safe eToro diagnostic is present only for integration testing until a separate LIVE validation is explicitly authorized.

## eToro invariant
The diagnostic classifies every eToro execution write, but its local ambiguity breaker is eligible only for URLs in the `market-open-orders` family.

- ambiguous new OPEN: may arm the local new-open breaker;
- subsequent new OPEN while breaker is active: blocked locally;
- CLOSE/reduce/SELL execution route: always forwarded to the provider;
- ambiguous CLOSE/reduce: diagnostic only, never arms the breaker.

A 2xx response without business acknowledgement remains ambiguous and is never treated as proof of a filled position.

## Combined-stack validation
The integration test loads the safe eToro diagnostic together with:

1. AI cost optimizer;
2. GPT-5.6 Luna compatibility shim;
3. AI context optimizer.

It proves that an ambiguous OPEN can arm the new-open breaker, a second OPEN is blocked before provider, a CLOSE still reaches provider, and a GPT-5.6 Luna completion still succeeds through the same process.

## Non-goals
This branch does not:

- change `index.js`;
- change strategy or sizing;
- change `LIVE_EXECUTION_ARMED`;
- activate the eToro diagnostic on Render;
- force an order;
- claim an eToro fill without portfolio/order proof.

## Promotion gate
Activation requires separate LIVE authorization and a reviewed real execution cycle. The success criterion remains portfolio/order evidence (`POSITION_CONFIRMED` or equivalent business proof), not HTTP 2xx alone.
