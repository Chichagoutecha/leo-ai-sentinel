const express = require("express");
const OpenAI = require("openai");
const cron = require("node-cron");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const VERSION = "v8.0-multi-agents-secure";
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AUTO_TRADE = process.env.AUTO_TRADE === "true";

const WATCHLIST = {
  NVDA: 8760,
  AMD: 1832,
  ORCL: 1135,
  MSFT: 8757,
  GOOG: 8758,
  AMZN: 8753,
  BABA: 2490,
  COIN: 9401,
  PLTR: 7991,
  RKLB: 14320,
  IONQ: 13596,
  ASTS: 10088,
  BTC: 100109,
  ETH: 100001,
  SOL: 100063
};

const ASSET_META = {
  NVDA: { category: "AI_BIG_TECH", risk: "medium", quality: "high" },
  AMD: { category: "AI_BIG_TECH", risk: "medium", quality: "high" },
  ORCL: { category: "AI_BIG_TECH", risk: "medium", quality: "high" },
  MSFT: { category: "AI_BIG_TECH", risk: "low", quality: "high" },
  GOOG: { category: "AI_BIG_TECH", risk: "low", quality: "high" },
  AMZN: { category: "AI_BIG_TECH", risk: "low", quality: "high" },

  BABA: { category: "CHINA_TECH", risk: "high", quality: "medium" },

  COIN: { category: "CRYPTO_EQUITY", risk: "high", quality: "medium" },
  BTC: { category: "CRYPTO", risk: "high", quality: "high" },
  ETH: { category: "CRYPTO", risk: "high", quality: "medium" },
  SOL: { category: "CRYPTO", risk: "very_high", quality: "medium" },

  PLTR: { category: "SPECULATIVE_AI", risk: "high", quality: "medium" },
  RKLB: { category: "SPACE", risk: "very_high", quality: "medium" },
  IONQ: { category: "QUANTUM", risk: "very_high", quality: "low_medium" },
  ASTS: { category: "SPACE", risk: "very_high", quality: "low_medium" }
};

const CONFIG = {
  maxBuyAmountUsd: 10,
  minBuyConfidence: 78,
  minSellConfidence: 70,
  cooldownHoursBuy: 6,
  maxOpenPositions: 6,
  maxCryptoPositions: 2,
  maxSpeculativePositions: 3,
  maxPendingOpenOrders: 0,
  maxOneOrderPerScan: true
};

const state = {
  scanRunning: false,
  lastCycle: null,
  lastTradeMemory: {}
};

const BASE_PROMPT = `
Tu es LEO-AI SENTINEL v8.0, une IA de trading autonome prudente.

MISSION :
Faire croître progressivement un petit portefeuille eToro, sans prise de risque excessive.

PRIORITÉ ABSOLUE :
1. Préserver le capital.
2. Éviter les achats impulsifs.
3. Éviter les doublons.
4. Acheter seulement si le signal est fort.
5. Vendre seulement si la protection du capital l'exige.

INTERDICTIONS :
- jamais de levier supérieur à 1
- jamais de short
- jamais de all-in
- jamais plus d'un ordre par scan
- jamais plus de 10 dollars par achat
- jamais d'actif hors watchlist
- jamais de FOMO
- si les données sont insuffisantes : HOLD

ACTIFS AUTORISÉS :
NVDA, AMD, ORCL, MSFT, GOOG, AMZN, BABA, COIN, PLTR, RKLB, IONQ, ASTS, BTC, ETH, SOL.

FORMAT FINAL OBLIGATOIRE :
{
  "decision":"BUY|SELL|HOLD",
  "asset":"NVDA|AMD|ORCL|MSFT|GOOG|AMZN|BABA|COIN|PLTR|RKLB|IONQ|ASTS|BTC|ETH|SOL|NONE",
  "amount_usd":0,
  "confidence":0,
  "reason":"explication courte",
  "risk_check":"passed|failed"
}
`;

function etoroHeaders() {
  return {
    "Content-Type": "application/json",
    "x-api-key": process.env.ETORO_API_KEY,
    "x-user-key": process.env.ETORO_USER_KEY,
    "x-request-id": randomUUID()
  };
}

function safeJsonStringify(value, maxLength = 10000) {
  try {
    const text = JSON.stringify(value);
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + "...TRUNCATED";
  } catch (error) {
    return JSON.stringify({ error: "Impossible de sérialiser", message: error.message });
  }
}

async function readApiResponse(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function pickValue(obj, keys) {
  if (!obj) return undefined;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return obj[key];
    }
  }

  return undefined;
}

function getNumberField(obj, keys, fallback = null) {
  const value = pickValue(obj, keys);

  if (value === undefined || value === null) return fallback;

  const number = Number(value);

  if (Number.isFinite(number)) return number;

  return fallback;
}

function getClientPortfolio(portfolioData) {
  const root = portfolioData?.data || portfolioData || {};
  return root.clientPortfolio || root.ClientPortfolio || {};
}

function getPositions(portfolioData) {
  const cp = getClientPortfolio(portfolioData);
  return cp.positions || cp.Positions || [];
}

function getOrdersForOpen(portfolioData) {
  const cp = getClientPortfolio(portfolioData);
  return cp.ordersForOpen || cp.OrdersForOpen || [];
}

function getOrdersForClose(portfolioData) {
  const cp = getClientPortfolio(portfolioData);
  return cp.ordersForClose || cp.OrdersForClose || [];
}

function getInstrumentId(item) {
  return getNumberField(item, [
    "instrumentID",
    "instrumentId",
    "InstrumentID",
    "InstrumentId"
  ]);
}

function getPositionId(position) {
  return pickValue(position, [
    "positionID",
    "positionId",
    "PositionID",
    "PositionId"
  ]);
}

function assetFromInstrumentId(instrumentId) {
  const id = Number(instrumentId);

  for (const [asset, knownId] of Object.entries(WATCHLIST)) {
    if (Number(knownId) === id) return asset;
  }

  return null;
}

function isCryptoAsset(asset) {
  return ["BTC", "ETH", "SOL"].includes(asset);
}

function isSpeculativeAsset(asset) {
  return ["PLTR", "RKLB", "IONQ", "ASTS", "COIN", "BABA", "SOL"].includes(asset);
}

function cooldownActive(asset) {
  const last = state.lastTradeMemory[asset];
  if (!last) return false;

  const diffHours = (Date.now() - last) / 1000 / 60 / 60;
  return diffHours < CONFIG.cooldownHoursBuy;
}

function markTrade(asset) {
  state.lastTradeMemory[asset] = Date.now();
}

function buildPortfolioAnalysis(portfolioData) {
  const cp = getClientPortfolio(portfolioData);

  const rawPositions = getPositions(portfolioData);
  const rawOrdersForOpen = getOrdersForOpen(portfolioData);
  const rawOrdersForClose = getOrdersForClose(portfolioData);

  const positions = rawPositions.map((p) => {
    const instrumentId = getInstrumentId(p);
    const asset = assetFromInstrumentId(instrumentId) || `UNKNOWN_${instrumentId || "NA"}`;

    return {
      asset,
      instrumentId,
      positionId: getPositionId(p),
      amount: getNumberField(p, ["amount", "invested", "initialAmount", "netInvestment"], null),
      profit: getNumberField(p, ["profit", "netProfit", "gain", "profitLoss"], null),
      profitPercent: getNumberField(p, ["profitPercent", "gainPercent", "profitPercentage"], null)
    };
  });

  const ordersForOpen = rawOrdersForOpen.map((o) => {
    const instrumentId = getInstrumentId(o);
    return {
      asset: assetFromInstrumentId(instrumentId) || `UNKNOWN_${instrumentId || "NA"}`,
      instrumentId,
      orderId: pickValue(o, ["orderID", "orderId", "OrderID", "OrderId"]),
      isBuy: pickValue(o, ["isBuy", "IsBuy"]),
      amount: getNumberField(o, ["amount", "Amount"], null),
      statusId: getNumberField(o, ["statusID", "statusId", "StatusID", "StatusId"], null)
    };
  });

  const ordersForClose = rawOrdersForClose.map((o) => {
    const instrumentId = getInstrumentId(o);
    return {
      asset: assetFromInstrumentId(instrumentId) || `UNKNOWN_${instrumentId || "NA"}`,
      instrumentId,
      orderId: pickValue(o, ["orderID", "orderId", "OrderID", "OrderId"]),
      statusId: getNumberField(o, ["statusID", "statusId", "StatusID", "StatusId"], null)
    };
  });

  const categoryCounts = {
    AI_BIG_TECH: 0,
    CHINA_TECH: 0,
    CRYPTO_EQUITY: 0,
    CRYPTO: 0,
    SPECULATIVE_AI: 0,
    SPACE: 0,
    QUANTUM: 0,
    UNKNOWN: 0
  };

  for (const position of positions) {
    const meta = ASSET_META[position.asset];
    if (!meta) {
      categoryCounts.UNKNOWN += 1;
    } else {
      categoryCounts[meta.category] = (categoryCounts[meta.category] || 0) + 1;
    }
  }

  const openAssets = positions
    .map((p) => p.asset)
    .filter((asset) => !asset.startsWith("UNKNOWN"));

  const cryptoPositions = openAssets.filter(isCryptoAsset).length;
  const speculativePositions = openAssets.filter(isSpeculativeAsset).length;

  const warnings = [];

  if (rawOrdersForOpen.length > 0) {
    warnings.push("Ordre d'ouverture déjà en attente : éviter nouvel achat.");
  }

  if (rawOrdersForClose.length > 0) {
    warnings.push("Ordre de fermeture déjà en attente : éviter nouvelle vente.");
  }

  if (positions.length >= CONFIG.maxOpenPositions) {
    warnings.push("Nombre maximum de positions atteint ou proche.");
  }

  if (cryptoPositions >= CONFIG.maxCryptoPositions) {
    warnings.push("Exposition crypto déjà élevée.");
  }

  if (speculativePositions >= CONFIG.maxSpeculativePositions) {
    warnings.push("Exposition spéculative déjà élevée.");
  }

  return {
    agent: "PortfolioAgent",
    positionsCount: positions.length,
    ordersForOpenCount: rawOrdersForOpen.length,
    ordersForCloseCount: rawOrdersForClose.length,
    positions,
    ordersForOpen,
    ordersForClose,
    openAssets,
    categoryCounts,
    cryptoPositions,
    speculativePositions,
    possibleCashOrCredit: getNumberField(cp, ["credit", "cash", "availableBalance", "balance"], null),
    warnings,
    recommendation:
      warnings.length > 0
        ? "Prudence renforcée. HOLD par défaut."
        : "Portefeuille lisible. Décision possible mais prudente."
  };
}

function hasOpenPosition(portfolioData, asset) {
  const instrumentId = WATCHLIST[asset];

  return getPositions(portfolioData).some((position) => {
    return Number(getInstrumentId(position)) === Number(instrumentId);
  });
}

function hasPendingOpenOrder(portfolioData, asset) {
  const instrumentId = WATCHLIST[asset];

  return getOrdersForOpen(portfolioData).some((order) => {
    return Number(getInstrumentId(order)) === Number(instrumentId);
  });
}

function hasPendingCloseOrder(portfolioData, asset) {
  const instrumentId = WATCHLIST[asset];

  return getOrdersForClose(portfolioData).some((order) => {
    return Number(getInstrumentId(order)) === Number(instrumentId);
  });
}

function findOpenPosition(portfolioData, asset) {
  const instrumentId = WATCHLIST[asset];

  return getPositions(portfolioData).find((position) => {
    return Number(getInstrumentId(position)) === Number(instrumentId);
  });
}

async function getPortfolio() {
  const response = await fetch(
    "https://public-api.etoro.com/api/v1/trading/info/portfolio",
    {
      method: "GET",
      headers: etoroHeaders()
    }
  );

  const data = await readApiResponse(response);

  return {
    status: response.status,
    ok: response.ok,
    data
  };
}

function extractJson(text) {
  if (!text) return null;

  let clean = String(text).trim();

  clean = clean
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    const first = clean.indexOf("{");
    const last = clean.lastIndexOf("}");

    if (first >= 0 && last > first) {
      try {
        return JSON.parse(clean.slice(first, last + 1));
      } catch {
        return null;
      }
    }

    return null;
  }
}

async function askJsonAgent(agentName, systemPrompt, userPrompt, fallback) {
  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: userPrompt
    }
  ];

  try {
    let completion;

    try {
      completion = await client.chat.completions.create({
        model: MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages
      });
    } catch {
      completion = await client.chat.completions.create({
        model: MODEL,
        temperature: 0.1,
        messages
      });
    }

    const raw = completion.choices?.[0]?.message?.content || "";
    const parsed = extractJson(raw);

    if (!parsed) {
      return {
        ...fallback,
        agent: agentName,
        error: "Réponse non JSON",
        raw
      };
    }

    return {
      ...parsed,
      agent: agentName
    };
  } catch (error) {
    return {
      ...fallback,
      agent: agentName,
      error: error.message
    };
  }
}

async function runMacroAgent(portfolioAnalysis) {
  return askJsonAgent(
    "MacroAgent",
    `
Tu es MacroAgent.
Tu évalues le contexte global MAIS tu ne dois pas inventer de données live.
Si tu n'as pas de données de marché en temps réel, tu dois rester prudent.
Réponds uniquement en JSON.

Format :
{
  "market_regime":"bull|bear|neutral|unknown",
  "macro_risk":"low|medium|high|unknown",
  "should_reduce_risk":false,
  "buy_environment":"good|acceptable|bad|unknown",
  "summary":"court résumé"
}
`,
    `
Voici l'analyse portefeuille :
${safeJsonStringify(portfolioAnalysis, 9000)}

Évalue le régime de marché de manière prudente.
`,
    {
      market_regime: "unknown",
      macro_risk: "unknown",
      should_reduce_risk: false,
      buy_environment: "unknown",
      summary: "Données macro insuffisantes : prudence."
    }
  );
}

async function runOpportunityAgent(portfolioAnalysis, macroAgent) {
  return askJsonAgent(
    "OpportunityAgent",
    `
Tu es OpportunityAgent.
Tu cherches une opportunité uniquement parmi la watchlist autorisée.
Tu n'as pas accès aux prix live sauf si fournis dans le portefeuille.
Tu dois éviter les doublons et éviter les actifs déjà détenus.
Par défaut, choisis HOLD si aucun signal fort.
Réponds uniquement en JSON.

Format :
{
  "action_bias":"BUY|SELL|HOLD",
  "preferred_asset":"NVDA|AMD|ORCL|MSFT|GOOG|AMZN|BABA|COIN|PLTR|RKLB|IONQ|ASTS|BTC|ETH|SOL|NONE",
  "confidence":0,
  "reason":"court",
  "avoid_assets":["NVDA"]
}
`,
    `
Watchlist autorisée :
${safeJsonStringify(WATCHLIST)}

Métadonnées actifs :
${safeJsonStringify(ASSET_META)}

PortfolioAgent :
${safeJsonStringify(portfolioAnalysis, 9000)}

MacroAgent :
${safeJsonStringify(macroAgent, 4000)}

Trouve une opportunité ou recommande HOLD.
`,
    {
      action_bias: "HOLD",
      preferred_asset: "NONE",
      confidence: 0,
      reason: "Aucun signal fort.",
      avoid_assets: []
    }
  );
}

async function runDecisionAgent(portfolioAnalysis, macroAgent, opportunityAgent) {
  return askJsonAgent(
    "DecisionAgent",
    `
${BASE_PROMPT}

Tu es DecisionAgent.
Tu prends la décision finale proposée, mais le RiskController validera ensuite.
Tu dois être très prudent.
Si aucune opportunité forte : HOLD.
Si l'actif est déjà détenu : éviter BUY.
Si l'environnement est inconnu : HOLD sauf signal exceptionnel.
Réponds uniquement en JSON strict au format final.
`,
    `
PortfolioAgent :
${safeJsonStringify(portfolioAnalysis, 9000)}

MacroAgent :
${safeJsonStringify(macroAgent, 4000)}

OpportunityAgent :
${safeJsonStringify(opportunityAgent, 4000)}

Décide BUY, SELL ou HOLD.
`,
    {
      decision: "HOLD",
      asset: "NONE",
      amount_usd: 0,
      confidence: 0,
      reason: "Fallback prudence : HOLD.",
      risk_check: "passed"
    }
  );
}

function holdDecision(reason) {
  return {
    decision: "HOLD",
    asset: "NONE",
    amount_usd: 0,
    confidence: 0,
    reason,
    risk_check: "passed"
  };
}

function normalizeDecision(rawDecision) {
  const allowedDecisions = ["BUY", "SELL", "HOLD"];

  let decision = String(rawDecision?.decision || "HOLD").toUpperCase().trim();
  let asset = String(rawDecision?.asset || "NONE").toUpperCase().trim();

  if (!allowedDecisions.includes(decision)) {
    decision = "HOLD";
  }

  if (!WATCHLIST[asset]) {
    asset = "NONE";
  }

  if (decision === "HOLD") {
    asset = "NONE";
  }

  if (decision !== "HOLD" && asset === "NONE") {
    decision = "HOLD";
  }

  let confidence = Number(rawDecision?.confidence || 0);

  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(100, confidence));

  let amount = Number(rawDecision?.amount_usd || 0);

  if (!Number.isFinite(amount)) amount = 0;

  if (decision === "BUY") {
    amount = Math.max(0, Math.min(CONFIG.maxBuyAmountUsd, amount));
  } else {
    amount = 0;
  }

  const reason = String(rawDecision?.reason || "Aucune raison fournie.").slice(0, 300);

  const riskCheck = rawDecision?.risk_check === "passed" ? "passed" : "failed";

  return {
    decision,
    asset,
    amount_usd: amount,
    confidence,
    reason,
    risk_check: riskCheck
  };
}

function securityCheckBuy(decision, portfolioData, portfolioAnalysis) {
  const asset = decision.asset;
  const amount = decision.amount_usd;

  if (!AUTO_TRADE) {
    return { passed: false, reason: "AUTO_TRADE désactivé" };
  }

  if (!WATCHLIST[asset]) {
    return { passed: false, reason: "Actif non autorisé" };
  }

  if (decision.confidence < CONFIG.minBuyConfidence) {
    return {
      passed: false,
      reason: `Confiance BUY trop faible (${decision.confidence} < ${CONFIG.minBuyConfidence})`
    };
  }

  if (amount <= 0 || amount > CONFIG.maxBuyAmountUsd) {
    return { passed: false, reason: "Montant BUY invalide ou supérieur à 10$" };
  }

  if (cooldownActive(asset)) {
    return { passed: false, reason: `Cooldown achat actif sur ${asset}` };
  }

  if (hasOpenPosition(portfolioData, asset)) {
    return { passed: false, reason: `Position déjà ouverte sur ${asset}` };
  }

  if (hasPendingOpenOrder(portfolioData, asset)) {
    return { passed: false, reason: `Ordre d'achat déjà en attente sur ${asset}` };
  }

  if (getOrdersForOpen(portfolioData).length > CONFIG.maxPendingOpenOrders) {
    return { passed: false, reason: "Un ordre d'ouverture est déjà en attente" };
  }

  if (portfolioAnalysis.positionsCount >= CONFIG.maxOpenPositions) {
    return { passed: false, reason: "Nombre maximum de positions atteint" };
  }

  if (isCryptoAsset(asset) && portfolioAnalysis.cryptoPositions >= CONFIG.maxCryptoPositions) {
    return { passed: false, reason: "Exposition crypto déjà trop élevée" };
  }

  if (isSpeculativeAsset(asset) && portfolioAnalysis.speculativePositions >= CONFIG.maxSpeculativePositions) {
    return { passed: false, reason: "Exposition spéculative déjà trop élevée" };
  }

  return { passed: true, reason: "Achat validé par RiskController" };
}

function securityCheckSell(decision, portfolioData) {
  const asset = decision.asset;

  if (!AUTO_TRADE) {
    return { passed: false, reason: "AUTO_TRADE désactivé" };
  }

  if (!WATCHLIST[asset]) {
    return { passed: false, reason: "Actif non autorisé" };
  }

  if (decision.confidence < CONFIG.minSellConfidence) {
    return {
      passed: false,
      reason: `Confiance SELL trop faible (${decision.confidence} < ${CONFIG.minSellConfidence})`
    };
  }

  if (hasPendingCloseOrder(portfolioData, asset)) {
    return { passed: false, reason: `Ordre de vente déjà en attente sur ${asset}` };
  }

  if (!hasOpenPosition(portfolioData, asset)) {
    return { passed: false, reason: `Aucune position ouverte sur ${asset}` };
  }

  return { passed: true, reason: "Vente validée par RiskController" };
}

function runRiskController(decision, portfolioData, portfolioAnalysis) {
  if (decision.decision === "HOLD") {
    return {
      agent: "RiskController",
      approved: true,
      reason: "HOLD autorisé",
      finalDecision: decision
    };
  }

  if (decision.risk_check !== "passed") {
    return {
      agent: "RiskController",
      approved: false,
      reason: "risk_check IA failed",
      finalDecision: holdDecision("Bloqué par RiskController : risk_check failed.")
    };
  }

  if (decision.decision === "BUY") {
    const check = securityCheckBuy(decision, portfolioData, portfolioAnalysis);

    return {
      agent: "RiskController",
      approved: check.passed,
      reason: check.reason,
      finalDecision: check.passed
        ? decision
        : holdDecision(`Bloqué par RiskController : ${check.reason}`)
    };
  }

  if (decision.decision === "SELL") {
    const check = securityCheckSell(decision, portfolioData);

    return {
      agent: "RiskController",
      approved: check.passed,
      reason: check.reason,
      finalDecision: check.passed
        ? decision
        : holdDecision(`Bloqué par RiskController : ${check.reason}`)
    };
  }

  return {
    agent: "RiskController",
    approved: false,
    reason: "Décision inconnue",
    finalDecision: holdDecision("Décision inconnue : HOLD forcé.")
  };
}

async function executeBuy(asset, amount, portfolioData, portfolioAnalysis) {
  const decision = {
    decision: "BUY",
    asset,
    amount_usd: amount,
    confidence: 100,
    reason: "Achat manuel ou automatique validé",
    risk_check: "passed"
  };

  const check = securityCheckBuy(decision, portfolioData, portfolioAnalysis);

  if (!check.passed) {
    return {
      skipped: true,
      reason: check.reason
    };
  }

  const instrumentId = WATCHLIST[asset];

  const response = await fetch(
    "https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-amount",
    {
      method: "POST",
      headers: etoroHeaders(),
      body: JSON.stringify({
        instrumentId,
        isBuy: true,
        leverage: 1,
        amount
      })
    }
  );

  const data = await readApiResponse(response);

  if (response.ok) {
    markTrade(asset);
  }

  return {
    status: response.status,
    ok: response.ok,
    type: "BUY",
    asset,
    instrumentId,
    amount,
    data
  };
}

async function executeSell(asset, portfolioData) {
  const decision = {
    decision: "SELL",
    asset,
    amount_usd: 0,
    confidence: 100,
    reason: "Vente manuelle ou automatique validée",
    risk_check: "passed"
  };

  const check = securityCheckSell(decision, portfolioData);

  if (!check.passed) {
    return {
      skipped: true,
      reason: check.reason
    };
  }

  const instrumentId = WATCHLIST[asset];
  const position = findOpenPosition(portfolioData, asset);

  const positionId = getPositionId(position);

  if (!positionId) {
    return {
      skipped: true,
      reason: "Position trouvée mais positionId introuvable",
      position
    };
  }

  const response = await fetch(
    `https://public-api.etoro.com/api/v1/trading/execution/market-close-orders/positions/${positionId}`,
    {
      method: "POST",
      headers: etoroHeaders(),
      body: JSON.stringify({
        InstrumentId: instrumentId,
        UnitsToDeduct: null
      })
    }
  );

  const data = await readApiResponse(response);

  if (response.ok) {
    markTrade(asset);
  }

  return {
    status: response.status,
    ok: response.ok,
    type: "SELL",
    asset,
    instrumentId,
    positionId,
    data
  };
}

async function runMultiAgentCycle({ executeTrade = true, source = "scan" } = {}) {
  const portfolio = await getPortfolio();

  if (!portfolio.ok) {
    return {
      version: VERSION,
      source,
      auto_trade_enabled: AUTO_TRADE,
      error: "Portfolio eToro inaccessible",
      portfolio_status: portfolio.status,
      portfolio_data: portfolio.data
    };
  }

  const portfolioAgent = buildPortfolioAnalysis(portfolio.data);
  const macroAgent = await runMacroAgent(portfolioAgent);
  const opportunityAgent = await runOpportunityAgent(portfolioAgent, macroAgent);
  const decisionAgentRaw = await runDecisionAgent(
    portfolioAgent,
    macroAgent,
    opportunityAgent
  );

  const proposedDecision = normalizeDecision(decisionAgentRaw);
  const riskController = runRiskController(
    proposedDecision,
    portfolio.data,
    portfolioAgent
  );

  const finalDecision = riskController.finalDecision;

  let execution = {
    skipped: true,
    reason: executeTrade ? "Aucun ordre exécuté" : "Dry-run : aucune exécution"
  };

  if (executeTrade && finalDecision.decision === "BUY") {
    execution = await executeBuy(
      finalDecision.asset,
      Number(finalDecision.amount_usd),
      portfolio.data,
      portfolioAgent
    );
  }

  if (executeTrade && finalDecision.decision === "SELL") {
    execution = await executeSell(finalDecision.asset, portfolio.data);
  }

  const result = {
    version: VERSION,
    source,
    model: MODEL,
    auto_trade_enabled: AUTO_TRADE,
    portfolio_status: portfolio.status,
    agents: {
      portfolioAgent,
      macroAgent,
      opportunityAgent,
      decisionAgentRaw,
      proposedDecision,
      riskController
    },
    decision: finalDecision,
    execution
  };

  state.lastCycle = {
    at: new Date().toISOString(),
    source,
    decision: finalDecision,
    execution
  };

  return result;
}

async function guardedCycle({ executeTrade = true, source = "scan" } = {}) {
  if (state.scanRunning) {
    return {
      version: VERSION,
      skipped: true,
      reason: "Un scan est déjà en cours"
    };
  }

  state.scanRunning = true;

  try {
    return await runMultiAgentCycle({ executeTrade, source });
  } finally {
    state.scanRunning = false;
  }
}

function manualConfirm(req) {
  return req.query.confirm === "true" || req.query.confirm === "1";
}

app.get("/", (req, res) => {
  res.send("LEO-AI SENTINEL v8.0 multi-agents secure actif");
});

app.get("/health", (req, res) => {
  res.json({
    version: VERSION,
    ok: true,
    auto_trade_enabled: AUTO_TRADE,
    model: MODEL,
    time: new Date().toISOString()
  });
});

app.get("/watchlist", (req, res) => {
  res.json({
    version: VERSION,
    watchlist: WATCHLIST,
    asset_meta: ASSET_META
  });
});

app.get("/etoro-test", async (req, res) => {
  try {
    res.json(await getPortfolio());
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/portfolio", async (req, res) => {
  try {
    const portfolio = await getPortfolio();
    const analysis = buildPortfolioAnalysis(portfolio.data);

    res.json({
      version: VERSION,
      portfolio_status: portfolio.status,
      ok: portfolio.ok,
      analysis,
      raw: req.query.raw === "true" ? portfolio.data : undefined
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/status", async (req, res) => {
  try {
    const portfolio = await getPortfolio();
    const analysis = buildPortfolioAnalysis(portfolio.data);

    const cooldownMemory = Object.fromEntries(
      Object.entries(state.lastTradeMemory).map(([asset, timestamp]) => [
        asset,
        new Date(timestamp).toISOString()
      ])
    );

    res.json({
      version: VERSION,
      auto_trade_enabled: AUTO_TRADE,
      model: MODEL,
      config: CONFIG,
      watchlist: WATCHLIST,
      positions_count: analysis.positionsCount,
      orders_for_open_count: analysis.ordersForOpenCount,
      orders_for_close_count: analysis.ordersForCloseCount,
      open_assets: analysis.openAssets,
      warnings: analysis.warnings,
      cooldown_memory: cooldownMemory,
      last_cycle: state.lastCycle
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/agents", async (req, res) => {
  try {
    const result = await guardedCycle({
      executeTrade: false,
      source: "agents-dry-run"
    });

    res.json(result);
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/scan", async (req, res) => {
  try {
    const result = await guardedCycle({
      executeTrade: true,
      source: "manual-scan"
    });

    res.json(result);
  } catch (error) {
    res.json({ error: "Erreur scan : " + error.message });
  }
});

app.get("/buy-test", async (req, res) => {
  try {
    if (!manualConfirm(req)) {
      return res.json({
        skipped: true,
        reason:
          "Confirmation requise pour éviter un achat accidentel. Ajoute &confirm=true à l'URL."
      });
    }

    const asset = String(req.query.asset || "").toUpperCase().trim();
    const amount = Number(req.query.amount || 10);

    if (!asset || !WATCHLIST[asset]) {
      return res.json({
        error: "Actif invalide. Exemple : /buy-test?asset=NVDA&amount=10&confirm=true",
        allowed_assets: Object.keys(WATCHLIST)
      });
    }

    const portfolio = await getPortfolio();
    const analysis = buildPortfolioAnalysis(portfolio.data);

    res.json(await executeBuy(asset, amount, portfolio.data, analysis));
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/sell-test", async (req, res) => {
  try {
    if (!manualConfirm(req)) {
      return res.json({
        skipped: true,
        reason:
          "Confirmation requise pour éviter une vente accidentelle. Ajoute &confirm=true à l'URL."
      });
    }

    const asset = String(req.query.asset || "").toUpperCase().trim();

    if (!asset || !WATCHLIST[asset]) {
      return res.json({
        error: "Actif invalide. Exemple : /sell-test?asset=NVDA&confirm=true",
        allowed_assets: Object.keys(WATCHLIST)
      });
    }

    const portfolio = await getPortfolio();

    res.json(await executeSell(asset, portfolio.data));
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/resolve-symbol", async (req, res) => {
  try {
    const symbol = req.query.symbol;

    if (!symbol) {
      return res.json({
        error: "Ajoute ?symbol=NVDA par exemple"
      });
    }

    const response = await fetch(
      `https://public-api.etoro.com/api/v1/market-data/search?internalSymbolFull=${encodeURIComponent(symbol)}&fields=instrumentId,internalSymbolFull,displayname`,
      {
        method: "GET",
        headers: etoroHeaders()
      }
    );

    const data = await readApiResponse(response);

    res.json({
      symbol,
      status: response.status,
      ok: response.ok,
      data
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

cron.schedule("0 */2 * * *", async () => {
  console.log("Scan automatique v8.0 multi-agents lancé");

  const result = await guardedCycle({
    executeTrade: true,
    source: "cron-2h"
  });

  console.log("Résultat scan v8.0 :", safeJsonStringify(result, 6000));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`LEO-AI SENTINEL ${VERSION} lancé sur le port ${PORT}`);
});
