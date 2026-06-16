const express = require("express");
const OpenAI = require("openai");
const cron = require("node-cron");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const VERSION = "v8.2-secure-logs-autonomous";

const AUTO_TRADE = process.env.AUTO_TRADE === "true";
const BOT_SECRET = process.env.BOT_SECRET || "";

const MAX_ORDER_USD = 10;
const MAX_OPEN_POSITIONS = 10;
const BUY_COOLDOWN_HOURS = 6;
const MAX_LOGS = 50;

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
  lastDecision: null
};

const PROMPT = `
Tu es LEO-AI SENTINEL v8.2.

MISSION :
Gérer un petit portefeuille eToro de manière autonome.
Objectif : faire mieux qu'un investisseur humain prudent, sans prendre de risques absurdes.

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

PHILOSOPHIE :
Le bot ne doit pas être trop bridé.
Il doit pouvoir acheter les actifs solides avec un niveau de confiance raisonnable.
Il doit rester plus strict sur les actifs spéculatifs.

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

IMPORTANT :
Tu n'as pas encore de vraies données de marché live complètes.
Donc ne prétends pas connaître un prix exact intraday.
Raisonne prudemment à partir du contexte fourni.

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

function getClientPortfolio(portfolioResponse) {
  return portfolioResponse?.data?.clientPortfolio || {};
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

  const openAssets = openPositions
    .map((p) => p.asset)
    .filter((asset) => asset !== "UNKNOWN");

  const categoryCounts = {};

  for (const asset of openAssets) {
    const category = ASSET_RULES[asset]?.category || "UNKNOWN";
    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
  }

  return {
    positionsCount: positions.length,
    ordersForOpenCount: ordersForOpen.length,
    ordersForCloseCount: ordersForClose.length,
    openPositions,
    openAssets,
    categoryCounts,
    possibleCashOrCredit: clientPortfolio.credit ?? null
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

  return ordersForOpen.some((o) => {
    const instrumentId = Number(
      o.instrumentID ??
      o.instrumentId ??
      o.InstrumentID ??
      o.InstrumentId
    );

    return instrumentId === wantedId;
  });
}

function hasCloseOrder(portfolioResponse, asset) {
  const clientPortfolio = getClientPortfolio(portfolioResponse);
  const ordersForClose = clientPortfolio.ordersForClose || [];
  const wantedId = WATCHLIST[asset];

  return ordersForClose.some((o) => {
    const instrumentId = Number(
      o.instrumentID ??
      o.instrumentId ??
      o.InstrumentID ??
      o.InstrumentId
    );

    return instrumentId === wantedId;
  });
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

function riskController(decision, portfolioResponse) {
  const d = sanitizeDecision(decision);
  const summary = extractPortfolioSummary(portfolioResponse);

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

  const rules = ASSET_RULES[d.asset];

  if (d.decision === "BUY") {
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
      reason: "BUY approuvé"
    };
  }

  if (d.decision === "SELL") {
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
      reason: "SELL approuvé"
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

  const data = await readJsonResponse(response);

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

async function askDecisionAgent(portfolioSummary, source) {
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
          watchlist: WATCHLIST,
          asset_rules: ASSET_RULES,
          portfolio_summary: portfolioSummary,
          instruction:
            "Analyse le portefeuille et décide BUY, SELL ou HOLD. Tu peux être actif mais pas imprudent. Une seule décision."
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

    let decisionRaw;

    try {
      decisionRaw = await askDecisionAgent(portfolioSummary, source);
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
        error: error.message
      });

      return failed;
    }

    const control = riskController(decisionRaw, portfolio);

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
      agents: {
        portfolioSummary,
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
      portfolio: {
        positionsCount: portfolioSummary.positionsCount,
        ordersForOpenCount: portfolioSummary.ordersForOpenCount,
        ordersForCloseCount: portfolioSummary.ordersForCloseCount,
        openAssets: portfolioSummary.openAssets,
        categoryCounts: portfolioSummary.categoryCounts
      }
    });

    return result;
  } finally {
    runtimeState.scanRunning = false;
  }
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
      portfolio_status: portfolio.status,
      portfolio_ok: portfolio.ok,
      positions_count: summary.positionsCount,
      orders_for_open_count: summary.ordersForOpenCount,
      orders_for_close_count: summary.ordersForCloseCount,
      open_assets: summary.openAssets,
      category_counts: summary.categoryCounts,
      cooldown_memory: runtimeState.cooldownMemory,
      last_decision: runtimeState.lastDecision
    });
  } catch (error) {
    res.json({
      version: VERSION,
      error: error.message
    });
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
      execution: result
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
      execution: result
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
