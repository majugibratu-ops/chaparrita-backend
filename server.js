require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { buildSystemPrompt } = require("./systemPrompt");

const app = express();
app.use(express.json());

// ---- Config del negocio (editable sin tocar código) ----
const CONFIG_PATH = path.join(__dirname, "config.json");
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// ---- Memoria de conversación por número (en memoria; para producción real
//      conviene pasar esto a una base de datos, ej. Postgres en Railway) ----
const conversations = new Map(); // phone -> [{role, content}]

const {
  ANTHROPIC_API_KEY,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  PORT = 3000,
} = process.env;

// ==================== Verificación del webhook (Meta) ====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ==================== Recepción de mensajes ====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // confirmamos recepción rápido, procesamos después

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message) return; // status updates, etc. — ignoramos

    const from = message.from; // número del cliente
    const contentBlocks = await buildUserContentBlocks(message);
    if (!contentBlocks) return;

    const history = conversations.get(from) || [];
    history.push({ role: "user", content: contentBlocks });

    const config = loadConfig();
    const replyText = await askClaude(history, config);

    const { cleanText, reservaConfirmada } = extractReservaMarker(replyText);

    history.push({ role: "assistant", content: [{ type: "text", text: cleanText }] });
    conversations.set(from, history);

    await sendWhatsappText(from, cleanText);

    if (reservaConfirmada && config.grupoReservasWhatsappId) {
      await sendWhatsappText(config.grupoReservasWhatsappId, reservaConfirmada);
    }
  } catch (err) {
    console.error("Error procesando mensaje:", err);
  }
});

// ==================== Construir el contenido del mensaje del cliente ====================
async function buildUserContentBlocks(message) {
  if (message.type === "text") {
    return [{ type: "text", text: message.text.body }];
  }

  if (message.type === "image") {
    const mediaId = message.image.id;
    const { base64, mimeType } = await downloadWhatsappMedia(mediaId);
    return [
      { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
      { type: "text", text: message.image.caption || "Te mando la imagen." },
    ];
  }

  // Otros tipos (audio, documento, ubicación, etc.) — se pueden sumar acá.
  return [{ type: "text", text: "[El cliente mandó un tipo de mensaje que todavía no procesamos automáticamente]" }];
}

async function downloadWhatsappMedia(mediaId) {
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const meta = await metaRes.json();
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { base64: buffer.toString("base64"), mimeType: meta.mime_type };
}

// ==================== Llamada a la API de Claude ====================
async function askClaude(history, config) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: buildSystemPrompt(config),
      messages: history,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Error de la API de Claude:", data);
    return "Uy, tuvimos un problemita técnico. En un rato te contesto, disculpá.";
  }

  return (data.content || [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

// Saca la marca interna [[RESERVA_CONFIRMADA]] y devuelve el texto limpio + el resumen a reenviar
function extractReservaMarker(text) {
  const marker = "[[RESERVA_CONFIRMADA]]";
  const idx = text.indexOf(marker);
  if (idx === -1) return { cleanText: text, reservaConfirmada: null };
  const cleanText = text.slice(0, idx).trim();
  const reservaConfirmada = text.slice(idx + marker.length).trim();
  return { cleanText, reservaConfirmada };
}

// ==================== Envío de mensajes por WhatsApp ====================
async function sendWhatsappText(to, body) {
  await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
}

app.get("/", (_req, res) => res.send("Chaparrita agente — backend activo ✅"));

app.listen(PORT, () => console.log(`Chaparrita backend escuchando en el puerto ${PORT}`));
