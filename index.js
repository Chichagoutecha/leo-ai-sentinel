const express = require("express");
const OpenAI = require("openai");
const cron = require("node-cron");

const app = express();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.send("Leo AI Sentinel opérationnel");
});

async function analyseMarche() {
  console.log("Analyse du marché en cours...");

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Tu es une IA d'analyse financière spécialisée dans les cycles boursiers, le risque et les signaux BUY SELL HOLD."
        },
        {
          role: "user",
          content:
            "Analyse rapidement le marché technologique chinois et donne une recommandation simple : BUY, SELL ou HOLD avec une explication courte."
        }
      ]
    });

    console.log(completion.choices[0].message.content);

  } catch (error) {
    console.error(error);
  }
}

cron.schedule("0 */2 * * *", () => {
  analyseMarche();
});

app.listen(3000, () => {
  console.log("Serveur IA lancé sur le port 3000");
});
