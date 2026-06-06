 const express = require("express");
const OpenAI = require("openai");
const cron = require("node-cron");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const AUTO_TRADE = process.env.AUTO_TRADE === "true";

const WATCHLIST = {
  NVDA: 8760, AMD: 1832, ORCL: 1135, MSFT: 8757, GOOG: 8758,
  AMZN: 8753, BABA: 2490, COIN: 9401, PLTR: 7991, RKLB: 14320,
  IONQ: 13596, ASTS: 10088, BTC: 100109, ETH: 100001, SOL: 100063
};

const PROMPT = `
Tu es LEO-AI SENTINEL v7.0.

MISSION :
Gérer automatiquement un portefeuille eToro avec achats ET ventes.
Priorité absolue : protéger le capital avant le profit.

MODE :
BOT AUTONOME COMPLET ACTIVÉ.

ACTIFS AUTORISÉS UNIQUEMENT :
NVDA, AMD, ORCL, MSFT, GOOG, AMZN, BABA, COIN, PLTR, RKLB, IONQ, ASTS, BTC, ETH, SOL

RÈGLES :
- jamais de levier
- jamais de short
- jamais de all-in
- maximum 1 ordre par scan
- maximum 10$ par achat
- HOLD par défaut
- si doute : HOLD
- BUY seulement si signal fort
- SELL seulement si protection du capital nécessaire
- ne jamais acheter ou vendre hors watchlist
- ne jamais vendre par panique
- vendre si thèse cassée, risque élevé, momentum détruit, surchauffe extrême, ou profit à protéger

CONFIANCE :
- confidence < 75 = HOLD obligatoire
- confidence >= 75 = BUY ou SELL possible
- confidence >= 90 = décision forte

FORMAT JSON STRICT :
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
  res.send("LEO-AI SENTINEL v7.0 BUY + SELL actif");
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

app.get("/etoro-test", async (req, res) => {
  try {
    res.json(await getPortfolio());
  } catch (error) {
    res.json({ error: error.message });
  }
});

function findOpenPosition(portfolioData, asset) {
  const instrumentId = WATCHLIST[asset];
  const positions =
    portfolioData?.data?.clientPortfolio?.positions ||
    portfolioData?.clientPortfolio?.positions ||
    portfolioData?.positions ||
    [];

  return positions.find((p) => {
    const pid = p.instrumentID || p.instrumentId || p.InstrumentID || p.InstrumentId;
    const isOpen = p.isOpen !== false;
    return Number(pid) === Number(instrumentId) && isOpen;
  });
}

async function executeBuy(asset, amount) {
  const instrumentId = WATCHLIST[asset];

  if (!instrumentId) return { skipped: true, reason: "Actif non autorisé" };
  if (!AUTO_TRADE) return { skipped: true, reason: "AUTO_TRADE désactivé" };
  if (amount > 10) return { skipped: true, reason: "Montant supérieur à 10$ interdit" };

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
  return { status: response.status, ok: response.ok, type: "BUY", asset, instrumentId, amount, data };
}

async function executeSell(asset) {
  const instrumentId = WATCHLIST[asset];

  if (!instrumentId) return { skipped: true, reason: "Actif non autorisé" };
  if (!AUTO_TRADE) return { skipped: true, reason: "AUTO_TRADE désactivé" };

  const portfolio = await getPortfolio();
  const position = findOpenPosition(portfolio.data, asset);

  if (!position) {
    return { skipped: true, reason: "Aucune position ouverte trouvée pour " + asset, portfolio };
  }

  const positionId =
    position.positionID || position.positionId || position.PositionID || position.PositionId;

  if (!positionId) {
    return { skipped: true, reason: "Position trouvée mais positionId introuvable", position };
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
  return { status: response.status, ok: response.ok, type: "SELL", asset, instrumentId, positionId, data };
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
          "Scan automatique. Voici le portefeuille réel : " +
          JSON.stringify(portfolio.data).slice(0, 12000) +
          ". Décide BUY, SELL ou HOLD. Un seul ordre maximum."
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
    decision.confidence >= 75 &&
    WATCHLIST[decision.asset]
  ) {
    if (
      decision.decision === "BUY" &&
      decision.amount_usd > 0 &&
      decision.amount_usd <= 10
    ) {
      execution = await executeBuy(decision.asset, decision.amount_usd);
    }

    if (decision.decision === "SELL") {
      execution = await executeSell(decision.asset);
    }
  }

  return {
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

app.get("/buy-test", async (req, res) => {
  try {
    const asset = req.query.asset;
    const amount = Number(req.query.amount || 10);
    res.json(await executeBuy(asset, amount));
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/sell-test", async (req, res) => {
  try {
    const asset = req.query.asset;
    if (!asset || !WATCHLIST[asset]) {
      return res.json({
        error: "Actif invalide. Exemple : /sell-test?asset=NVDA",
        allowed_assets: Object.keys(WATCHLIST)
      });
    }
    res.json(await executeSell(asset));
  } catch (error) {
    res.json({ error: error.message });
  }
});

cron.schedule("0 */2 * * *", async () => {
  console.log("Scan automatique BUY + SELL toutes les 2h lancé");
  await scanMarket();
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("LEO-AI SENTINEL v7.0 lancé sur le port " + PORT);
});
