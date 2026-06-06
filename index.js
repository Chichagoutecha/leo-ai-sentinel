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

const PROMPT = `
Tu es LEO-AI SENTINEL v5.1.
Objectif : protéger le capital avant le profit.

Portefeuille agent eToro autonome.
Budget réduit : prudence maximale.

Actifs autorisés uniquement :
NVDA, AMD, ORCL, MSFT, GOOG, AMZN, BABA, COIN, PLTR, RKLB, IONQ, ASTS, BTC, ETH, SOL.

Règles obligatoires :
- jamais de levier
- jamais de all-in
- 1 ordre max par scan
- ordre max 10$
- HOLD par défaut
- BUY uniquement si signal très clair
- SELL uniquement si risque élevé, surchauffe ou thèse cassée
- ne jamais acheter un actif non listé
- ne jamais dépasser 10$
- si doute : HOLD
- répondre uniquement en JSON strict :
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
  res.send("LEO-AI SENTINEL v5.1 actif");
});

app.get("/etoro-test", async (req, res) => {
  try {
    const response = await fetch(
      "https://public-api.etoro.com/api/v1/trading/info/portfolio",
      {
        method: "GET",
        headers: etoroHeaders()
      }
    );

    const data = await response.json();
    res.json({ status: response.status, ok: response.ok, data });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get("/watchlist", (req, res) => {
  res.json(WATCHLIST);
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
    res.json({ symbol, status: response.status, ok: response.ok, data });
  } catch (error) {
    res.json({ error: error.message });
  }
});

async function executeBuy(asset, amount) {
  const instrumentId = WATCHLIST[asset];

  if (!instrumentId) {
    return { skipped: true, reason: "Actif non autorisé" };
  }

  if (!AUTO_TRADE) {
    return { skipped: true, reason: "AUTO_TRADE désactivé" };
  }

  if (amount > 10) {
    return { skipped: true, reason: "Montant supérieur à 10$ interdit" };
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
        amount
      })
    }
  );

  const data = await response.json();

  return {
    status: response.status,
    ok: response.ok,
    asset,
    instrumentId,
    amount,
    data
  };
}

async function scanMarket() {
  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: PROMPT },
      {
        role: "user",
        content:
          "Scan automatique du portefeuille. Analyse uniquement les actifs autorisés. Décide BUY, SELL ou HOLD. Protection du capital prioritaire."
      }
    ]
  });

  const raw = response.choices[0].message.content;
  console.log("SCAN IA :", raw);

  let decision;

  try {
    decision = JSON.parse(raw);
  } catch (e) {
    return {
      error: "Réponse IA non JSON",
      raw
    };
  }

  let execution = { skipped: true, reason: "Aucun ordre exécuté" };

  if (
    decision.decision === "BUY" &&
    decision.risk_check === "passed" &&
    decision.confidence >= 75 &&
    WATCHLIST[decision.asset] &&
    decision.amount_usd > 0 &&
    decision.amount_usd <= 10
  ) {
    execution = await executeBuy(decision.asset, decision.amount_usd);
  }

  return {
    auto_trade_enabled: AUTO_TRADE,
    decision,
    execution
  };
}

app.get("/scan", async (req, res) => {
  try {
    const result = await scanMarket();
    res.json(result);
  } catch (err) {
    res.json({ error: "Erreur scan : " + err.message });
  }
});

app.get("/buy-test", async (req, res) => {
  try {
    const asset = req.query.asset;
    const amount = Number(req.query.amount || 10);

    if (!asset || !WATCHLIST[asset]) {
      return res.json({
        error: "Actif invalide. Exemple : /buy-test?asset=NVDA&amount=10",
        allowed_assets: Object.keys(WATCHLIST)
      });
    }

    const result = await executeBuy(asset, amount);
    res.json(result);
  } catch (error) {
    res.json({ error: error.message });
  }
});

cron.schedule("0 */2 * * *", async () => {
  console.log("Scan automatique toutes les 2h lancé");
  await scanMarket();
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("LEO-AI SENTINEL v5.1 lancé sur le port " + PORT);
});
