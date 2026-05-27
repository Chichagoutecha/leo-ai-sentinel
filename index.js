const express = require("express");
const OpenAI = require("openai");

const app = express();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.send("Leo AI Sentinel opérationnel");
});

app.get("/scan", async (req, res) => {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "user",
          content: "Dis bonjour et confirme que l'IA fonctionne."
        }
      ]
    });

    res.send(response.choices[0].message.content);

  } catch (error) {
    console.error(error);
    res.send("Erreur OpenAI : " + error.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
