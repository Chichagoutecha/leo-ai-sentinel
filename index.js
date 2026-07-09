const express = require("express");
const OpenAI = require("openai");
const cron = require("node-cron");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const VERSION = "v10.1-diversification-basket";

const AUTO_TRADE = process.env.AUTO_TRADE === "true";
const BOT_SECRET = process.env.BOT_SECRET || "";

const REQUIRE_FRESH_RATE_FOR_EXECUTION =
  process.env.REQUIRE_FRESH_RATE_FOR_EXECUTION === "true";

const MAX_ORDER_USD = 10;
const MAX_OPEN_POSITIONS = 12;
const TARGET_STARTER_POSITIONS = 8;

const BUY_COOLDOWN_HOURS = 3;
const MAX_LOGS = 180;

const MAX_EXECUTED_ORDERS_24H = 4;
const MAX_BUYS_24H = 3;
const MAX_SELLS_24H = 2;
const MIN_HOURS_BETWEEN_EXECUTIONS = 2;
const PENDING_ORDER_WARNING_HOURS = 6;

const MAX_ACCEPTABLE_SPREAD_PCT = 2.5;
const MAX_RATE_AGE_MINUTES = 30;

const MAX_TREND_POINTS_PER_ASSET = 48;
const MIN_MINUTES_BETWEEN_TREND_POINTS = 10;

const WATCH_CRON_SCHEDULE = "*/15 * * * *";
const TRADE_CRON_SCHEDULE = "0 */2 * * *";

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
  SOL: 100063,

  SPY: 3417,
  QQQ: 3418,
  GLD: 15634,
  TLT: 3020,
  SHY: 3100,
  XLV: 3017,
  XLP: 3022,
  XLE: 3008,
  "BRK.B": 2870,
  JPM: 13624,
  PANW: 9422,
  CRWD: 9419
};

const ASSET_RULES = {
  NVDA: { category: "AI_BIG_TECH", buyThreshold: 68, sellThreshold: 72 },
  AMD: { category: "AI_BIG_TECH", buyThreshold: 68, sellThreshold: 72 },
  ORCL: { category: "AI_BIG_TECH", buyThreshold: 68, sellThreshold: 72 },
  MSFT: { category: "AI_BIG_TECH", buyThreshold: 68, sellThreshold: 72 },
  GOOG: { category: "AI_BIG_TECH", buyThreshold: 68, sellThreshold: 72 },
  AMZN: { category: "AI_BIG_TECH", buyThreshold: 68, sellThreshold: 72 },

  BTC: { category: "CRYPTO_MAJOR", buyThreshold: 70, sellThreshold: 72 },
  ETH: { category: "CRYPTO_MAJOR", buyThreshold: 70, sellThreshold: 72 },

  BABA: { category: "CHINA_TECH", buyThreshold: 74, sellThreshold: 74 },
  COIN: { category: "CRYPTO_EQUITY", buyThreshold: 74, sellThreshold: 74 },
  PLTR: { category: "AI_SPEC_GROWTH", buyThreshold: 74, sellThreshold: 74 },

  SOL: { category: "SPECULATIVE_CRYPTO", buyThreshold: 80, sellThreshold: 76 },
  RKLB: { category: "SPACE", buyThreshold: 82, sellThreshold: 76 },
  IONQ: { category: "QUANTUM", buyThreshold: 82, sellThreshold: 76 },
  ASTS: { category: "SPACE_SPECULATIVE", buyThreshold: 82, sellThreshold: 76 },

  SPY: { category: "ETF_CORE", buyThreshold: 64, sellThreshold: 75 },
  QQQ: { category: "ETF_GROWTH", buyThreshold: 66, sellThreshold: 75 },
  GLD: { category: "GOLD", buyThreshold: 64, sellThreshold: 75 },
  TLT: { category: "BONDS_LONG", buyThreshold: 66, sellThreshold: 75 },
  SHY: { category: "BONDS_SHORT", buyThreshold: 63, sellThreshold: 75 },
  XLV: { category: "HEALTHCARE", buyThreshold: 64, sellThreshold: 75 },
  XLP: { category: "DEFENSIVE_CONSUMER", buyThreshold: 64, sellThreshold: 75 },
  XLE: { category: "ENERGY", buyThreshold: 68, sellThreshold: 75 },
  "BRK.B": { category: "VALUE_HOLDING", buyThreshold: 66, sellThreshold: 75 },
  JPM: { category: "FINANCE", buyThreshold: 68, sellThreshold: 75 },
  PANW: { category: "CYBERSECURITY", buyThreshold: 76, sellThreshold: 76 },
  CRWD: { category: "CYBERSECURITY", buyThreshold: 78, sellThreshold: 76 }
};

const STARTER_PRIORITY = [
  "SPY",
  "GLD",
  "SHY",
  "XLV",
  "XLP",
  "BTC",
  "ETH",
  "PLTR",
  "XLE",
  "JPM",
  "QQQ",
  "BRK.B",
  "PANW",
  "CRWD",
  "GOOG",
  "AMZN",
  "BABA",
  "COIN",
  "SOL",
  "TLT",
  "RKLB",
  "IONQ",
  "ASTS"
];

const TECH_LIKE_CATEGORIES = new Set([
  "AI_BIG_TECH",
  "AI_SPEC_GROWTH",
  "ETF_GROWTH",
  "CYBERSECURITY",
  "CRYPTO_EQUITY",
  "QUANTUM",
  "SPACE",
  "SPACE_SPECULATIVE"
]);

const DEFENSIVE_CATEGORIES = new Set([
  "ETF_CORE",
  "GOLD",
  "BONDS_SHORT",
  "BONDS_LONG",
  "HEALTHCARE",
  "DEFENSIVE_CONSUMER",
  "VALUE_HOLDING"
]);

const runtimeState = {
  scanRunning: false,
  watchRunning: false,
  cooldownMemory: {},
  logs: [],
  lastDecision: null,
  lastWatch: null,
  executionHistory: [],
  lastMarketData: null,
  trendMemory: {}
};

const PROMPT = `
Tu es LEO-AI SENTINEL v10.1.

MISSION :
Gérer un petit portefeuille eToro de manière autonome.
Objectif : construire progressivement un portefeuille diversifié tout en évitant les risques absurdes.

NOUVEAUTÉ v10.1 :
Tu disposes maintenant d'un Diversification Basket.
Le portefeuille ne doit plus être concentré uniquement sur IA / Big Tech / crypto.
Tu peux utiliser :
- ETF larges : SPY, QQQ
- Or : GLD
- Obligations : SHY, TLT
- Secteurs défensifs : XLV, XLP
- Énergie : XLE
- Finance / valeur : JPM, BRK.B
- Cybersécurité : PANW, CRWD

RYTHMES :
1. Realtime Watcher : observe le marché fréquemment, sans acheter ni vendre.
2. Trade Decision Scan : décide BUY, SELL ou HOLD de manière contrôlée.

Tu disposes du MarketDataAgent :
- bid
- ask
- mid
- spread %
- date du prix
- âge du prix
- état healthy / stale par actif

Tu disposes du TrendMemoryAgent :
- hausse depuis le dernier scan
- baisse depuis le dernier scan
- tendance courte
- volatilité approximative
- accélération ou faiblesse relative

Tu disposes aussi d'un Starter Portfolio Mode :
Tant que le portefeuille contient moins de 8 positions, tu dois aider à construire progressivement le portefeuille.
Le bot ne doit pas rester bloqué en HOLD permanent si un actif sain, non déjà détenu, diversifiant, est disponible.

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
NVDA, AMD, ORCL, MSFT, GOOG, AMZN, BABA, COIN, PLTR, RKLB, IONQ, ASTS, BTC, ETH, SOL, SPY, QQQ, GLD, TLT, SHY, XLV, XLP, XLE, BRK.B, JPM, PANW, CRWD.

RÈGLES ABSOLUES :
- Jamais de levier.
- Jamais de short.
- Jamais de all-in.
- Maximum 1 ordre par scan.
- Maximum 10 dollars par ordre.
- Ne jamais choisir un actif hors watchlist.
- Ne jamais acheter un actif déjà présent dans le portefeuille.
- HOLD si le signal est vraiment faible.
- BUY possible si le signal est bon.
- SELL possible si la thèse se casse, si le risque augmente fortement, ou si la protection du capital l'exige.
- Ne pas acheter si le spread est anormalement élevé.
- Ne pas acheter si les données de marché sont incohérentes.
- Ne pas acheter par FOMO après une hausse verticale.
- Ne pas prétendre connaître des informations non fournies.

STARTER PORTFOLIO MODE :
Si positions_count < 8 :
- Ne sois pas trop passif.
- Cherche activement un actif non possédé pour diversifier.
- Si le portefeuille est déjà très AI_BIG_TECH, privilégie SPY, GLD, SHY, XLV, XLP, BTC, ETH, XLE, JPM ou BRK.B.
- Priorité diversification : SPY, GLD, SHY, XLV, XLP, BTC, ETH, PLTR, XLE, JPM.
- Si un actif prioritaire est healthy, non détenu, sans spread élevé, et sans tendance fortement baissière, BUY est acceptable avec confiance 64-74 selon l'actif.
- HOLD seulement si aucun actif sain et non possédé n'est raisonnable.

APRÈS 8 POSITIONS :
- Deviens plus sélectif.
- BUY seulement si signal fort ou diversification très utile.
- SELL seulement si risque clair.

UTILISATION DU TRENDMEMORYAGENT :
- Si un actif solide monte doucement et régulièrement, cela peut renforcer un BUY.
- Si un actif chute fortement depuis le dernier scan, éviter BUY sauf conviction exceptionnelle.
- Si un actif est très volatil, augmenter la prudence.
- Si le TrendMemoryAgent manque d'historique, ne pas inventer une tendance.
- Le trend est un filtre, pas une certitude.

ACTIFS SOLIDES CROISSANCE / IA :
MSFT, GOOG, AMZN, NVDA, AMD, ORCL.
Mais si le portefeuille est déjà très concentré sur AI_BIG_TECH, ne pas en rajouter sauf signal exceptionnel.

ETF LARGES :
SPY = cœur de portefeuille large.
QQQ = croissance tech large, mais reste exposé tech.

DÉFENSIFS :
GLD, SHY, XLV, XLP, BRK.B.
Ces actifs peuvent être achetés avec une confiance plus basse s'ils améliorent la diversification.

CRYPTO MAJEURES :
BTC, ETH.
Achat possible avec une confiance autour de 70/100 si le prix est sain.

ACTIFS PLUS RISQUÉS :
BABA, COIN, PLTR, PANW, CRWD.
Achat possible seulement avec une confiance plus forte.

ACTIFS TRÈS SPÉCULATIFS :
SOL, RKLB, IONQ, ASTS.
Achat seulement si conviction forte.

DIVERSIFICATION :
Si le portefeuille est trop concentré sur AI_BIG_TECH, privilégier :
SPY, GLD, SHY, XLV, XLP, BTC, ETH, XLE, JPM, BRK.B.
Éviter d'empiler plusieurs achats sur le même thème.

VENTE :
Vendre seulement si :
- risque élevé,
- momentum cassé,
- thèse d'investissement cassée,
- besoin clair de protéger le capital.

FORMAT OBLIGATOIRE :
Répondre uniquement en JSON strict.
Pas de texte hors JSON.
Les valeurs de decision doivent être exactement BUY, SELL ou HOLD.

{
  "decision": "BUY|SELL|HOLD",
  "asset": "NVDA|AMD|ORCL|MSFT|GOOG|AMZN|BABA|COIN|PLTR|RKLB|IONQ|ASTS|BTC|ETH|SOL|SPY|QQQ|GLD|TLT|SHY|XLV|XLP|XLE|BRK.B|JPM|PANW|CRWD|NONE",
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

function addWatchLog(entry) {
  const log = {
    time: nowIso(),
    version: VERSION,
    ...entry
  };

  runtimeState.logs.unshift(log);

  if (runtimeState.logs.length > MAX_LOGS) {
    runtimeState.logs = runtimeState.logs.slice(0, MAX_LOGS);
  }

  runtimeState.lastWatch = log;
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

function getFirstNumber(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }

  return null;
}

function getFirstValue(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null) return value;
  }

  return null;
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
    rate.InstrumentId ??
    rate.instrumentIDField ??
    rate.instrumentIdField
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
  const allEntries = Object.entries(WATCHLIST);
  const allIds = allEntries.map(([asset, id]) => id);

  async function fetchRates(ids) {
    const idsParam = ids.join(",");

    const response = await fetch(
      `https://public-api.etoro.com/api/v1/market-data/instruments/rates?instrumentIds=${encodeURIComponent(idsParam)}`,
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

  const primary = await fetchRates(allIds);

  if (
    primary.ok &&
    primary.data &&
    normalizeMarketRates(primary.data).availableCount > 0
  ) {
    const normalized = normalizeMarketRates(primary.data);
    const trendSummary = updateTrendMemory(normalized);

    runtimeState.lastMarketData = {
      time: nowIso(),
      source: "bulk",
      status: primary.status,
      ok: primary.ok,
      data: primary.data,
      normalized,
      trendSummary
    };

    return {
      status: primary.status,
      ok: primary.ok,
      source: "bulk",
      data: primary.data,
      normalized,
      trendSummary
    };
  }

  const collectedRates = [];
  const failures = [];

  for (const [asset, instrumentId] of allEntries) {
    try {
      const single = await fetchRates([instrumentId]);
      const normalizedSingle = normalizeMarketRates(single.data);

      if (single.ok && normalizedSingle.availableCount > 0) {
        const singleRates = extractRawRates(single.data);
        collectedRates.push(...singleRates);
      } else {
        failures.push({
          asset,
          instrumentId,
          status: single.status,
          ok: single.ok,
          data: single.data
        });
      }
    } catch (error) {
      failures.push({
        asset,
        instrumentId,
        error: error.message
      });
    }
  }

  const fallbackData = { rates: collectedRates };
  const normalized = normalizeMarketRates(fallbackData);

  for (const failure of failures) {
    normalized.warnings.push({
      type: "RATE_FETCH_FAILED",
      asset: failure.asset,
      instrumentId: failure.instrumentId,
      status: failure.status || null,
      error: failure.error || null
    });
  }

  const trendSummary = updateTrendMemory(normalized);

  runtimeState.lastMarketData = {
    time: nowIso(),
    source: "fallback-one-by-one",
    status: primary.status,
    ok: collectedRates.length > 0,
    primaryStatus: primary.status,
    primaryOk: primary.ok,
    primaryData: primary.data,
    failures,
    normalized,
    trendSummary
  };

  return {
    status: primary.status,
    ok: collectedRates.length > 0,
    source: "fallback-one-by-one",
    data: {
      primaryStatus: primary.status,
      primaryOk: primary.ok,
      primaryData: primary.data,
      collectedRatesCount: collectedRates.length,
      failures
    },
    normalized,
    trendSummary
  };
}

function extractRawRates(data) {
  if (Array.isArray(data?.rates)) return data.rates;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.Data)) return data.Data;
  if (Array.isArray(data)) return data;
  return [];
}

function normalizeMarketRates(data) {
  const rawRates = extractRawRates(data);

  const ratesByAsset = {};
  const rates = [];

  for (const rate of rawRates) {
    const instrumentId = getInstrumentIdFromRate(rate);
    const asset = assetFromInstrumentId(instrumentId);

    if (asset === "UNKNOWN") continue;

    const bid = getFirstNumber(rate, ["bid", "Bid", "BID"]);
    const ask = getFirstNumber(rate, ["ask", "Ask", "ASK"]);
    const lastExecution = getFirstNumber(rate, [
      "lastExecution",
      "LastExecution",
      "last",
      "Last",
      "price",
      "Price"
    ]);

    const hasBidAsk =
      Number.isFinite(bid) &&
      Number.isFinite(ask) &&
      bid > 0 &&
      ask > 0;

    const mid = hasBidAsk ? (bid + ask) / 2 : lastExecution;
    const spread = hasBidAsk ? ask - bid : null;
    const spreadPct = hasBidAsk && mid > 0 ? (spread / mid) * 100 : null;

    const priceDate = getFirstValue(rate, [
      "date",
      "Date",
      "time",
      "Time",
      "lastUpdate",
      "LastUpdate",
      "lastUpdated",
      "LastUpdated"
    ]);

    const ageMinutes = priceDate ? minutesSince(priceDate) : null;

    const normalized = {
      asset,
      instrumentId,
      bid: roundNumber(bid, 6),
      ask: roundNumber(ask, 6),
      mid: roundNumber(mid, 6),
      lastExecution: Number.isFinite(lastExecution)
        ? roundNumber(lastExecution, 6)
        : null,
      spread: roundNumber(spread, 6),
      spreadPct: roundNumber(spreadPct, 4),
      date: priceDate,
      ageMinutes: ageMinutes === null ? null : roundNumber(ageMinutes, 2),
      healthy:
        Number.isFinite(mid) &&
        mid > 0 &&
        (spreadPct === null || spreadPct <= MAX_ACCEPTABLE_SPREAD_PCT) &&
        (ageMinutes === null || ageMinutes <= MAX_RATE_AGE_MINUTES)
    };

    ratesByAsset[asset] = normalized;
    rates.push(normalized);
  }

  const warnings = [];

  for (const asset of Object.keys(WATCHLIST)) {
    if (!ratesByAsset[asset]) {
      warnings.push({ type: "MISSING_RATE", asset });
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

function updateTrendMemory(marketSummary) {
  const now = nowIso();

  for (const rate of marketSummary.rates || []) {
    if (!rate.asset || !Number.isFinite(Number(rate.mid)) || rate.mid <= 0) {
      continue;
    }

    if (!runtimeState.trendMemory[rate.asset]) {
      runtimeState.trendMemory[rate.asset] = [];
    }

    const history = runtimeState.trendMemory[rate.asset];
    const last = history[history.length - 1];

    const point = {
      time: now,
      mid: Number(rate.mid),
      bid: rate.bid,
      ask: rate.ask,
      spreadPct: rate.spreadPct,
      healthy: rate.healthy,
      ageMinutes: rate.ageMinutes
    };

    if (!last) {
      history.push(point);
    } else {
      const minutesFromLast = minutesSince(last.time);

      if (
        minutesFromLast !== null &&
        minutesFromLast < MIN_MINUTES_BETWEEN_TREND_POINTS
      ) {
        history[history.length - 1] = point;
      } else {
        history.push(point);
      }
    }

    runtimeState.trendMemory[rate.asset] = history.slice(
      -MAX_TREND_POINTS_PER_ASSET
    );
  }

  return buildTrendSummary();
}

function buildTrendSummary() {
  const assets = {};

  for (const [asset, history] of Object.entries(runtimeState.trendMemory)) {
    if (!history || history.length === 0) continue;

    const last = history[history.length - 1];
    const previous = history.length >= 2 ? history[history.length - 2] : null;
    const first = history[0];

    const changePctSinceLast =
      previous && previous.mid > 0
        ? ((last.mid - previous.mid) / previous.mid) * 100
        : null;

    const changePctSinceFirst =
      first && first.mid > 0
        ? ((last.mid - first.mid) / first.mid) * 100
        : null;

    const diffs = [];

    for (let i = 1; i < history.length; i++) {
      const a = history[i - 1];
      const b = history[i];

      if (a.mid > 0 && b.mid > 0) {
        diffs.push(((b.mid - a.mid) / a.mid) * 100);
      }
    }

    const avgAbsMove =
      diffs.length > 0
        ? diffs.reduce((sum, v) => sum + Math.abs(v), 0) / diffs.length
        : null;

    let trendSignal = "insufficient_history";

    if (changePctSinceLast !== null) {
      if (changePctSinceLast >= 2) trendSignal = "strong_up";
      else if (changePctSinceLast >= 0.4) trendSignal = "up";
      else if (changePctSinceLast <= -2) trendSignal = "strong_down";
      else if (changePctSinceLast <= -0.4) trendSignal = "down";
      else trendSignal = "flat";
    }

    let volatilitySignal = "unknown";

    if (avgAbsMove !== null) {
      if (avgAbsMove >= 3) volatilitySignal = "high";
      else if (avgAbsMove >= 1) volatilitySignal = "medium";
      else volatilitySignal = "low";
    }

    assets[asset] = {
      observations: history.length,
      lastMid: roundNumber(last.mid, 6),
      previousMid: previous ? roundNumber(previous.mid, 6) : null,
      firstMid: first ? roundNumber(first.mid, 6) : null,
      changePctSinceLast: roundNumber(changePctSinceLast, 4),
      changePctSinceFirst: roundNumber(changePctSinceFirst, 4),
      averageAbsMovePct: roundNumber(avgAbsMove, 4),
      trendSignal,
      volatilitySignal,
      lastUpdate: last.time,
      healthy: last.healthy
    };
  }

  return {
    updatedAt: nowIso(),
    minMinutesBetweenTrendPoints: MIN_MINUTES_BETWEEN_TREND_POINTS,
    maxPointsPerAsset: MAX_TREND_POINTS_PER_ASSET,
    assets
  };
}

function getTrendForAsset(trendSummary, asset) {
  return trendSummary?.assets?.[asset] || null;
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

  const uniqueOpenAssets = [...new Set(openAssets)];

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

  const starterMode = positions.length < TARGET_STARTER_POSITIONS;
  const diversificationState = buildDiversificationState(openAssets, categoryCounts);

  return {
    positionsCount: positions.length,
    uniquePositionsCount: uniqueOpenAssets.length,
    starterMode,
    diversificationBasketMode: starterMode,
    targetStarterPositions: TARGET_STARTER_POSITIONS,
    missingStarterPositions: Math.max(0, TARGET_STARTER_POSITIONS - positions.length),
    ordersForOpenCount: ordersForOpen.length,
    ordersForCloseCount: ordersForClose.length,
    openPositions,
    openOrders,
    closeOrders,
    openAssets,
    uniqueOpenAssets,
    categoryCounts,
    diversificationState,
    possibleCashOrCredit: clientPortfolio.credit ?? null,
    pendingWarnings
  };
}

function buildDiversificationState(openAssets, categoryCounts) {
  const unique = new Set(openAssets || []);

  const techLikeCount = Object.entries(categoryCounts || {}).reduce(
    (sum, [category, count]) => sum + (TECH_LIKE_CATEGORIES.has(category) ? count : 0),
    0
  );

  const defensiveCount = Object.entries(categoryCounts || {}).reduce(
    (sum, [category, count]) => sum + (DEFENSIVE_CATEGORIES.has(category) ? count : 0),
    0
  );

  const aiBigTechCount = categoryCounts?.AI_BIG_TECH || 0;

  const hasCoreETF = unique.has("SPY");
  const hasGold = unique.has("GLD");
  const hasBonds = unique.has("SHY") || unique.has("TLT");
  const hasDefensiveSector = unique.has("XLV") || unique.has("XLP");
  const hasCryptoMajor = unique.has("BTC") || unique.has("ETH");
  const hasFinanceOrValue = unique.has("JPM") || unique.has("BRK.B");

  const missingBuckets = [];

  if (!hasCoreETF) missingBuckets.push("ETF_CORE");
  if (!hasGold) missingBuckets.push("GOLD");
  if (!hasBonds) missingBuckets.push("BONDS");
  if (!hasDefensiveSector) missingBuckets.push("DEFENSIVE_SECTOR");
  if (!hasCryptoMajor) missingBuckets.push("CRYPTO_MAJOR");
  if (!hasFinanceOrValue) missingBuckets.push("FINANCE_OR_VALUE");

  return {
    techLikeCount,
    defensiveCount,
    aiBigTechCount,
    hasCoreETF,
    hasGold,
    hasBonds,
    hasDefensiveSector,
    hasCryptoMajor,
    hasFinanceOrValue,
    missingBuckets,
    tooConcentratedInAIBigTech: aiBigTechCount >= 4,
    tooConcentratedInTechLike: techLikeCount >= 6 && defensiveCount < 2
  };
}

function getPreferredNextAssets(portfolioSummary, marketSummary) {
  const alreadyOpen = new Set(portfolioSummary.openAssets || []);
  const diversificationState = portfolioSummary.diversificationState || {};

  return STARTER_PRIORITY.map((asset, index) => {
    const rate = marketSummary?.ratesByAsset?.[asset] || null;
    const rules = ASSET_RULES[asset];

    let diversificationReason = "Priorité générale";

    if (asset === "SPY" && !diversificationState.hasCoreETF) {
      diversificationReason = "ETF large cœur de portefeuille manquant";
    } else if (asset === "GLD" && !diversificationState.hasGold) {
      diversificationReason = "Or / protection manquant";
    } else if ((asset === "SHY" || asset === "TLT") && !diversificationState.hasBonds) {
      diversificationReason = "Obligations manquantes";
    } else if ((asset === "XLV" || asset === "XLP") && !diversificationState.hasDefensiveSector) {
      diversificationReason = "Secteur défensif manquant";
    } else if ((asset === "BTC" || asset === "ETH") && !diversificationState.hasCryptoMajor) {
      diversificationReason = "Crypto majeure manquante";
    } else if ((asset === "JPM" || asset === "BRK.B") && !diversificationState.hasFinanceOrValue) {
      diversificationReason = "Finance / valeur manquante";
    }

    return {
      priority: index + 1,
      asset,
      category: rules?.category || "UNKNOWN",
      alreadyOpen: alreadyOpen.has(asset),
      healthy: rate ? Boolean(rate.healthy) : false,
      spreadPct: rate?.spreadPct ?? null,
      ageMinutes: rate?.ageMinutes ?? null,
      mid: rate?.mid ?? null,
      diversificationReason
    };
  }).filter((item) => !item.alreadyOpen);
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
  let rawDecision = String(decision?.decision || "HOLD").toUpperCase();

  const decisionMap = {
    BUY: "BUY",
    ACHAT: "BUY",
    ACHETER: "BUY",
    SELL: "SELL",
    VENTE: "SELL",
    VENDRE: "SELL",
    HOLD: "HOLD",
    CONSERVER: "HOLD",
    GARDER: "HOLD",
    ATTENDRE: "HOLD"
  };

  rawDecision = decisionMap[rawDecision] || "HOLD";

  const clean = {
    decision: rawDecision,
    asset: String(decision?.asset || "NONE").toUpperCase(),
    amount_usd: Number(decision?.amount_usd || 0),
    confidence: normalizeConfidence(decision?.confidence),
    reason: String(decision?.reason || "Aucune raison fournie").slice(0, 500),
    risk_check: String(decision?.risk_check || "failed").toLowerCase()
  };

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

function riskController(decision, portfolioResponse, marketData, trendSummary) {
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

  const trend = getTrendForAsset(trendSummary, d.asset);

  if (
    d.decision === "BUY" &&
    trend &&
    trend.trendSignal === "strong_down" &&
    d.confidence < 85
  ) {
    return {
      approved: false,
      finalDecision: {
        ...d,
        decision: "HOLD",
        asset: "NONE",
        amount_usd: 0
      },
      reason: `TrendMemoryAgent bloque : tendance forte baissière sur ${d.asset}`
    };
  }

  if (
    d.decision === "BUY" &&
    trend &&
    trend.volatilitySignal === "high" &&
    d.confidence < 88
  ) {
    return {
      approved: false,
      finalDecision: {
        ...d,
        decision: "HOLD",
        asset: "NONE",
        amount_usd: 0
      },
      reason: `TrendMemoryAgent bloque : volatilité élevée sur ${d.asset}`
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

    const category = rules.category;
    const diversificationState = summary.diversificationState || {};

    if (
      category === "AI_BIG_TECH" &&
      diversificationState.tooConcentratedInAIBigTech &&
      d.confidence < 90
    ) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Surconcentration AI_BIG_TECH : priorité à la diversification avant d'ajouter ${d.asset}`
      };
    }

    if (
      category === "ETF_GROWTH" &&
      diversificationState.tooConcentratedInTechLike &&
      !diversificationState.hasCoreETF &&
      d.confidence < 82
    ) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `QQQ reste très tech : priorité SPY/GLD/SHY/XLV/XLP avant ${d.asset}`
      };
    }

    if (
      category === "CYBERSECURITY" &&
      diversificationState.tooConcentratedInTechLike &&
      d.confidence < 84
    ) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Cybersécurité proche tech : diversification défensive prioritaire avant ${d.asset}`
      };
    }

    let buyThreshold = rules.buyThreshold;

    if (
      summary.starterMode &&
      STARTER_PRIORITY.includes(d.asset) &&
      summary.positionsCount < TARGET_STARTER_POSITIONS
    ) {
      if (DEFENSIVE_CATEGORIES.has(category)) {
        buyThreshold = Math.max(60, buyThreshold - 5);
      } else if (category === "CRYPTO_MAJOR" || category === "ETF_CORE") {
        buyThreshold = Math.max(64, buyThreshold - 3);
      } else {
        buyThreshold = Math.max(66, buyThreshold - 2);
      }
    }

    if (d.confidence < buyThreshold) {
      return {
        approved: false,
        finalDecision: {
          ...d,
          decision: "HOLD",
          asset: "NONE",
          amount_usd: 0
        },
        reason: `Confiance BUY trop faible (${d.confidence} < ${buyThreshold})`
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
    return { skipped: true, reason: "AUTO_TRADE disabled. No real order executed." };
  }

  if (!process.env.ETORO_API_KEY || !process.env.ETORO_USER_KEY) {
    return { skipped: true, reason: "Missing ETORO_API_KEY or ETORO_USER_KEY. No real order executed." };
  }

  const executionUrl = process.env.ETORO_BUY_URL || "";

  if (!executionUrl) {
    return {
      skipped: true,
      reason: "ETORO_BUY_URL missing. Execution is locked to avoid sending an order to a wrong endpoint."
    };
  }

  const instrumentId = WATCHLIST[asset];

  const payload = {
    instrumentID: instrumentId,
    instrumentId,
    isBuy: true,
    amount: Number(amount),
    leverage: 1
  };

  const response = await fetch(executionUrl, {
    method: "POST",
    headers: etoroHeaders(),
    body: JSON.stringify(payload)
  });

  const data = await readJsonResponse(response);

  return {
    skipped: false,
    ok: response.ok,
    status: response.status,
    asset,
    amount,
    payload,
    data
  };
}

async function executeSell(asset, portfolioResponse) {
  if (!AUTO_TRADE) {
    return { skipped: true, reason: "AUTO_TRADE disabled. No real order executed." };
  }

  if (!process.env.ETORO_API_KEY || !process.env.ETORO_USER_KEY) {
    return { skipped: true, reason: "Missing ETORO_API_KEY or ETORO_USER_KEY. No real order executed." };
  }

  const executionUrl = process.env.ETORO_SELL_URL || "";

  if (!executionUrl) {
    return {
      skipped: true,
      reason: "ETORO_SELL_URL missing. Execution is locked to avoid sending an order to a wrong endpoint."
    };
  }

  const position = findOpenPosition(portfolioResponse, asset);
  const positionId = position ? getPositionId(position) : null;

  if (!positionId) {
    return {
      skipped: true,
      reason: `No valid open position id found for ${asset}.`
    };
  }

  const instrumentId = WATCHLIST[asset];

  const payload = {
    positionID: positionId,
    positionId,
    instrumentID: instrumentId,
    instrumentId
  };

  const response = await fetch(executionUrl, {
    method: "POST",
    headers: etoroHeaders(),
    body: JSON.stringify(payload)
  });

  const data = await readJsonResponse(response);

  return {
    skipped: false,
    ok: response.ok,
    status: response.status,
    asset,
    positionId,
    payload,
    data
  };
}

function hasEtoroConfig() {
  return Boolean(process.env.ETORO_API_KEY && process.env.ETORO_USER_KEY);
}

function buildMockPortfolioResponse() {
  return {
    status: 200,
    ok: !AUTO_TRADE,
    source: "mock-no-etoro-config",
    data: {
      clientPortfolio: {
        positions: [],
        ordersForOpen: [],
        ordersForClose: [],
        credit: null
      }
    }
  };
}

async function getSafePortfolio() {
  if (!hasEtoroConfig()) {
    return buildMockPortfolioResponse();
  }

  try {
    return await getPortfolio();
  } catch (error) {
    return {
      status: 0,
      ok: false,
      source: "portfolio-fetch-error",
      error: error.message,
      data: {
        clientPortfolio: {
          positions: [],
          ordersForOpen: [],
          ordersForClose: [],
          credit: null
        }
      }
    };
  }
}

function buildMockMarketData() {
  const now = nowIso();

  const rates = Object.entries(WATCHLIST).map(([asset, instrumentId], index) => {
    const mid = 100 + index * 3;

    return {
      instrumentID: instrumentId,
      bid: roundNumber(mid * 0.999, 6),
      ask: roundNumber(mid * 1.001, 6),
      date: now
    };
  });

  const normalized = normalizeMarketRates({ rates });
  const trendSummary = updateTrendMemory(normalized);

  runtimeState.lastMarketData = {
    time: nowIso(),
    source: "mock-no-etoro-config",
    status: 200,
    ok: !AUTO_TRADE,
    data: { rates },
    normalized,
    trendSummary
  };

  return {
    status: 200,
    ok: !AUTO_TRADE,
    source: "mock-no-etoro-config",
    data: { rates },
    normalized,
    trendSummary
  };
}

async function getSafeMarketData() {
  if (!hasEtoroConfig()) {
    return buildMockMarketData();
  }

  try {
    return await getMarketRates();
  } catch (error) {
    const mock = buildMockMarketData();

    return {
      ...mock,
      ok: false,
      source: "market-fetch-error-with-mock-fallback",
      error: error.message
    };
  }
}

function buildHoldDecision(reason, confidence = 0) {
  return {
    decision: "HOLD",
    asset: "NONE",
    amount_usd: 0,
    confidence,
    reason,
    risk_check: "passed"
  };
}

function parseAiJson(content) {
  if (!content || typeof content !== "string") {
    return buildHoldDecision("Empty AI response");
  }

  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");

    if (start >= 0 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1));
      } catch {
        return buildHoldDecision("AI response was not valid JSON");
      }
    }

    return buildHoldDecision("AI response was not valid JSON");
  }
}

async function getAiDecision(context) {
  if (!client || !process.env.OPENAI_API_KEY) {
    return buildHoldDecision("OPENAI_API_KEY missing. AI decision disabled.");
  }

  try {
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content:
            "Use this JSON context and answer with strict JSON only.\n" +
            JSON.stringify(context)
        }
      ]
    });

    const content = completion.choices?.[0]?.message?.content || "";
    return parseAiJson(content);
  } catch (error) {
    return buildHoldDecision(`OpenAI decision error: ${error.message}`);
  }
}

function compactMarketData(marketData) {
  return {
    source: marketData?.source || null,
    status: marketData?.status ?? null,
    ok: Boolean(marketData?.ok),
    availableCount: marketData?.normalized?.availableCount ?? 0,
    requestedCount: marketData?.normalized?.requestedCount ?? Object.keys(WATCHLIST).length,
    warnings: (marketData?.normalized?.warnings || []).slice(0, 20)
  };
}

async function runWatcher(trigger = "manual") {
  if (runtimeState.watchRunning) {
    return {
      status: "skipped",
      reason: "Watcher already running",
      time: nowIso()
    };
  }

  runtimeState.watchRunning = true;

  try {
    const marketData = await getSafeMarketData();

    const result = {
      status: "ok",
      type: "watch",
      trigger,
      version: VERSION,
      time: nowIso(),
      marketData: compactMarketData(marketData),
      trendSummary: marketData.trendSummary || buildTrendSummary()
    };

    addWatchLog(result);
    return result;
  } catch (error) {
    const result = {
      status: "error",
      type: "watch",
      trigger,
      version: VERSION,
      time: nowIso(),
      error: error.message
    };

    addWatchLog(result);
    return result;
  } finally {
    runtimeState.watchRunning = false;
  }
}

async function runDecisionScan(trigger = "manual") {
  if (runtimeState.scanRunning) {
    return {
      status: "skipped",
      reason: "Scan already running",
      time: nowIso()
    };
  }

  runtimeState.scanRunning = true;

  try {
    const portfolioResponse = await getSafePortfolio();
    const marketData = await getSafeMarketData();
    const trendSummary = marketData.trendSummary || buildTrendSummary();

    const portfolioSummary = extractPortfolioSummary(portfolioResponse);

    const preferredNextAssets = getPreferredNextAssets(
      portfolioSummary,
      marketData.normalized
    ).slice(0, 15);

    if (AUTO_TRADE && !portfolioResponse.ok) {
      const forcedHold = buildHoldDecision(
        "Portfolio unavailable while AUTO_TRADE is true. Execution blocked."
      );

      const result = {
        status: "ok",
        type: "scan",
        trigger,
        version: VERSION,
        time: nowIso(),
        autoTrade: AUTO_TRADE,
        portfolioOk: portfolioResponse.ok,
        portfolioStatus: portfolioResponse.status,
        marketData: compactMarketData(marketData),
        portfolioSummary,
        preferredNextAssets,
        aiDecision: forcedHold,
        risk: {
          approved: false,
          finalDecision: forcedHold,
          reason: forcedHold.reason
        },
        execution: {
          skipped: true,
          reason: forcedHold.reason
        }
      };

      addLog(result);
      return result;
    }

    const aiContext = {
      version: VERSION,
      time: nowIso(),
      autoTrade: AUTO_TRADE,
      requireFreshRateForExecution: REQUIRE_FRESH_RATE_FOR_EXECUTION,
      limits: {
        maxOrderUsd: MAX_ORDER_USD,
        maxOpenPositions: MAX_OPEN_POSITIONS,
        maxExecutedOrders24h: MAX_EXECUTED_ORDERS_24H,
        maxBuys24h: MAX_BUYS_24H,
        maxSells24h: MAX_SELLS_24H,
        minHoursBetweenExecutions: MIN_HOURS_BETWEEN_EXECUTIONS
      },
      portfolioSummary,
      marketData: {
        summary: compactMarketData(marketData),
        rates: marketData?.normalized?.rates || []
      },
      trendSummary,
      preferredNextAssets,
      executionStats24h: getExecutionStats24h()
    };

    const aiDecisionRaw = await getAiDecision(aiContext);
    const aiDecision = sanitizeDecision(aiDecisionRaw);

    const risk = riskController(
      aiDecision,
      portfolioResponse,
      marketData,
      trendSummary
    );

    let execution = {
      skipped: true,
      reason: risk.approved ? "Execution not started" : risk.reason
    };

    if (risk.approved && risk.finalDecision.decision === "BUY") {
      execution = await executeBuy(
        risk.finalDecision.asset,
        risk.finalDecision.amount_usd
      );

      if (!execution.skipped && execution.ok) {
        setCooldown(risk.finalDecision.asset);

        addExecutionHistory({
          type: "BUY",
          asset: risk.finalDecision.asset,
          amount_usd: risk.finalDecision.amount_usd,
          executionStatus: execution.status
        });
      }
    }

    if (risk.approved && risk.finalDecision.decision === "SELL") {
      execution = await executeSell(risk.finalDecision.asset, portfolioResponse);

      if (!execution.skipped && execution.ok) {
        addExecutionHistory({
          type: "SELL",
          asset: risk.finalDecision.asset,
          amount_usd: 0,
          executionStatus: execution.status
        });
      }
    }

    const result = {
      status: "ok",
      type: "scan",
      trigger,
      version: VERSION,
      time: nowIso(),
      autoTrade: AUTO_TRADE,
      portfolioOk: portfolioResponse.ok,
      portfolioStatus: portfolioResponse.status,
      marketData: compactMarketData(marketData),
      portfolioSummary,
      preferredNextAssets,
      aiDecision,
      risk,
      execution,
      executionStats24h: getExecutionStats24h()
    };

    addLog(result);
    return result;
  } catch (error) {
    const result = {
      status: "error",
      type: "scan",
      trigger,
      version: VERSION,
      time: nowIso(),
      error: error.message,
      stack: process.env.NODE_ENV === "production" ? undefined : error.stack
    };

    addLog(result);
    return result;
  } finally {
    runtimeState.scanRunning = false;
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    app: "LEO-AI SENTINEL",
    version: VERSION,
    autoTrade: AUTO_TRADE,
    message: "Backend is running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    version: VERSION,
    time: nowIso(),
    node: process.version,
    autoTrade: AUTO_TRADE,
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    hasEtoroConfig: hasEtoroConfig()
  });
});

app.get("/test-instruments", (req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    count: Object.keys(WATCHLIST).length,
    instruments: Object.entries(WATCHLIST).map(([asset, instrumentId]) => ({
      asset,
      instrumentId,
      category: ASSET_RULES[asset]?.category || "UNKNOWN"
    }))
  });
});

app.get("/watch", requireSecret, async (req, res) => {
  const result = await runWatcher("manual-http");
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.get("/scan", requireSecret, async (req, res) => {
  const result = await runDecisionScan("manual-http-get");
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.post("/scan", requireSecret, async (req, res) => {
  const result = await runDecisionScan("manual-http-post");
  res.status(result.status === "error" ? 500 : 200).json(result);
});

app.get("/state", requireSecret, (req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    time: nowIso(),
    autoTrade: AUTO_TRADE,
    requireFreshRateForExecution: REQUIRE_FRESH_RATE_FOR_EXECUTION,
    executionStats24h: getExecutionStats24h(),
    lastDecision: runtimeState.lastDecision,
    lastWatch: runtimeState.lastWatch,
    lastMarketData: runtimeState.lastMarketData
      ? {
          time: runtimeState.lastMarketData.time,
          source: runtimeState.lastMarketData.source,
          status: runtimeState.lastMarketData.status,
          ok: runtimeState.lastMarketData.ok,
          normalized: runtimeState.lastMarketData.normalized,
          trendSummary: runtimeState.lastMarketData.trendSummary
        }
      : null
  });
});

app.get("/logs", requireSecret, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), MAX_LOGS);

  res.json({
    status: "ok",
    count: Math.min(limit, runtimeState.logs.length),
    logs: runtimeState.logs.slice(0, limit)
  });
});

app.get("/portfolio", requireSecret, async (req, res) => {
  const portfolioResponse = await getSafePortfolio();

  res.status(portfolioResponse.ok ? 200 : 502).json({
    status: portfolioResponse.ok ? "ok" : "error",
    portfolioResponse,
    portfolioSummary: extractPortfolioSummary(portfolioResponse)
  });
});

app.get("/market", requireSecret, async (req, res) => {
  const marketData = await getSafeMarketData();

  res.status(marketData.ok ? 200 : 502).json({
    status: marketData.ok ? "ok" : "error",
    marketData: compactMarketData(marketData),
    normalized: marketData.normalized,
    trendSummary: marketData.trendSummary
  });
});

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: "Route not found"
  });
});

app.use((err, req, res, next) => {
  console.error("Server error:", err);

  res.status(500).json({
    status: "error",
    message: "Internal server error"
  });
});

cron.schedule(WATCH_CRON_SCHEDULE, () => {
  runWatcher("cron").catch((error) => {
    addWatchLog({
      status: "error",
      type: "watch-cron",
      error: error.message
    });
  });
});

cron.schedule(TRADE_CRON_SCHEDULE, () => {
  runDecisionScan("cron").catch((error) => {
    addLog({
      status: "error",
      type: "scan-cron",
      error: error.message
    });
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`${VERSION} running on port ${PORT}`);
  console.log(`AUTO_TRADE=${AUTO_TRADE}`);
  console.log(`REQUIRE_FRESH_RATE_FOR_EXECUTION=${REQUIRE_FRESH_RATE_FOR_EXECUTION}`);
});
