# Production AI Preflight — v10.22.9.3

## Purpose
Prevent a future production process from starting with an incorrect AI preload composition.

The current Render service has already demonstrated why preload order matters: the AI Cost Optimizer routes requests to GPT-5.6 Luna, and the Luna compatibility shim must remove the legacy explicit `temperature` before the provider request.

## Fail-fast checks
`production-ai-preflight.js` is designed to run after the AI Cost Optimizer and Luna compatibility shim and before `index.js`.

It refuses startup if:
- AI Cost Optimizer is not already preloaded;
- Luna compatibility shim is not already preloaded;
- legacy `etoro-execution-diagnostics.js` is present in the process;
- optimizer runtime global is missing;
- optimizer no longer force-routes the representative legacy request to `gpt-5.6-luna`;
- the 1200 completion-token cap is no longer applied;
- legacy `max_tokens` survives optimizer normalization;
- Luna sanitizer no longer removes explicit `temperature` under forced Luna routing.

## Zero-call design
The preflight does not call:
- OpenAI;
- eToro;
- Upstash;
- any market-data provider.

It only inspects already-loaded module exports/cache and performs local parameter normalization. It exposes no trading authority and does not log secrets.

## Repository start chain proposed
`ai-cost-optimizer -> ai-luna-temperature-compat -> production-ai-preflight -> index.js`

This is a DRAFT proposal only. The currently running Render command is not changed by this branch. Any future Render/main promotion still requires the separate production validation rule.