// actualizado
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const { buildSystemPrompt } = require("./systemPrompt");

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ---- Config del negocio (editable sin tocar código) ----
const CONFIG_PATH = path.join(__dirname, "config.json");
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// ---- Menú del local (se puede reemplazar subiendo un PDF nuevo desde /admin) ----
const DATA_DIR = path.join(__dirname, "data");
const MENU_PATH = path.join(DATA_DIR, "menu.txt");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function loadMenuText() {
  try {
    return fs.readFileSync(MENU_PATH, "utf8");
  } catch {
    return "(Todavía no se cargó el menú. Avisale al cliente que un encargado confirma precios y productos.)";
  }
}

// ---- Memoria de conversación por número (en memoria; para producción real
//      conviene pasar esto a una base de datos, ej. Postgres en Railway) ----
const conversations = new Map(); // phone -> [{role, content}]

const {
  ANTHROPIC_API_KEY,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  ADMIN_PASSWORD,
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
    if (!message) {
      console.log("Webhook recibido sin mensaje (probablemente un status update) — se ignora.");
      return;
    }

    const from = message.from; // número del cliente
    console.log(`Mensaje recibido de ${from}, tipo: ${message.type}`);

    const contentBlocks = await buildUserContentBlocks(message);
    if (!contentBlocks) return;

    const history = conversations.get(from) || [];
    history.push({ role: "user", content: contentBlocks });

    const config = loadConfig();
    const menuText = loadMenuText();
    const replyText = await askClaude(history, config, menuText);
    console.log(`Respuesta de Claude generada (${replyText.length} caracteres):`, replyText.slice(0, 200));

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
async function askClaude(history, config, menuText) {
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
      system: buildSystemPrompt(config, menuText),
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
  console.log(`Enviando mensaje a ${to} vía WhatsApp (Phone Number ID: ${WHATSAPP_PHONE_NUMBER_ID})...`);
  const response = await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
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
  const data = await response.json();
  if (!response.ok) {
    console.error("ERROR al enviar mensaje por WhatsApp:", JSON.stringify(data));
  } else {
    console.log("Mensaje enviado a WhatsApp OK:", JSON.stringify(data));
  }
}

app.get("/", (_req, res) => res.send("Chaparrita agente — backend activo ✅"));

// ==================== Panel simple para actualizar el menú subiendo un PDF ====================
app.get("/admin", (_req, res) => {
  res.type("html").send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8"><title>Chaparrita — Actualizar menú</title>
      <style>
        body { font-family: sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #2b2118; }
        h1 { font-size: 20px; }
        input, button { font-size: 15px; padding: 10px; width: 100%; box-sizing: border-box; margin-top: 8px; }
        button { background: #C0392B; color: white; border: none; border-radius: 6px; margin-top: 16px; cursor: pointer; }
        label { font-weight: bold; font-size: 13px; }
      </style>
    </head>
    <body>
      <h1>🌮 Actualizar menú de Chaparrita</h1>
      <p>Subí el PDF del menú nuevo. El agente lo va a usar en la próxima conversación, sin necesidad de tocar código.</p>
      <form action="/admin/upload-menu" method="POST" enctype="multipart/form-data">
        <label>Contraseña de administrador</label>
        <input type="password" name="password" required />
        <label>Archivo PDF del menú</label>
        <input type="file" name="menuPdf" accept="application/pdf" required />
        <button type="submit">Subir y actualizar menú</button>
      </form>
    </body>
    </html>
  `);
});

app.post("/admin/upload-menu", upload.single("menuPdf"), async (req, res) => {
  try {
    if (!ADMIN_PASSWORD || req.body.password !== ADMIN_PASSWORD) {
      return res.status(401).send("Contraseña incorrecta.");
    }
    if (!req.file) {
      return res.status(400).send("No se recibió ningún archivo PDF.");
    }

    const parsed = await pdfParse(req.file.buffer);
    const text = parsed.text.trim();
    if (!text) {
      return res.status(400).send("No se pudo extraer texto del PDF (¿es un PDF escaneado como imagen?).");
    }

    fs.writeFileSync(MENU_PATH, text, "utf8");
    console.log(`Menú actualizado desde /admin (${text.length} caracteres).`);

    res.type("html").send(`
      <!DOCTYPE html><html lang="es"><body style="font-family:sans-serif;max-width:480px;margin:60px auto;padding:0 20px;">
      <h2>✅ Menú actualizado</h2>
      <p>Se guardaron ${text.length} caracteres de texto extraído del PDF. El agente ya lo va a usar desde el próximo mensaje.</p>
      <p><a href="/admin">Volver a subir otro</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error("Error al procesar el PDF del menú:", err);
    res.status(500).send("Hubo un error al procesar el PDF. Probá de nuevo.");
  }
});

app.listen(PORT, () => console.log(`Chaparrita backend escuchando en el puerto ${PORT}`));
