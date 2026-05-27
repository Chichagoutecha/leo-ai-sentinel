const express = require("express");
const OpenAI = require("openai");
const cron = require("node-cron");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const AUTO_TRADE = process.env.AUTO_TRADE === "true";

const PROMPT = `
Tu es LEO-AI SENTINEL v4.5.
Objectif : protéger le capital avant le profit.
Portefeuille agent eToro : 172€ investis, 27€ cash disponible.
Règles :
- pas de levier
- pas de all-in
- cash toujours protégé
- 1 ordre max par scan
- ordre max 10€
- HOLD par défaut
- BUY uniquement si signal clair
- SELL si thèse cassée, surchauffe, risque élevé ou protection du capital
- répondre en JSON strict :
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

app.get("/etoro-test", async (req, res) => {
  try {
    const response = await fetch("https://public-api.etoro.com/api/v1/agent-portfolios", {
      method: "GET",
      headers: {
        "x-api-key": process.env.ETORO_API_KEY,
        "x-user-key": process.env.ETORO_USER_KEY,
        "x-request-id": randomUUID()
      }
    });

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

async function scanMarket() {
  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: PROMPT },
      {
        role: "user",
        content:
          "Scan automatique : analyse IA, Big Tech, crypto, Chine, énergie, or, quantum, espace. Décide BUY SELL ou HOLD selon les règles."
      }
    ]
  });

  const text = response.choices[0].message.content;
  console.log("SCAN IA :", text);
  return text;
}

app.get("/scan", async (req, res) => {
  try {
    const result = await scanMarket();
    res.send(result);
  } catch (err) {
    res.send("Erreur scan : " + err.message);
  }
});

cron.schedule("0 */2 * * *", async () => {
  console.log("Scan automatique toutes les 2h lancé");
  await scanMarket();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("LEO-AI SENTINEL lancé sur le port " + PORT);
});
