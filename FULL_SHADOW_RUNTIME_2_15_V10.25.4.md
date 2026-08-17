# Full Shadow Runtime Integration — stages 2–15

## Purpose
Prove that the hardened Shadow foundation (2–5), support layers (6–10) and critical macro/risk layers (11–15) can coexist in one Node.js process without gaining LIVE authority or crashing on known malformed handoffs.

This branch does not modify the production entrypoint, Render Start Command or `LIVE_EXECUTION_ARMED`.

## Composition order used in validation
1. Shadow Research Layer
2. Alpaca Independent Validator
3. Quartr Fundamental Agent
4. Exa News/Catalyst Agent
5. Foundation Runtime Guard
6. Shadow Intelligence Lab
7. Macro Intelligence
8. Event Risk Calendar
9. Market Regime Engine 2.0
10. Portfolio Optimizer 2.0
11. Institutional Risk Engine
12. Opportunity Discovery 2.0
13. Dynamic Universe Manager
14. Profitability & Cost Guard
15. Adaptive AI Router
16. AI Value Experiment
17. Roadmap 6–15 Preflight
18. Full Stack 2–15 Preflight

The ordering intentionally places the runtime guard after the Stage 3–5 modules so it can wrap their exported/public adaptor surfaces and globals before the wider stack uses them.

## Full-stack preflight
`shadow-full-stack-preflight.js` checks every required component in one process. It supports both synchronous and asynchronous state functions and requires:

- every component global to be present;
- no state-snapshot exception;
- all standard layers to expose `canTrade:false` and `canAuthorizeLive:false`;
- Shadow Lab to expose `canTrade:false`, `executionEndpointAllowed:false` and no LIVE allowlist mutation;
- Foundation Runtime Guard to be loaded;
- no production promotion authority.

A green preflight returns `readyForFullShadowRuntime:true`, which means only that the research stack is technically composable.

## Runtime tests
The branch runs four complementary classes of tests:

1. **Full process composition 2–15** — all modules load in one Node process and all state surfaces remain safe.
2. **Functional handoff 6–15** — a realistic deterministic path passes from Opportunity Discovery through Dynamic Universe, profitability/AI policy, macro/event/regime, portfolio optimization and institutional risk.
3. **Adversarial regression 2–5 / 6–10 / 11–15** — malformed nulls, wrong shapes, bad dates, non-finite numbers, duplicate observations and incomplete risk evidence are exercised again.
4. **Production isolation** — `index.js` and production `package.json` must be byte-for-byte unchanged relative to the branch base.

## Safety interpretation
No test here sends an eToro order, calls OpenAI, changes the LIVE universe or authorizes a production merge. Full-stack readiness is explicitly distinct from empirical validation and LIVE promotion.

Stage 1 eToro execution safety remains a separate production-validation gate because its strongest proof requires a real accepted eToro order plus portfolio reread.