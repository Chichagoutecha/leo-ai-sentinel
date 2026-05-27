cconst express = require("express");
const OpenAI = require("openai");
const cron = require("node-cron");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const AUTO_TRADE = process.env.AUTO_TRADE === "true";

const PROMPT = `
Tu es LEO-AI SENTINEL v5.0.

MISSION :
Gérer automatiquement un portefeuille eToro.

OBJECTIF :
- protéger le capital
- éviter les grosses pertes
- croissance progressive long terme
- HOLD par défaut
- BUY seulement si signal fort
- SELL seulement si risque élevé ou thèse cassée

RÈGLES DE RISQUE :
- jamais de levier
- jamais all-in
- ordre max : 10€
- 1 ordre maximum par scan
- cash toujours protégé
- éviter FOMO
- éviter actifs ultra spéculatifs

SECTEURS PRIORITAIRES :
- IA
- Big Tech
- Crypto
- Chine
- Énergie
- Or
- Quantum
- Espace

ACTIFS À SURVEILLER :
- NVIDIA
- Microsoft
- Bitcoin
- Tencent
- Rocket Lab
- IonQ
- Gold ETF
- Palantir

FORMAT JSON STRICT :
{
  "decision":"BUY|SELL|HOLD",
  "asset":"nom actif ou NONE",
  "amount_eur":0,
  "confidence":0-100,
  "reason":"explication courte",
  "risk_check":"passed|failed"
}
`;

app.get("/", (req, res) => {
  res.send("LEO-AI SENTINEL actif");
});



// =========================
// TEST ETORO
// =========================

app.get("/etoro-test", async (req, res) => {

  try {

    const response = await fetch(
      "https://public-api.etoro.com/api/v1/agent-portfolios/client-portfolio",
      {
        method: "GET",
        headers: {
          "x-api-key": process.env.ETORO_API_KEY,
          "x-user-key": process.env.ETORO_USER_KEY,
          "x-request-id": randomUUID()
        }
      }
    );

    const data = await response.json();

    res.json({
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



// =========================
// RECHERCHE INSTRUMENTS
// =========================

app.get("/test-instruments", async (req, res) => {

  try {

    const response = await fetch(
      "https://public-api.etoro.com/api/v1/market-data/instruments?query=tencent",
      {
        method: "GET",
        headers: {
          "x-api-key": process.env.ETORO_API_KEY,
          "x-user-key": process.env.ETORO_USER_KEY,
          "x-request-id": randomUUID()
        }
      }
    );

    const data = await response.json();

    res.json({
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



// =========================
// SCAN IA
// =========================

async function scanMarket() {

  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: PROMPT
      },
      {
        role: "user",
        content:
          "Analyse marchés : IA, Big Tech, crypto, Chine, énergie, or, quantum et espace. Décide BUY SELL ou HOLD."
      }
    ]
  });

  const text = response.choices[0].message.content;

  console.log("SCAN IA :", text);

  return text;
}



// =========================
// ROUTE SCAN
// =========================

app.get("/scan", async (req, res) => {

  try {

    const result = await scanMarket();

    res.send(result);

  } catch (err) {

    res.send("Erreur scan : " + err.message);

  }

});



// =========================
// CRON AUTOMATIQUE
// =========================

cron.schedule("0 */2 * * *", async () => {

  console.log("Scan automatique toutes les 2h lancé");

  await scanMarket();

});



// =========================
// SERVEUR
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log("LEO-AI SENTINEL lancé sur le port " + PORT);

});

app.listen(PORT, () => {

  console.log("LEO-AI SENTINEL lancé sur le port " + PORT);

});
