const express = require("express");
const OpenAI = require("openai");
const cron = require("node-cron");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const VERSION = "v9.0-marketdata-agent-autonomous";

const AUTO_TRADE = process.env.AUTO_TRADE === "true";
const BOT_SECRET = process.env.BOT_SECRET || "";

/*
  Option stricte :
  - false par défaut pour éviter de bloquer le bot si l'endpoint rates eToro répond mal.
  - si tu veux forcer le bot à n'exécuter QUE si le prix live est disponible :
    ajoute dans Render Environment :
    REQUIRE_FRESH_RATE_FOR_EXECUTION=true
*/
const REQUIRE_FRESH_RATE_FOR_EXECUTION =
  process.env.REQUIRE_FRESH_RATE_FOR_EXECUTION === "true";

const MAX_ORDER_USD = 10;
const MAX_OPEN_POSITIONS = 10;
const BUY_COOLDOWN_HOURS = 6;
const MAX_LOGS = 100;

const MAX_EXECUTED_ORDERS_24H = 3;
const MAX_BUYS_24H = 2;
const MAX_SELLS_24H = 2;
const MIN_HOURS_BETWEEN_EXECUTIONS = 4;
const PENDING_ORDER_WARNING_HOURS = 6;

const MAX_ACCEPTABLE_SPREAD_PCT = 2.5;
const MAX_RATE_AGE_MINUTES = 30;

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

const ASSET_RULES = {
  NVDA: { category: "AI_BIG_TECH", buyThreshold: 70, sellThreshold: 72 },
  AMD: { category: "AI_BIG_TECH", buyThreshold: 70, sellThreshold: 72 },
  ORCL: { category: "AI_BIG_TECH", buyThreshold: 70, sellThreshold: 72 },
  MSFT: { category: "AI_BIG_TECH", buyThreshold: 70, sellThreshold: 72 },
  GOOG: { category: "AI_BIG_TECH", buyThreshold: 70, sellThreshold: 72 },
  AMZN: { category: "AI_BIG_TECH", buyThreshold: 70, sellThreshold: 72 },

  BTC: { category: "CRYPTO_MAJOR", buyThreshold: 72, sellThreshold: 72 },
  ETH: { category: "CRYPTO_MAJOR", buyThreshold: 72, sellThreshold: 72 },

  BABA: { category: "CHINA_TECH", buyThreshold: 76, sellThreshold: 74 },
  COIN: { category: "CRYPTO_EQUITY", buyThreshold: 76, sellThreshold: 74 },
  PLTR: { category: "AI_SPEC_GROWTH", buyThreshold: 76, sellThreshold: 74 },

  SOL: { category: "SPECULATIVE_CRYPTO", buyThreshold: 82, sellThreshold: 76 },
  RKLB: { category: "SPACE", buyThreshold: 82, sellThreshold: 76 },
  IONQ: { category: "QUANTUM", buyThreshold: 82, sellThreshold: 76 },
  ASTS: { category: "SPACE_SPECULATIVE", buyThreshold: 82, sellThreshold: 76 }
};

const runtimeState = {
  scanRunning: false,
  cooldownMemory: {},
  logs: [],
  lastDecision: null,
  executionHistory: [],
  lastMarketData: null
};

const PROMPT = `
Tu es LEO-AI SENTINEL v9.0.

MISSION :
Gérer un petit portefeuille eToro de manière autonome.
Objectif : faire mieux qu'un investisseur humain prudent, sans prendre de risques absurdes.

NOUVEAUTÉ v9 :
Tu disposes maintenant d'un MarketDataAgent.
Il peut fournir des prix live eToro :
- bid
- ask
- mid
- spread %
- date du prix
- âge du prix
- état du marché par actif

STYLE :
- Investisseur IA actif mais prudent.
- Pas paralysé par la peur.
- Pas de FOMO.
- Pas de levier.
- Pas de all-in.
- Objectif : croissance progressive + protection du capital.

MODE :
TRADING AUTONOME RÉEL ACTIVÉ.

ACTIFS AUTORISÉS UNIQUEMENT :
NVDA, AMD, ORCL, MSFT, GOOG, AMZN, BABA, COIN, PLTR, RKLB, IONQ, ASTS, BTC, ETH, SOL.

RÈGLES ABSOLUES :
- Jamais de levier.
- Jamais de short.
- Jamais de all-in.
- Maximum 1 ordre par scan.
- Maximum 10 dollars par ordre.
- Ne jamais choisir un actif hors watchlist.
- HOLD si le signal est faible.
- BUY possible si le signal est bon.
- SELL possible si la thèse se casse, si le risque augmente fortement, ou si la protection du capital l'exige.
- Ne pas acheter si le spread est anormalement élevé.
- Ne pas acheter si les données de marché sont incohérentes.
- Ne pas prétendre connaître des informations non fournies.

PHILOSOPHIE :
Le bot ne doit pas être trop bridé.
Il doit pouvoir acheter les actifs solides avec un niveau de confiance raisonnable.
Il doit rester plus strict sur les actifs spéculatifs.
Il doit éviter de multiplier les ordres trop vite.

ACTIFS SOLIDES :
MSFT, GOOG, AMZN, NVDA, AMD, ORCL.
Ces actifs peuvent être achetés avec une confiance autour de 70/100 si le signal est bon.

CRYPTO MAJEURES :
BTC, ETH.
Achat possible avec une confiance autour de 72/100.

ACTIFS PLUS RISQUÉS :
BABA, COIN, PLTR.
Achat possible seulement avec une confiance plus forte.

ACTIFS TRÈS SPÉCULATIFS :
SOL, RKLB, IONQ, ASTS.
Achat seulement si très forte conviction.

UTILISATION DU MARKETDATAAGENT :
- Utilise le spread pour éviter les mauvais points d'entrée.
- Si un actif a un spread trop large, évite BUY.
- Si le marché semble incohérent ou données absentes, privilégie HOLD.
- Les données live sont un filtre de prudence, pas une garantie.
- Ne surpondère pas un mouvement instantané : tu n'as pas encore d'historique complet.

DIVERSIFICATION :
Si le portefeuille est trop concentré sur un seul actif, privilégier une diversification prudente vers un actif solide.
Éviter d'empiler plusieurs achats sur le même actif.

VENTE :
Vendre seulement si :
- risque élevé,
- momentum cassé,
- mauvaise nouvelle majeure,
- thèse d'investissement cassée,
- besoin clair de protéger le capital.

FORMAT OBLIGATOIRE :
Répondre uniquement en JSON strict.
Pas de texte hors JSON.

{
  "decision": "BUY|SELL|HOLD",
  "asset": "NVDA|AMD|ORCL|MSFT|GOOG|AMZN|BABA|COIN|PLTR|RKLB|IONQ|ASTS|BTC|ETH|SOL|NONE",
  "amount_usd": 0,
  "confidence": 0,
  "reason": "explication courte",
  "risk_check": "passed|failed"
}
`;

function nowIso() {
  return new Date().toISOString();
}

function hoursSince(dateLike) {
  if (!dateLike) return null;
  const time = new Date(dateLike).getTime();
  if (!Number.isFinite(time)) return null;
  return (Date.now() - time) / (1000 * 60 * 60);
}

function minutesSince(dateLike) {
  const h = hoursSince(dateLike);
  if (h === null) return null;
  return h * 60;
}

function roundNumber(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = Math.pow(10, digits);
  return Math.round(n * factor) / factor;
}

function addLog(entry) {
  const log = {
    time: nowIso(),
    version: VERSION,
    ...entry
  };

  runtimeState.logs.unshift(log);

  if (runtimeState.logs.length > MAX_LOGS) {
    runtimeState.logs = runtimeState.logs.slice(0, MAX_LOGS);
  }

  runtimeState.lastDecision = log;
}

function addExecutionHistory(entry) {
  runtimeState.executionHistory.unshift({
    time: nowIso(),
    ...entry
  });

  runtimeState.executionHistory = runtimeState.executionHistory.filter((e) => {
    const age = hoursSince(e.time);
    return age !== null && age <= 24;
  });
}

function getExecutionStats24h() {
  runtimeState.executionHistory = runtimeState.executionHistory.filter((e) => {
    const age = hoursSince(e.time);
    return age !== null && age <= 24;
  });

  const total = runtimeState.executionHistory.length;
  const buys = runtimeState.executionHistory.filter((e) => e.type === "BUY").length;
  const sells = runtimeState.executionHistory.filter((e) => e.type === "SELL").length;
  const lastExecution = runtimeState.executionHistory[0] || null;
  const hoursSinceLastExecution = lastExecution ? hoursSince(lastExecution.time) : null;

  return {
    total,
    buys,
    sells,
    lastExecution,
    hoursSinceLastExecution
  };
}

function requireSecret(req, res, next) {
  if (!BOT_SECRET) {
    return res.status(500).json({
      error: "BOT_SECRET manquant dans Render Environment Variables",
      action: "Ajoute BOT_SECRET dans Render, puis redeploy."
    });
  }

  const providedSecret = req.query.secret || req.headers["x-bot-secret"];

  if (providedSecret !== BOT_SECRET) {
    return res.status(401).json({
      error: "Accès refusé",
      hint: "Ajoute ?secret=TON_SECRET à l'URL."
    });
  }

  next();
}

function etoroHeaders() {
  return {
    "Content-Type": "application/json",
    "x-api-key": process.env.ETORO_API_KEY,
    "x-user-key": process.env.ETORO_USER_KEY,
    "x-request-id": randomUUID()
  };
}

async function readJsonResponse(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function normalizeConfidence(value) {
  let confidence = Number(value);

  if (!Number.isFinite(confidence)) return 0;

  if (confidence > 0 && confidence <= 10) {
    confidence = confidence * 10;
  }

  confidence = Math.round(confidence);

  if (confidence < 0) confidence = 0;
  if (confidence > 100) confidence = 100;

  return confidence;
}

function getInstrumentIdFromPosition(position) {
  return Number(
    position.instrumentID ??
    position.instrumentId ??
    position.InstrumentID ??
    position.InstrumentId
  );
}

function getInstrumentIdFromOrder(order) {
  return Number(
    order.instrumentID ??
    order.instrumentId ??
    order.InstrumentID ??
    order.InstrumentId
  );
}

function getInstrumentIdFromRate(rate) {
  return Number(
    rate.instrumentID ??
    rate.instrumentId ??
    rate.InstrumentID ??
    rate.InstrumentId
  );
}

function getPositionId(position) {
  const value =
    position.positionID ??
    position.positionId ??
    position.PositionID ??
    position.PositionId;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function assetFromInstrumentId(instrumentId) {
  const found = Object.entries(WATCHLIST).find(
    ([asset, id]) => Number(id) === Number(instrumentId)
  );

  return found ? found[0] : "UNKNOWN";
}

async function getPortfolio() {
  const response = await fetch(
    "https://public-api.etoro.com/api/v1/trading/info/portfolio",
    {
      method: "GET",
      headers: etoroHeaders()
    }
  );

  const data = await readJsonResponse(response);

  return {
    status: response.status,
    ok: response.ok,
    data
  };
}

async function getMarketRates() {
  const instrumentIds = Object.values(WATCHLIST).join(",");

  const response = await fetch(
    `https://public-api.etoro.com/api/v1/market-data/instruments/rates?instrumentIds=${encodeURIComponent(instrumentIds)}`,
    {
      method: "GET",
      headers: etoroHeaders()
    }
  );

  const data = await readJsonResponse(response);
  const normalized = normalizeMarketRates(data);

  runtimeState.lastMarketData = {
    time: nowIso(),
    status: response.status,
    ok: response.ok,
    data,
    normalized
  };

  return {
    status: response.status,
    ok: response.ok,
    data,
    normalized
  };
}

function normalizeMarketRates(data) {
  const rawRates = Array.isArray(data?.rates) ? data.rates : [];

  const ratesByAsset = {};
  const rates = [];

  for (const rate of rawRates) {
    const instrumentId = getInstrumentIdFromRate(rate);
    const asset = assetFromInstrumentId(instrumentId);

    if (asset === "UNKNOWN") continue;

    const bid = Number(rate.bid);
    const ask = Number(rate.ask);
    const lastExecution = Number(rate.lastExecution);

    const hasBidAsk = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0;
    const mid = hasBidAsk ? (bid + ask) / 2 : null;
    const spread = hasBidAsk ? ask - bid : null;
    const spreadPct = hasBidAsk && mid > 0 ? (spread / mid) * 100 : null;

    const priceDate = rate.date || null;
    const ageMinutes = priceDate ? minutesSince(priceDate) : null;

    const normalized = {
      asset,
      instrumentId,
      bid: roundNumber(bid, 6),
      ask: roundNumber(ask, 6),
      mid: roundNumber(mid, 6),
      lastExecution: Number.isFinite(lastExecution) ? roundNumber(lastExecution, 6) : null,
      spread: roundNumber(spread, 6),
      spreadPct: roundNumber(spreadPct, 4),
      date: priceDate,
      ageMinutes: ageMinutes === null ? null : roundNumber(ageMinutes, 2),
      healthy:
        hasBidAsk &&
        spreadPct !== null &&
        spreadPct <= MAX_ACCEPTABLE_SPREAD_PCT &&
        (ageMinutes === null || ageMinutes <= MAX_RATE_AGE_MINUTES)
    };

    ratesByAsset[asset] = normalized;
    rates.push(normalized);
  }

  const warnings = [];

  for (const asset of Object.keys(WATCHLIST)) {
    if (!ratesByAsset[asset]) {
      warnings.push({
        type: "MISSING_RATE",
        asset
      });
    }
  }

  for (const rate of rates) {
    if (rate.spreadPct !== null && rate.spreadPct > MAX_ACCEPTABLE_SPREAD_PCT) {
      warnings.push({
        type: "HIGH_SPREAD",
        asset: rate.asset,
        spreadPct: rate.spreadPct
      });
    }

    if (rate.ageMinutes !== null && rate.ageMinutes > MAX_RATE_AGE_MINUTES) {
      warnings.push({
        type: "STALE_RATE",
        asset: rate.asset,
        ageMinutes: rate.ageMinutes
      });
    }
  }

  return {
    rates,
    ratesByAsset,
    warnings,
    availableCount: rates.length,
    requestedCount: Object.keys(WATCHLIST).length,
    maxAcceptableSpreadPct: MAX_ACCEPTABLE_SPREAD_PCT,
    maxRateAgeMinutes: MAX_RATE_AGE_MINUTES
  };
}

function getMarketRateForAsset(marketData, asset) {
  return marketData?.normalized?.ratesByAsset?.[asset] || null;
}

function isMarketRateTradable(marketData, asset) {
  const rate = getMarketRateForAsset(marketData, asset);

  if (!rate) {
    return {
      ok: !REQUIRE_FRESH_RATE_FOR_EXECUTION,
      reason: REQUIRE_FRESH_RATE_FOR_EXECUTION
        ? `Prix live manquant pour ${asset}`
        : `Prix live manquant pour ${asset}, strict mode désactivé`
    };
  }

  if (rate.spreadPct !== null && rate.spreadPct > MAX_ACCEPTABLE_SPREAD_PCT) {
    return {
      ok: false,
      reason: `Spread trop élevé sur ${asset} (${rate.spreadPct}% > ${MAX_ACCEPTABLE_SPREAD_PCT}%)`,
      rate
    };
  }

  if (rate.ageMinutes !== null && rate.ageMinutes > MAX_RATE_AGE_MINUTES) {
    return {
      ok: false,
      reason: `Prix trop ancien sur ${asset} (${rate.ageMinutes} min > ${MAX_RATE_AGE_MINUTES} min)`,
      rate
    };
  }

  return {
    ok: true,
    reason: `Prix live acceptable pour ${asset}`,
    rate
  };
}

function getClientPortfolio(portfolioResponse) {
  return portfolioResponse?.data?.clientPortfolio || {};
}

function getOrderOpenDate(order) {
  return (
    order.openDateTime ??
    order.openDatetime ??
    order.createDateTime ??
    order.createdDateTime ??
    order.lastUpdate ??
    null
  );
}

function extractOrderSummary(order) {
  const instrumentId = getInstrumentIdFromOrder(order);
  const ageHours = hoursSince(getOrderOpenDate(order));

  return {
    asset: assetFromInstrumentId(instrumentId),
    instrumentId,
    orderId: order.orderID ?? order.orderId ?? null,
    amount: order.amount ?? null,
    isBuy: order.isBuy ?? null,
    leverage: order.leverage ?? null,
    statusID: order.statusID ?? order.statusId ?? null,
    openDateTime: getOrderOpenDate(order),
    ageHours: ageHours === null ? null : roundNumber(ageHours, 2)
  };
}

function extractPortfolioSummary(portfolioResponse) {
  const clientPortfolio = getClientPortfolio(portfolioResponse);

  const positions = clientPortfolio.positions || [];
  const ordersForOpen = clientPortfolio.ordersForOpen || [];
  const ordersForClose = clientPortfolio.ordersForClose || [];

  const openPositions = positions.map((p) => {
    const instrumentId = getInstrumentIdFromPosition(p);

    return {
      asset: assetFromInstrumentId(instrumentId),
      instrumentId,
      positionId: getPositionId(p),
      amount: p.amount ?? null,
      profit: p.profit ?? null,
      profitPercent: p.profitPercent ?? null
    };
  });

  const openOrders = ordersForOpen.map(extractOrderSummary);
  const closeOrders = ordersForClose.map(extractOrderSummary);

  const openAssets = openPositions
    .map((p) => p.asset)
    .filter((asset) => asset !== "UNKNOWN");

  const categoryCounts = {};

  for (const asset of openAssets) {
    const category = ASSET_RULES[asset]?.category || "UNKNOWN";
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
  }

  const pendingWarnings = [];

  for (const order of [...openOrders, ...closeOrders]) {
    if (order.ageHours !== null && order.ageHours >= PENDING_ORDER_WARNING_HOURS) {
      pendingWarnings.push({
        type: "PENDING_ORDER_TOO_OLD",
        asset: order.asset,
        orderId: order.orderId,
        ageHours: order.ageHours
      });
    }
  }

  return {
    positionsCount: positions.length,
    ordersForOpenCount: ordersForOpen.length,
    ordersForCloseCount: ordersForClose.length,
    openPositions,
    openOrders,
    closeOrders,
    openAssets,
    categoryCounts,
    possibleCashOrCredit: clientPortfolio.credit ?? null,
    pendingWarnings
  };
}

function hasOpenPosition(portfolioResponse, asset) {
  const clientPortfolio = getClientPortfolio(portfolioResponse);
  const positions = clientPortfolio.positions || [];
  const wantedId = WATCHLIST[asset];

  return positions.some((p) => getInstrumentIdFromPosition(p) === wantedId);
}

function findOpenPosition(portfolioResponse, asset) {
  const clientPortfolio = getClientPortfolio(portfolioResponse);
  const positions = clientPortfolio.positions || [];
  const wantedId = WATCHLIST[asset];

  return positions.find((p) => getInstrumentIdFromPosition(p) === wantedId);
}

function hasOpenOrder(portfolioResponse, asset) {
  const clientPortfolio = getClientPortfolio(portfolioResponse);
  const ordersForOpen = clientPortfolio.ordersForOpen || [];
  const wantedId = WATCHLIST[asset];

  return ordersForOpen.some((o) => getInstrumentIdFromOrder(o) === wantedId);
}

function hasCloseOrder(portfolioResponse, asset) {
  const clientPortfolio = getClientPortfolio(portfolioResponse);
  const ordersForClose = clientPortfolio.ordersForClose || [];
  const wantedId = WATCHLIST[asset];

  return ordersForClose.some((o) => getInstrumentIdFromOrder(o) === wantedId);
}

function isInCooldown(asset) {
  const lastTime = runtimeState.cooldownMemory[asset];

  if (!lastTime) return false;

  const elapsedMs = Date.now() - lastTime;
  const cooldownMs = BUY_COOLDOWN_HOURS * 60 * 60 * 1000;

  return elapsedMs < cooldownMs;
}

function setCooldown(asset) {
  runtimeState.cooldownMemory[asset] = Date.now();
}

function sanitizeDecision(decision) {
  const clean = {
    decision: String(decision?.decision || "HOLD").toUpperCase(),
    asset: String(decision?.asset || "NONE").toUpperCase(),
    amount_usd: Number(decision?.amount_usd || 0),
    confidence: normalizeConfidence(decision?.confidence),
    reason: String(decision?.reason || "Aucune raison fournie").slice(0, 300),
    risk_check: String(decision?.risk_check || "failed").toLowerCase()
  };

  if (!["BUY", "SELL", "HOLD"].includes(clean.decision)) {
    clean.decision = "HOLD";
  }

  if (clean.asset !== "NONE" && !WATCHLIST[clean.asset]) {
    clean.asset = "NONE";
    clean.decision = "HOLD";
    clean.reason = "Actif non autorisé";
    clean.risk_check = "failed";
  }

  if (!Number.isFinite(clean.amount_usd) || clean.amount_usd < 0) {
    clean.amount_usd = 0;
  }

  if (clean.amount_usd > MAX_ORDER_USD) {
    clean.amount_usd = MAX_ORDER_USD;
  }

  if (clean.decision === "BUY" && clean.amount_usd === 0) {
    clean.amount_usd = MAX_ORDER_USD;
  }

  if (clean.decision !== "BUY") {
    clean.amount_usd = 0;
  }

  return clean;
}

function riskController(decision, portfolioResponse, marketData) {
  const d = sanitizeDecision(decision);
  const summary = extractPortfolioSummary(portfolioResponse);
  const executionStats = getExecutionStats24h();

  if (d.decision === "HOLD") {
    return {
      approved: false,
      finalDecision: {
        ...d,
        decision: "HOLD",
        asset: "NONE",
        amount_usd: 0,
        risk_check: "passed"
      },
      reason: "HOLD choisi"
    };
  }

  if (d.risk_check !== "passed") {
    return {
      approved: false,
      finalDecision: {
        ...d,
        decision: "HOLD",
        asset: "NONE",
        amount_usd: 0
      },
      reason: "Risk check non validé"
    };
  }

  if (!WATCHLIST[d.asset]) {
    return {
      approved: false,
      finalDecision: {
        decision: "HOLD",
        asset: "NONE",
        amount_usd: 0,
        confidence: d.confidence,
        reason: "Actif non autorisé",
        risk_check: "failed"
      },
      reason: "Actif hors watchlist"
    };
  }

  const marketCheck = isMarketRateTradable(marketData, d.asset);

  if (!marketCheck.ok) {
    return {
      approved: false,
      finalDecision: {
        ...d,
        decision: "HOLD",
        asset: "NONE",
        amount_usd: 0
      },
      reason: `MarketDataAgent bloque : ${marketCheck.reason}`
    };
  }

  if (executionStats.total >= MAX_EXECUTED_ORDERS_24H) {
    return {
      approved: false,
      finalDecision: {
        ...d,
        decision: "HOLD",
        asset: "NONE",
        amount_usd: 0
      },
      reason: `Limite d'ordres exécutés sur 24h atteinte (${executionStats.total}/${MAX_EXECUTED_ORDERS_24H})`
    };
  }

  if (
    executionStats.hoursSinceLastExecution !== null &&
    executionStats.hoursSinceLastExecution < MIN_HOURS_BETWEEN_EXECUTIONS
  ) {
    return {
      approved: false,
      finalDecision: {
        ...d,
        decision: "HOLD",
        asset: "NONE",
        amount_usd: 0
      },
      reason: `Dernier ordre trop récent (${executionStats.hoursSinceLastExecution.toFixed(2)}h < ${MIN_HOURS_BETWEEN_EXECUTIONS}h)`
    };
  }

  const rules = ASSET_RULES[d.asset];

  if (d.decision === "BUY") {
    if (executionStats.buys >= MAX_BUYS_24H) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Limite BUY 24h atteinte (${executionStats.buys}/${MAX_BUYS_24H})`
      };
    }

    if (d.confidence < rules.buyThreshold) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Confiance BUY trop faible (${d.confidence} < ${rules.buyThreshold})`
      };
    }

    if (summary.ordersForOpenCount > 0) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: "Ordre d'achat déjà en attente dans le portefeuille"
      };
    }

    if (hasOpenPosition(portfolioResponse, d.asset)) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Position déjà ouverte sur ${d.asset}`
      };
    }

    if (hasOpenOrder(portfolioResponse, d.asset)) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Ordre déjà en attente sur ${d.asset}`
      };
    }

    if (isInCooldown(d.asset)) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Cooldown actif sur ${d.asset}`
      };
    }

    if (summary.positionsCount >= MAX_OPEN_POSITIONS) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Nombre maximum de positions atteint (${summary.positionsCount}/${MAX_OPEN_POSITIONS})`
      };
    }

    return {
      approved: true,
      finalDecision: d,
      reason: `BUY approuvé ; ${marketCheck.reason}`
    };
  }

  if (d.decision === "SELL") {
    if (executionStats.sells >= MAX_SELLS_24H) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Limite SELL 24h atteinte (${executionStats.sells}/${MAX_SELLS_24H})`
      };
    }

    if (d.confidence < rules.sellThreshold) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Confiance SELL trop faible (${d.confidence} < ${rules.sellThreshold})`
      };
    }

    if (summary.ordersForCloseCount > 0) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: "Ordre de vente déjà en attente dans le portefeuille"
      };
    }

    if (hasCloseOrder(portfolioResponse, d.asset)) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Ordre de vente déjà en attente sur ${d.asset}`
      };
    }

    if (!hasOpenPosition(portfolioResponse, d.asset)) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Aucune position ouverte sur ${d.asset}`
      };
    }

    return {
      approved: true,
      finalDecision: d,
      reason: `SELL approuvé ; ${marketCheck.reason}`
    };
  }

  return {
    approved: false,
    finalDecision: {
      decision: "HOLD",
      asset: "NONE",
      amount_usd: 0,
      confidence: d.confidence,
      reason: "Décision invalide",
      risk_check: "failed"
    },
    reason: "Décision invalide"
  };
}

async function executeBuy(asset, amount) {
  if (!AUTO_TRADE) {
    return {
      skipped: true,
      reason: "AUTO_TRADE désactivé"
    };
  }

  const instrumentId = WATCHLIST[asset];

  if (!instrumentId) {
    return {
      skipped: true,
      reason: "Actif non autorisé"
    };
  }

  const safeAmount = Math.min(Number(amount || MAX_ORDER_USD), MAX_ORDER_USD);

  if (safeAmount <= 0) {
    return {
      skipped: true,
      reason: "Montant invalide"
    };
  }

  const response = await fetch(
    "https://public-api.etoro.com/api/v1/trading/execution/market-open-orders/by-amount",
    {
      method: "POST",
      headers: etoroHeaders(),
      body: JSON.stringify({
        instrumentId,
        isBuy: true,
        leverage: 1,
        amount: safeAmount
      })
    }
  );

  const data = await readJsonResponse(response);

  if (response.ok) {
    setCooldown(asset);
    addExecutionHistory({
      type: "BUY",
      asset,
      amount: safeAmount,
      instrumentId
    });
  }

  return {
    status: response.status,
    ok: response.ok,
    type: "BUY",
    asset,
    instrumentId,
    amount: safeAmount,
    data
  };
}

async function executeSell(asset) {
  if (!AUTO_TRADE) {
    return {
      skipped: true,
      reason: "AUTO_TRADE désactivé"
    };
  }

  const portfolio = await getPortfolio();
  const position = findOpenPosition(portfolio, asset);

  if (!position) {
    return {
      skipped: true,
      reason: `Aucune position ouverte trouvée pour ${asset}`
    };
  }

  const positionId = getPositionId(position);
  const instrumentId = WATCHLIST[asset];

  if (!positionId) {
    return {
      skipped: true,
      reason: `positionId introuvable pour ${asset}`,
      position
    };
  }

  const primaryResponse = await fetch(
    "https://public-api.etoro.com/api/v1/trading/execution/market-close-orders",
    {
      method: "POST",
      headers: etoroHeaders(),
      body: JSON.stringify({
        positionId
      })
    }
  );

  const primaryData = await readJsonResponse(primaryResponse);

  if (primaryResponse.ok) {
    addExecutionHistory({
      type: "SELL",
      asset,
      instrumentId,
      positionId
    });

    return {
      status: primaryResponse.status,
      ok: primaryResponse.ok,
      type: "SELL",
      route: "primary",
      asset,
      instrumentId,
      positionId,
      data: primaryData
    };
  }

  const fallbackResponse = await fetch(
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

  const fallbackData = await readJsonResponse(fallbackResponse);

  if (fallbackResponse.ok) {
    addExecutionHistory({
      type: "SELL",
      asset,
      instrumentId,
      positionId
    });
  }

  return {
    status: fallbackResponse.status,
    ok: fallbackResponse.ok,
    type: "SELL",
    route: "fallback",
    asset,
    instrumentId,
    positionId,
    primaryError: {
      status: primaryResponse.status,
      data: primaryData
    },
    data: fallbackData
  };
}

async function askDecisionAgent(portfolioSummary, marketSummary, source) {
  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: PROMPT
      },
      {
        role: "user",
        content: JSON.stringify({
          source,
          time: nowIso(),
          version: VERSION,
          auto_trade_enabled: AUTO_TRADE,
          max_order_usd: MAX_ORDER_USD,
          max_open_positions: MAX_OPEN_POSITIONS,
          execution_limits: {
            max_executed_orders_24h: MAX_EXECUTED_ORDERS_24H,
            max_buys_24h: MAX_BUYS_24H,
            max_sells_24h: MAX_SELLS_24H,
            min_hours_between_executions: MIN_HOURS_BETWEEN_EXECUTIONS
          },
          market_constraints: {
            max_acceptable_spread_pct: MAX_ACCEPTABLE_SPREAD_PCT,
            max_rate_age_minutes: MAX_RATE_AGE_MINUTES,
            require_fresh_rate_for_execution: REQUIRE_FRESH_RATE_FOR_EXECUTION
          },
          watchlist: WATCHLIST,
          asset_rules: ASSET_RULES,
          portfolio_summary: portfolioSummary,
          market_data_summary: marketSummary,
          execution_stats_24h: getExecutionStats24h(),
          instruction:
            "Analyse le portefeuille et les données de marché live. Décide BUY, SELL ou HOLD. Tu peux être actif mais pas imprudent. Une seule décision."
        })
      }
    ]
  });

  const raw = response.choices[0].message.content;
  console.log("DECISION RAW:", raw);

  return JSON.parse(raw);
}

async function scanMarket(source = "manual-scan") {
  if (runtimeState.scanRunning) {
    return {
      version: VERSION,
      skipped: true,
      reason: "Un scan est déjà en cours"
    };
  }

  runtimeState.scanRunning = true;

  try {
    const portfolio = await getPortfolio();
    const portfolioSummary = extractPortfolioSummary(portfolio);

    let marketData;

    try {
      marketData = await getMarketRates();
    } catch (error) {
      marketData = {
        status: null,
        ok: false,
        error: error.message,
        normalized: {
          rates: [],
          ratesByAsset: {},
          warnings: [
            {
              type: "MARKET_DATA_ERROR",
              message: error.message
            }
          ],
          availableCount: 0,
          requestedCount: Object.keys(WATCHLIST).length
        }
      };
    }

    let decisionRaw;

    try {
      decisionRaw = await askDecisionAgent(
        portfolioSummary,
        marketData.normalized,
        source
      );
    } catch (error) {
      const failed = {
        version: VERSION,
        source,
        error: "Erreur décision IA",
        details: error.message
      };

      addLog({
        source,
        event: "AI_DECISION_ERROR",
        error: error.message,
        marketDataStatus: marketData.status,
        marketDataOk: marketData.ok
      });

      return failed;
    }

    const control = riskController(decisionRaw, portfolio, marketData);

    let execution = {
      skipped: true,
      reason: "Aucun ordre exécuté"
    };

    if (control.approved && control.finalDecision.decision === "BUY") {
      execution = await executeBuy(
        control.finalDecision.asset,
        control.finalDecision.amount_usd
      );
    }

    if (control.approved && control.finalDecision.decision === "SELL") {
      execution = await executeSell(control.finalDecision.asset);
    }

    const result = {
      version: VERSION,
      source,
      auto_trade_enabled: AUTO_TRADE,
      portfolio_status: portfolio.status,
      market_data_status: marketData.status,
      market_data_ok: marketData.ok,
      agents: {
        portfolioSummary,
        marketDataAgent: marketData.normalized,
        executionStats24h: getExecutionStats24h(),
        decisionAgentRaw: decisionRaw,
        riskController: control
      },
      decision: control.finalDecision,
      execution
    };

    addLog({
      source,
      event: "SCAN_COMPLETED",
      decision: control.finalDecision,
      risk_reason: control.reason,
      execution,
      executionStats24h: getExecutionStats24h(),
      market: {
        status: marketData.status,
        ok: marketData.ok,
        availableCount: marketData.normalized?.availableCount,
        requestedCount: marketData.normalized?.requestedCount,
        warnings: marketData.normalized?.warnings || []
      },
      portfolio: {
        positionsCount: portfolioSummary.positionsCount,
        ordersForOpenCount: portfolioSummary.ordersForOpenCount,
        ordersForCloseCount: portfolioSummary.ordersForCloseCount,
        openAssets: portfolioSummary.openAssets,
        openOrders: portfolioSummary.openOrders,
        closeOrders: portfolioSummary.closeOrders,
        categoryCounts: portfolioSummary.categoryCounts,
        pendingWarnings: portfolioSummary.pendingWarnings
      }
    });

    return result;
  } finally {
    runtimeState.scanRunning = false;
  }
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderDashboard({ summary, metrics, market, secret }) {
  const last = runtimeState.lastDecision;
  const openAssets = summary.openAssets.join(", ") || "Aucun";
  const pendingWarnings = summary.pendingWarnings.length
    ? summary.pendingWarnings.map((w) => `${w.asset} ordre ${w.orderId} depuis ${w.ageHours}h`).join(" | ")
    : "Aucune";

  const marketWarnings = market?.warnings?.length
    ? market.warnings.map((w) => `${w.type}:${w.asset || ""}`).join(" | ")
    : "Aucune";

  const lastDecisionText = last
    ? `${last.time} — ${last.decision?.decision || "?"} ${last.decision?.asset || ""} — ${last.risk_reason || ""}`
    : "Aucune décision enregistrée depuis le dernier redémarrage.";

  const rateRows = (market?.rates || [])
    .map((rate) => {
      return `
        <tr>
          <td>${htmlEscape(rate.asset)}</td>
          <td>${htmlEscape(rate.bid)}</td>
          <td>${htmlEscape(rate.ask)}</td>
          <td>${htmlEscape(rate.mid)}</td>
          <td>${htmlEscape(rate.spreadPct)}</td>
          <td>${htmlEscape(rate.ageMinutes)}</td>
          <td>${rate.healthy ? "✅" : "⚠️"}</td>
        </tr>
      `;
    })
    .join("");

  const rows = runtimeState.logs
    .slice(0, 20)
    .map((log) => {
      return `
        <tr>
          <td>${htmlEscape(log.time)}</td>
          <td>${htmlEscape(log.source)}</td>
          <td>${htmlEscape(log.decision?.decision || "")}</td>
          <td>${htmlEscape(log.decision?.asset || "")}</td>
          <td>${htmlEscape(log.decision?.confidence || "")}</td>
          <td>${htmlEscape(log.risk_reason || "")}</td>
          <td>${htmlEscape(log.execution?.type || (log.execution?.skipped ? "SKIPPED" : ""))}</td>
        </tr>
      `;
    })
    .join("");

  return `
<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>LEO-AI SENTINEL Dashboard</title>
<style>
  body { font-family: Arial, sans-serif; background:#111827; color:#f9fafb; padding:24px; }
  h1 { margin-bottom:4px; }
  .muted { color:#9ca3af; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:16px; margin:20px 0; }
  .card { background:#1f2937; padding:16px; border-radius:12px; border:1px solid #374151; }
  .big { font-size:28px; font-weight:bold; }
  .ok { color:#34d399; }
  .warn { color:#fbbf24; }
  .bad { color:#f87171; }
  a { color:#60a5fa; }
  table { width:100%; border-collapse:collapse; margin-top:20px; background:#1f2937; }
  th, td { border:1px solid #374151; padding:8px; text-align:left; font-size:13px; }
  th { background:#374151; }
  code { background:#374151; padding:2px 5px; border-radius:4px; }
</style>
</head>
<body>
  <h1>LEO-AI SENTINEL</h1>
  <div class="muted">${htmlEscape(VERSION)} — ${htmlEscape(nowIso())}</div>

  <div class="grid">
    <div class="card">
      <div class="muted">Auto trade</div>
      <div class="big ${AUTO_TRADE ? "ok" : "bad"}">${AUTO_TRADE ? "ACTIF" : "OFF"}</div>
    </div>
    <div class="card">
      <div class="muted">MarketDataAgent</div>
      <div class="big ${market?.availableCount > 0 ? "ok" : "warn"}">${market?.availableCount || 0}/${market?.requestedCount || 0}</div>
    </div>
    <div class="card">
      <div class="muted">Positions ouvertes</div>
      <div class="big">${summary.positionsCount}</div>
    </div>
    <div class="card">
      <div class="muted">Ordres achat en attente</div>
      <div class="big ${summary.ordersForOpenCount > 0 ? "warn" : "ok"}">${summary.ordersForOpenCount}</div>
    </div>
    <div class="card">
      <div class="muted">Ordres vente en attente</div>
      <div class="big ${summary.ordersForCloseCount > 0 ? "warn" : "ok"}">${summary.ordersForCloseCount}</div>
    </div>
    <div class="card">
      <div class="muted">Ordres exécutés 24h</div>
      <div class="big">${metrics.executionStats24h.total}/${MAX_EXECUTED_ORDERS_24H}</div>
    </div>
  </div>

  <div class="card">
    <h2>Portefeuille</h2>
    <p><strong>Actifs ouverts :</strong> ${htmlEscape(openAssets)}</p>
    <p><strong>Catégories :</strong> <code>${htmlEscape(JSON.stringify(summary.categoryCounts))}</code></p>
    <p><strong>Alertes ordres en attente :</strong> ${htmlEscape(pendingWarnings)}</p>
  </div>

  <div class="card">
    <h2>MarketDataAgent</h2>
    <p><strong>Warnings :</strong> ${htmlEscape(marketWarnings)}</p>
    <p><strong>Spread max accepté :</strong> ${MAX_ACCEPTABLE_SPREAD_PCT}%</p>
    <p><strong>Âge prix max :</strong> ${MAX_RATE_AGE_MINUTES} min</p>
    <table>
      <thead>
        <tr>
          <th>Actif</th>
          <th>Bid</th>
          <th>Ask</th>
          <th>Mid</th>
          <th>Spread %</th>
          <th>Âge min</th>
          <th>OK</th>
        </tr>
      </thead>
      <tbody>
        ${rateRows || "<tr><td colspan='7'>Aucune donnée marché</td></tr>"}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Dernière décision</h2>
    <p>${htmlEscape(lastDecisionText)}</p>
    <p>
      <a href="/status?secret=${encodeURIComponent(secret)}">Status JSON</a> —
      <a href="/metrics?secret=${encodeURIComponent(secret)}">Metrics JSON</a> —
      <a href="/market-summary?secret=${encodeURIComponent(secret)}">Market JSON</a> —
      <a href="/logs?secret=${encodeURIComponent(secret)}">Logs JSON</a> —
      <a href="/last-decision?secret=${encodeURIComponent(secret)}">Dernière décision JSON</a>
    </p>
  </div>

  <h2>Derniers logs</h2>
  <table>
    <thead>
      <tr>
        <th>Heure</th>
        <th>Source</th>
        <th>Décision</th>
        <th>Actif</th>
        <th>Confiance</th>
        <th>Raison RiskController</th>
        <th>Exécution</th>
      </tr>
    </thead>
    <tbody>
      ${rows || "<tr><td colspan='7'>Aucun log</td></tr>"}
    </tbody>
  </table>
</body>
</html>
`;
}

app.get("/", (req, res) => {
  res.send(`LEO-AI SENTINEL ${VERSION} actif`);
});

app.get("/health", (req, res) => {
  res.json({
    version: VERSION,
    ok: true,
    auto_trade_enabled: AUTO_TRADE,
    bot_secret_configured: Boolean(BOT_SECRET),
    require_fresh_rate_for_execution: REQUIRE_FRESH_RATE_FOR_EXECUTION,
    time: nowIso()
  });
});

app.get("/status", requireSecret, async (req, res) => {
  try {
    const portfolio = await getPortfolio();
    const summary = extractPortfolioSummary(portfolio);

    res.json({
      version: VERSION,
      auto_trade_enabled: AUTO_TRADE,
      bot_secret_configured: Boolean(BOT_SECRET),
      require_fresh_rate_for_execution: REQUIRE_FRESH_RATE_FOR_EXECUTION,
      portfolio_status: portfolio.status,
      portfolio_ok: portfolio.ok,
      positions_count: summary.positionsCount,
      orders_for_open_count: summary.ordersForOpenCount,
      orders_for_close_count: summary.ordersForCloseCount,
      open_assets: summary.openAssets,
      open_orders: summary.openOrders,
      close_orders: summary.closeOrders,
      category_counts: summary.categoryCounts,
      pending_warnings: summary.pendingWarnings,
      execution_stats_24h: getExecutionStats24h(),
      cooldown_memory: runtimeState.cooldownMemory,
      last_market_data_status: runtimeState.lastMarketData
        ? {
            time: runtimeState.lastMarketData.time,
            status: runtimeState.lastMarketData.status,
            ok: runtimeState.lastMarketData.ok,
            availableCount: runtimeState.lastMarketData.normalized?.availableCount,
            requestedCount: runtimeState.lastMarketData.normalized?.requestedCount,
            warnings: runtimeState.lastMarketData.normalized?.warnings || []
          }
        : null,
      last_decision: runtimeState.lastDecision
    });
  } catch (error) {
    res.json({
      version: VERSION,
      error: error.message
    });
  }
});

app.get("/metrics", requireSecret, async (req, res) => {
  try {
    const portfolio = await getPortfolio();
    const summary = extractPortfolioSummary(portfolio);

    res.json({
      version: VERSION,
      time: nowIso(),
      auto_trade_enabled: AUTO_TRADE,
      portfolio_ok: portfolio.ok,
      portfolio_status: portfolio.status,
      positions_count: summary.positionsCount,
      open_assets: summary.openAssets,
      category_counts: summary.categoryCounts,
      open_orders_count: summary.ordersForOpenCount,
      close_orders_count: summary.ordersForCloseCount,
      pending_warnings: summary.pendingWarnings,
      execution_stats_24h: getExecutionStats24h(),
      scan_running: runtimeState.scanRunning,
      logs_count: runtimeState.logs.length,
      last_market_data_status: runtimeState.lastMarketData
        ? {
            time: runtimeState.lastMarketData.time,
            status: runtimeState.lastMarketData.status,
            ok: runtimeState.lastMarketData.ok,
            availableCount: runtimeState.lastMarketData.normalized?.availableCount,
            requestedCount: runtimeState.lastMarketData.normalized?.requestedCount,
            warnings: runtimeState.lastMarketData.normalized?.warnings || []
          }
        : null
    });
  } catch (error) {
    res.json({
      version: VERSION,
      error: error.message
    });
  }
});

app.get("/market-rates", requireSecret, async (req, res) => {
  try {
    const rates = await getMarketRates();
    res.json({
      version: VERSION,
      status: rates.status,
      ok: rates.ok,
      raw: rates.data
    });
  } catch (error) {
    res.json({
      version: VERSION,
      error: error.message
    });
  }
});

app.get("/market-summary", requireSecret, async (req, res) => {
  try {
    const rates = await getMarketRates();
    res.json({
      version: VERSION,
      status: rates.status,
      ok: rates.ok,
      summary: rates.normalized
    });
  } catch (error) {
    res.json({
      version: VERSION,
      error: error.message
    });
  }
});

app.get("/dashboard", requireSecret, async (req, res) => {
  try {
    const portfolio = await getPortfolio();
    const summary = extractPortfolioSummary(portfolio);

    let marketData;

    try {
      marketData = await getMarketRates();
    } catch {
      marketData = {
        normalized: {
          rates: [],
          ratesByAsset: {},
          warnings: [{ type: "MARKET_DATA_ERROR" }],
          availableCount: 0,
          requestedCount: Object.keys(WATCHLIST).length
        }
      };
    }

    const html = renderDashboard({
      summary,
      market: marketData.normalized,
      metrics: {
        executionStats24h: getExecutionStats24h()
      },
      secret: req.query.secret
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error) {
    res.status(500).send(`Erreur dashboard : ${htmlEscape(error.message)}`);
  }
});

app.get("/logs", requireSecret, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), MAX_LOGS);

  res.json({
    version: VERSION,
    logs: runtimeState.logs.slice(0, limit)
  });
});

app.get("/last-decision", requireSecret, (req, res) => {
  res.json({
    version: VERSION,
    last_decision: runtimeState.lastDecision
  });
});

app.get("/watchlist", requireSecret, (req, res) => {
  res.json({
    version: VERSION,
    watchlist: WATCHLIST,
    asset_rules: ASSET_RULES
  });
});

app.get("/portfolio", requireSecret, async (req, res) => {
  try {
    const portfolio = await getPortfolio();
    res.json(portfolio);
  } catch (error) {
    res.json({
      error: error.message
    });
  }
});

app.get("/scan", requireSecret, async (req, res) => {
  try {
    const result = await scanMarket("manual-scan");
    res.json(result);
  } catch (error) {
    res.json({
      version: VERSION,
      error: "Erreur scan",
      details: error.message
    });
  }
});

app.get("/buy-test", requireSecret, async (req, res) => {
  try {
    const asset = String(req.query.asset || "").toUpperCase();
    const amount = Number(req.query.amount || MAX_ORDER_USD);

    if (!asset || !WATCHLIST[asset]) {
      return res.json({
        error: "Actif invalide. Exemple : /buy-test?asset=NVDA&amount=10&secret=TON_SECRET",
        allowed_assets: Object.keys(WATCHLIST)
      });
    }

    const portfolio = await getPortfolio();
    const marketData = await getMarketRates();
    const marketCheck = isMarketRateTradable(marketData, asset);

    if (!marketCheck.ok) {
      return res.json({
        skipped: true,
        reason: marketCheck.reason,
        marketCheck
      });
    }

    if (hasOpenPosition(portfolio, asset)) {
      return res.json({
        skipped: true,
        reason: `Position déjà ouverte sur ${asset}`
      });
    }

    const result = await executeBuy(asset, amount);

    addLog({
      source: "manual-buy-test",
      event: "MANUAL_BUY",
      asset,
      amount,
      marketCheck,
      execution: result,
      executionStats24h: getExecutionStats24h()
    });

    res.json(result);
  } catch (error) {
    res.json({
      error: error.message
    });
  }
});

app.get("/sell-test", requireSecret, async (req, res) => {
  try {
    const asset = String(req.query.asset || "").toUpperCase();

    if (!asset || !WATCHLIST[asset]) {
      return res.json({
        error: "Actif invalide. Exemple : /sell-test?asset=NVDA&secret=TON_SECRET",
        allowed_assets: Object.keys(WATCHLIST)
      });
    }

    const result = await executeSell(asset);

    addLog({
      source: "manual-sell-test",
      event: "MANUAL_SELL",
      asset,
      execution: result,
      executionStats24h: getExecutionStats24h()
    });

    res.json(result);
  } catch (error) {
    res.json({
      error: error.message
    });
  }
});

app.get("/resolve-symbol", requireSecret, async (req, res) => {
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

    const data = await readJsonResponse(response);

    res.json({
      symbol,
      status: response.status,
      ok: response.ok,
      data
    });
  } catch (error) {
    res.json({
      error: error.message
    });
  }
});

cron.schedule("0 */2 * * *", async () => {
  console.log(`[${nowIso()}] Scan automatique toutes les 2h lancé`);

  try {
    const result = await scanMarket("auto-cron");
    console.log("SCAN AUTO RESULT:", JSON.stringify(result));
  } catch (error) {
    console.error("Erreur scan automatique:", error.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`LEO-AI SENTINEL ${VERSION} lancé sur le port ${PORT}`);
});
