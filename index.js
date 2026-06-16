const express = require("express");
const OpenAI = require("openai");
const cron = require("node-cron");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

const COOLDOWN_HOURS = 6;
const MAX_BUY_AMOUNT = 10;
const MIN_CONFIDENCE = 75;
const MAX_PENDING_ORDERS = 1;

const lastTradeMemory = {};

const PROMPT = `
Tu es LEO-AI SENTINEL v7.2.

MISSION :
Gérer automatiquement un portefeuille eToro avec prudence maximale.

OBJECTIF :
Protéger le capital avant le profit.

ACTIFS AUTORISÉS UNIQUEMENT :
NVDA, AMD, ORCL, MSFT, GOOG, AMZN, BABA, COIN, PLTR, RKLB, IONQ, ASTS, BTC, ETH, SOL.

RÈGLES ABSOLUES :
- jamais de levier
- jamais de short
- jamais de all-in
- maximum 1 ordre par scan
- maximum 10$ par achat
- HOLD par défaut
- si doute : HOLD
- ne jamais acheter hors watchlist
- ne jamais vendre hors watchlist
- ne jamais acheter par FOMO
- SELL uniquement si protection du capital nécessaire
- BUY uniquement si signal très fort

RÉPONSE JSON STRICTE :
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

app.get("/", (req, res) => {
  res.send("LEO-AI SENTINEL v7.2 sécurité portefeuille actif");
});

app.get("/watchlist", (req, res) => {
  res.json(WATCHLIST);
});

async function getPortfolio() {
  const response = await fetch(
    "https://public-api.etoro.com/api/v1/trading/info/portfolio",
    { method: "GET", headers: etoroHeaders() }
  );

  const data = await response.json();
  return { status: response.status, ok: response.ok, data };
}

function getClientPortfolio(portfolioData) {
  return portfolioData?.clientPortfolio || portfolioData?.data?.clientPortfolio || {};
}

function getPositions(portfolioData) {
  const cp = getClientPortfolio(portfolioData);
  return cp.positions || [];
}

function getOrdersForOpen(portfolioData) {
  const cp = getClientPortfolio(portfolioData);
  return cp.ordersForOpen || [];
}

function getOrdersForClose(portfolioData) {
  const cp = getClientPortfolio(portfolioData);
  return cp.ordersForClose || [];
}

function hasOpenPosition(portfolioData, asset) {
  const instrumentId = WATCHLIST[asset];
  return getPositions(portfolioData).some((p) => {
    const pid = p.instrumentID || p.instrumentId || p.InstrumentID || p.InstrumentId;
    return Number(pid) === Number(instrumentId);
  });
}

function hasPendingOpenOrder(portfolioData, asset) {
  const instrumentId = WATCHLIST[asset];
  return getOrdersForOpen(portfolioData).some((o) => {
    const oid = o.instrumentID || o.instrumentId || o.InstrumentID || o.InstrumentId;
    return Number(oid) === Number(instrumentId);
  });
}

function hasPendingCloseOrder(portfolioData, asset) {
  const instrumentId = WATCHLIST[asset];
  return getOrdersForClose(portfolioData).some((o) => {
    const oid = o.instrumentID || o.instrumentId || o.InstrumentID || o.InstrumentId;
    return Number(oid) === Number(instrumentId);
  });
}

function findOpenPosition(portfolioData, asset) {
  const instrumentId = WATCHLIST[asset];

  return getPositions(portfolioData).find((p) => {
    const pid = p.instrumentID || p.instrumentId || p.InstrumentID || p.InstrumentId;
    return Number(pid) === Number(instrumentId);
  });
}

function cooldownActive(asset) {
  const last = lastTradeMemory[asset];
  if (!last) return false;

  const now = Date.now();
  const diffHours = (now - last) / 1000 / 60 / 60;

  return diffHours < COOLDOWN_HOURS;
}

function markTrade(asset) {
  lastTradeMemory[asset] = Date.now();
}

function securityCheckBuy(asset, amount, portfolioData) {
  if (!WATCHLIST[asset]) {
    return { passed: false, reason: "Actif non autorisé" };
  }

  if (!AUTO_TRADE) {
    return { passed: false, reason: "AUTO_TRADE désactivé" };
  }

  if (amount <= 0 || amount > MAX_BUY_AMOUNT) {
    return { passed: false, reason: "Montant invalide ou supérieur à 10$" };
  }

  if (cooldownActive(asset)) {
    return { passed: false, reason: "Cooldown actif sur " + asset };
  }

  if (hasOpenPosition(portfolioData, asset)) {
    return { passed: false, reason: "Position déjà ouverte sur " + asset };
  }

  if (hasPendingOpenOrder(portfolioData, asset)) {
    return { passed: false, reason: "Ordre d'achat déjà en attente sur " + asset };
  }

  const pendingOrders = getOrdersForOpen(portfolioData);

  if (pendingOrders.length >= MAX_PENDING_ORDERS) {
    return { passed: false, reason: "Trop d'ordres en attente" };
  }

  return { passed: true, reason: "Achat autorisé" };
}

function securityCheckSell(asset, portfolioData) {
  if (!WATCHLIST[asset]) {
    return { passed: false, reason: "Actif non autorisé" };
  }

  if (!AUTO_TRADE) {
    return { passed: false, reason: "AUTO_TRADE désactivé" };
  }

  if (cooldownActive(asset)) {
    return { passed: false, reason: "Cooldown actif sur " + asset };
  }

  if (hasPendingCloseOrder(portfolioData, asset)) {
    return { passed: false, reason: "Ordre de vente déjà en attente sur " + asset };
  }

  if (!hasOpenPosition(portfolioData, asset)) {
    return { passed: false, reason: "Aucune position ouverte sur " + asset };
  }

  return { passed: true, reason: "Vente autorisée" };
}

async function executeBuy(asset, amount, portfolioData) {
  const check = securityCheckBuy(asset, amount, portfolioData);

  if (!check.passed) {
    return { skipped: true, reason: check.reason };
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

  const data = await response.json();

  if (response.ok) markTrade(asset);

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
  const check = securityCheckSell(asset, portfolioData);

  if (!check.passed) {
    return { skipped: true, reason: check.reason };
  }

  const instrumentId = WATCHLIST[asset];
  const position = findOpenPosition(portfolioData, asset);

  const positionId =
    position.positionID ||
    position.positionId ||
    position.PositionID ||
    position.PositionId;

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

  const data = await response.json();

  if (response.ok) markTrade(asset);

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

async function scanMarket() {
  const portfolio = await getPortfolio();

  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: PROMPT },
      {
        role: "user",
        content:
          "Voici le portefeuille réel eToro : " +
          JSON.stringify(portfolio.data).slice(0, 12000) +
          ". Analyse seulement la watchlist. Décide BUY, SELL ou HOLD. Un seul ordre maximum. Protection du capital prioritaire."
      }
    ]
  });

  const raw = response.choices[0].message.content;
  console.log("SCAN IA :", raw);

  let decision;

  try {
    decision = JSON.parse(raw);
  } catch (e) {
    return { error: "Réponse IA non JSON", raw };
  }

  let execution = { skipped: true, reason: "Aucun ordre exécuté" };

  if (
    decision.risk_check === "passed" &&
    decision.confidence >= MIN_CONFIDENCE &&
    WATCHLIST[decision.asset]
  ) {
    if (decision.decision === "BUY") {
      execution = await executeBuy(
        decision.asset,
        Number(decision.amount_usd),
        portfolio.data
      );
    }

    if (decision.decision === "SELL") {
      execution = await executeSell(decision.asset, portfolio.data);
    }
  }

  return {
    version: "v7.2",
    auto_trade_enabled: AUTO_TRADE,
    portfolio_status: portfolio.status,
    decision,
    execution
  };
}

app.get("/scan", async (req, res) => {
  try {
    res.json(await scanMarket());
  } catch (err) {
    res.json({ error: "Erreur scan : " + err.message });
  }
});

app.get("/etoro-test", async (req, res) => {
  try {
    res.json(await getPortfolio());
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/status", async (req, res) => {
  try {
    const portfolio = await getPortfolio();

    res.json({
      version: "v7.2",
      auto_trade_enabled: AUTO_TRADE,
      watchlist: WATCHLIST,
      positions_count: getPositions(portfolio.data).length,
      orders_for_open_count: getOrdersForOpen(portfolio.data).length,
      orders_for_close_count: getOrdersForClose(portfolio.data).length,
      cooldown_memory: lastTradeMemory
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/buy-test", async (req, res) => {
  try {
    const portfolio = await getPortfolio();
    const asset = req.query.asset;
    const amount = Number(req.query.amount || 10);

    if (!asset || !WATCHLIST[asset]) {
      return res.json({
        error: "Actif invalide. Exemple : /buy-test?asset=NVDA&amount=10",
        allowed_assets: Object.keys(WATCHLIST)
      });
    }

    res.json(await executeBuy(asset, amount, portfolio.data));
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/sell-test", async (req, res) => {
  try {
    const portfolio = await getPortfolio();
    const asset = req.query.asset;

    if (!asset || !WATCHLIST[asset]) {
      return res.json({
        error: "Actif invalide. Exemple : /sell-test?asset=NVDA",
        allowed_assets: Object.keys(WATCHLIST)
      });
    }

    res.json(await executeSell(asset, portfolio.data));
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/resolve-symbol", async (req, res) => {
  try {
    const symbol = req.query.symbol;

    if (!symbol) {
      return res.json({ error: "Ajoute ?symbol=NVDA par exemple" });
    }

    const response = await fetch(
      `https://public-api.etoro.com/api/v1/market-data/search?internalSymbolFull=${encodeURIComponent(symbol)}&fields=instrumentId,internalSymbolFull,displayname`,
      {
        method: "GET",
        headers: etoroHeaders()
      }
    );

    const data = await response.json();

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
  console.log("Scan automatique v7.2 toutes les 2h lancé");
  await scanMarket();
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("LEO-AI SENTINEL v7.2 lancé sur le port " + PORT);
});
