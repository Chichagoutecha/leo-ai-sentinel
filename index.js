const express = require("express");
const OpenAI = require("openai");
const cron = require("node-cron");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const VERSION = "v10.2-persistent-memory-audit";

const AUTO_TRADE = process.env.AUTO_TRADE === "true";
const BOT_SECRET = process.env.BOT_SECRET || "";

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const STATE_KEY = process.env.STATE_KEY || "leo-ai-sentinel-v10-state";
const LOCAL_STATE_FILE = path.join("/tmp", "leo-ai-sentinel-state.json");

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

let memoryBackend = "memory-only";
let lastMemoryLoad = null;
let lastMemorySave = null;
let lastMemoryError = null;
let saveTimer = null;

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
Tu es LEO-AI SENTINEL v10.2.

MISSION :
Gérer un petit portefeuille eToro de manière autonome.
Objectif : construire progressivement un portefeuille diversifié tout en évitant les risques absurdes.

NOUVEAUTÉ v10.2 :
Tu disposes maintenant d'une mémoire persistante et d'un journal d'audit.
Le bot doit garder en mémoire :
- les logs récents,
- les décisions,
- l'historique des ordres,
- les cooldowns,
- le TrendMemoryAgent,
- les dernières données marché.

NOUVEAUTÉ v10.1 CONSERVÉE :
Tu disposes d'un Diversification Basket.
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

function hasUpstashMemory() {
  return Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readJsonResponse(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function upstashCommand(command) {
  const response = await fetch(UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await readJsonResponse(response);

  if (!response.ok || data?.error) {
    throw new Error(data?.error || `Erreur Upstash ${response.status}`);
  }

  return data?.result;
}

function buildPersistentState() {
  return {
    savedAt: nowIso(),
    version: VERSION,
    cooldownMemory: runtimeState.cooldownMemory || {},
    logs: (runtimeState.logs || []).slice(0, MAX_LOGS),
    lastDecision: runtimeState.lastDecision || null,
    lastWatch: runtimeState.lastWatch || null,
    executionHistory: runtimeState.executionHistory || [],
    trendMemory: runtimeState.trendMemory || {},
    lastMarketData: runtimeState.lastMarketData
      ? {
          time: runtimeState.lastMarketData.time,
          source: runtimeState.lastMarketData.source,
          status: runtimeState.lastMarketData.status,
          ok: runtimeState.lastMarketData.ok,
          normalized: runtimeState.lastMarketData.normalized || null,
          trendSummary: runtimeState.lastMarketData.trendSummary || null
        }
      : null
  };
}

function applyPersistentState(state) {
  if (!state || typeof state !== "object") return false;

  if (state.cooldownMemory && typeof state.cooldownMemory === "object") {
    runtimeState.cooldownMemory = state.cooldownMemory;
  }

  if (Array.isArray(state.logs)) {
    runtimeState.logs = state.logs.slice(0, MAX_LOGS);
  }

  if (state.lastDecision) runtimeState.lastDecision = state.lastDecision;
  if (state.lastWatch) runtimeState.lastWatch = state.lastWatch;

  if (Array.isArray(state.executionHistory)) {
    runtimeState.executionHistory = state.executionHistory.filter((e) => {
      const age = hoursSince(e.time);
      return age !== null && age <= 24;
    });
  }

  if (state.trendMemory && typeof state.trendMemory === "object") {
    runtimeState.trendMemory = state.trendMemory;
  }

  if (state.lastMarketData) runtimeState.lastMarketData = state.lastMarketData;

  return true;
}

async function loadPersistentState() {
  try {
    if (hasUpstashMemory()) {
      memoryBackend = "upstash-redis";

      const raw = await upstashCommand(["GET", STATE_KEY]);

      if (raw) {
        const state = typeof raw === "string" ? safeJsonParse(raw) : raw;
        const loaded = applyPersistentState(state);
        lastMemoryLoad = nowIso();
        console.log(
          loaded
            ? `Mémoire persistante chargée depuis Upstash : ${STATE_KEY}`
            : "Mémoire Upstash trouvée mais illisible"
        );
        return loaded;
      }

      lastMemoryLoad = nowIso();
      console.log("Aucune mémoire Upstash existante, démarrage propre.");
      return false;
    }

    memoryBackend = "local-json-fallback";

    if (fs.existsSync(LOCAL_STATE_FILE)) {
      const raw = fs.readFileSync(LOCAL_STATE_FILE, "utf8");
      const state = safeJsonParse(raw);
      const loaded = applyPersistentState(state);
      lastMemoryLoad = nowIso();
      console.log(
        loaded
          ? `Mémoire locale chargée : ${LOCAL_STATE_FILE}`
          : "Mémoire locale trouvée mais illisible"
      );
      return loaded;
    }

    lastMemoryLoad = nowIso();
    console.log("Aucune mémoire locale existante.");
    return false;
  } catch (error) {
    lastMemoryError = error.message;
    console.error("Erreur chargement mémoire persistante:", error.message);
    return false;
  }
}

async function savePersistentState() {
  try {
    const payload = JSON.stringify(buildPersistentState());

    if (hasUpstashMemory()) {
      memoryBackend = "upstash-redis";
      await upstashCommand(["SET", STATE_KEY, payload]);
    } else {
      memoryBackend = "local-json-fallback";
      fs.writeFileSync(LOCAL_STATE_FILE, payload, "utf8");
    }

    lastMemorySave = nowIso();
    lastMemoryError = null;
    return true;
  } catch (error) {
    lastMemoryError = error.message;
    console.error("Erreur sauvegarde mémoire persistante:", error.message);
    return false;
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    savePersistentState().catch((error) => {
      lastMemoryError = error.message;
      console.error("Erreur sauvegarde différée:", error.message);
    });
  }, 1000);
}

function memoryStatus() {
  return {
    backend: memoryBackend,
    upstash_configured: hasUpstashMemory(),
    state_key: STATE_KEY,
    local_state_file: LOCAL_STATE_FILE,
    last_load: lastMemoryLoad,
    last_save: lastMemorySave,
    last_error: lastMemoryError,
    logs_count: runtimeState.logs.length,
    trend_assets_count: Object.keys(runtimeState.trendMemory || {}).length,
    execution_history_count: runtimeState.executionHistory.length,
    has_last_decision: Boolean(runtimeState.lastDecision),
    has_last_watch: Boolean(runtimeState.lastWatch)
  };
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
  scheduleSave();
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
  scheduleSave();
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

  scheduleSave();
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

function extractRawRates(data) {
  if (Array.isArray(data?.rates)) return data.rates;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.Data)) return data.Data;
  if (Array.isArray(data)) return data;
  return [];
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

    scheduleSave();

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

  scheduleSave();

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

  const summary = buildTrendSummary();
  scheduleSave();
  return summary;
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
