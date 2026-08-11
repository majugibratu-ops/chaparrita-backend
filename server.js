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

// ---- Carpeta de datos que necesita persistir entre reinicios (hay que montarle
//      un Volume en Railway — ver README) ----
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Config del negocio (editable sin tocar código) ----
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LEGACY_CONFIG_PATH = path.join(__dirname, "config.json");
if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(LEGACY_CONFIG_PATH)) {
  fs.copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
  console.log("Migrado config.json a data/config.json (primera vez que arranca con esta versión).");
}
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// ---- Menú del local (se puede reemplazar subiendo un PDF nuevo desde /admin) ----
const MENU_PATH = path.join(DATA_DIR, "menu.txt");
function loadMenuText() {
  try {
    return fs.readFileSync(MENU_PATH, "utf8");
  } catch {
    return "(Todavía no se cargó el menú. Avisale al cliente que un encargado confirma precios y productos.)";
  }
}

function diaDeHoyArgentina() {
  const dia = new Intl.DateTimeFormat("es-AR", { weekday: "long", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  return dia.charAt(0).toUpperCase() + dia.slice(1);
}

function fechaDeHoyISOArgentina() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date()); // en-CA da directo formato YYYY-MM-DD
}

function horaActualArgentina() {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false });
  return fmt.format(new Date()); // HH:MM
}

// ---- Reservas guardadas (para mandar el recordatorio 1hs antes) ----
const RESERVAS_PATH = path.join(DATA_DIR, "reservas.json");
function loadReservas() {
  try {
    return JSON.parse(fs.readFileSync(RESERVAS_PATH, "utf8"));
  } catch {
    return [];
  }
}
function saveReservas(lista) {
  fs.writeFileSync(RESERVAS_PATH, JSON.stringify(lista, null, 2), "utf8");
}

// Arma el texto de confirmación/actualización de una reserva, reutilizado tanto por el
// envío automático del bot como por el botón manual del panel /admin/reservas.
function construirMensajeConfirmacionReserva(r) {
  const nombre = r.nombre ? r.nombre.split(" ")[0] : "";
  return (
    `¡Hola${nombre ? " " + nombre : ""}! 👋 Te confirmamos tu reserva en Chaparrita:\n\n` +
    `📅 Fecha: ${r.fecha}\n` +
    `🕒 Horario: ${r.hora}hs\n` +
    `👥 Personas: ${r.personas || "-"}\n` +
    `📍 Sector: ${r.sector || "a confirmar"}\n\n` +
    `¡Te esperamos! 🌮`
  );
}

// ---- Disponibilidad de mesas (calculada, no requiere que nadie la marque a mano) ----
const SECTORES_VALIDOS = ["adentro", "patio", "vereda"];

function minutosDesdeHHMM(hhmm) {
  const [h, m] = (hhmm || "00:00").split(":").map(Number);
  return h * 60 + (m || 0);
}

// Cuenta cuántas mesas de un sector están ocupadas en un horario dado, comparando
// contra las reservas existentes de esa misma fecha y sector, con superposición de horario.
function calcularDisponibilidad(config, reservas, sector, fechaISO, horaHHMM) {
  const mesasPorSector = config.mesasPorSector || {};
  const totalMesas = Number(mesasPorSector[sector]) || 0;

  // Si todavía no se cargó la cantidad de mesas de este sector en /admin/config,
  // no bloqueamos reservas por las dudas — se comporta como si no hubiera límite.
  if (totalMesas <= 0) {
    return { totalMesas: null, ocupadas: 0, libres: null, sinConfigurar: true };
  }

  const duracionMin = config.duracionMesaMinutos || 90;
  const inicioSolicitado = minutosDesdeHHMM(horaHHMM);
  const finSolicitado = inicioSolicitado + duracionMin;

  const ocupadas = reservas.filter((r) => {
    if (r.fecha !== fechaISO) return false;
    if ((r.sector || "").toLowerCase() !== sector) return false;
    const inicioExistente = minutosDesdeHHMM(r.hora);
    const finExistente = inicioExistente + duracionMin;
    // Se superponen si uno empieza antes de que el otro termine, en ambas direcciones.
    return inicioSolicitado < finExistente && inicioExistente < finSolicitado;
  }).length;

  const libres = Math.max(0, totalMesas - ocupadas);
  return { totalMesas, ocupadas, libres, sinConfigurar: false };
}

function extractDisponibilidadMarker(text) {
  const regex = /\[\[CONSULTAR_DISPONIBILIDAD:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, consulta: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    return { cleanText, consulta: JSON.parse(match[1]) };
  } catch {
    console.error("No se pudo parsear CONSULTAR_DISPONIBILIDAD:", match[1]);
    return { cleanText, consulta: null };
  }
}

function extractListaEsperaMarker(text) {
  const regex = /\[\[LISTA_ESPERA:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, datosEspera: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    return { cleanText, datosEspera: JSON.parse(match[1]) };
  } catch {
    console.error("No se pudo parsear LISTA_ESPERA:", match[1]);
    return { cleanText, datosEspera: null };
  }
}

// Saca la marca interna [[CONSULTAR_MIS_RESERVAS]] (sin datos, el sistema ya sabe el teléfono)
function extractConsultarReservasMarker(text) {
  const marker = "[[CONSULTAR_MIS_RESERVAS]]";
  const idx = text.indexOf(marker);
  if (idx === -1) return { cleanText: text, quiereConsultarReservas: false };
  const cleanText = (text.slice(0, idx) + text.slice(idx + marker.length)).trim();
  return { cleanText, quiereConsultarReservas: true };
}

// Saca la marca interna [[ACTUALIZAR_RESERVA: {...}]] y devuelve el texto limpio + los cambios
function extractActualizarReservaMarker(text) {
  const regex = /\[\[ACTUALIZAR_RESERVA:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, actualizacion: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    return { cleanText, actualizacion: JSON.parse(match[1]) };
  } catch {
    console.error("No se pudo parsear ACTUALIZAR_RESERVA:", match[1]);
    return { cleanText, actualizacion: null };
  }
}

// Saca la marca interna [[CANCELAR_RESERVA: {"id":"..."}]] y devuelve el texto limpio + el id
function extractCancelarReservaMarker(text) {
  const regex = /\[\[CANCELAR_RESERVA:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, cancelacion: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    return { cleanText, cancelacion: JSON.parse(match[1]) };
  } catch {
    console.error("No se pudo parsear CANCELAR_RESERVA:", match[1]);
    return { cleanText, cancelacion: null };
  }
}

// Saca la marca interna [[CONSULTAR_LISTA_COMPRAS]] (sin datos, solo la pide el dueño)
function extractConsultarListaComprasMarker(text) {
  const marker = "[[CONSULTAR_LISTA_COMPRAS]]";
  const idx = text.indexOf(marker);
  if (idx === -1) return { cleanText: text, quiereListaCompras: false };
  const cleanText = (text.slice(0, idx) + text.slice(idx + marker.length)).trim();
  return { cleanText, quiereListaCompras: true };
}

// Saca la marca interna [[MARCAR_COMPRADO: {"ids": [...]}]] y devuelve el texto limpio + los ids
function extractMarcarCompradoMarker(text) {
  const regex = /\[\[MARCAR_COMPRADO:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, marcarComprado: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    return { cleanText, marcarComprado: JSON.parse(match[1]) };
  } catch {
    console.error("No se pudo parsear MARCAR_COMPRADO:", match[1]);
    return { cleanText, marcarComprado: null };
  }
}

// ---- Lista de espera (cuando no hay mesas disponibles en el sector/horario pedido) ----
const LISTA_ESPERA_PATH = path.join(DATA_DIR, "listaEspera.json");
function loadListaEspera() {
  try {
    return JSON.parse(fs.readFileSync(LISTA_ESPERA_PATH, "utf8"));
  } catch {
    return [];
  }
}
function saveListaEspera(lista) {
  fs.writeFileSync(LISTA_ESPERA_PATH, JSON.stringify(lista, null, 2), "utf8");
}

// ---- Lista de compras diaria (cocina + barra + salón mandan su pedido, se consolida y
//      se le manda al dueño cuando lo pide, marcando qué falta comprar) ----
const LISTA_COMPRAS_PATH = path.join(DATA_DIR, "listaCompras.json");
const ROLES_COMPRAS = ["cocina", "barra", "salon"];

function listaComprasVacia(fechaISO) {
  return {
    fecha: fechaISO,
    envios: {
      cocina: { recibido: false, textoOriginal: "" },
      barra: { recibido: false, textoOriginal: "" },
      salon: { recibido: false, textoOriginal: "" },
    },
    items: [], // {id, texto, categoria, comprado, origen}
  };
}

function loadListaCompras(fechaHoyISO) {
  let datos;
  try {
    datos = JSON.parse(fs.readFileSync(LISTA_COMPRAS_PATH, "utf8"));
  } catch {
    datos = listaComprasVacia(fechaHoyISO);
  }
  // Si la lista guardada es de un día anterior, arrancamos de cero automáticamente.
  if (datos.fecha !== fechaHoyISO) {
    datos = listaComprasVacia(fechaHoyISO);
  }
  return datos;
}

function saveListaCompras(datos) {
  fs.writeFileSync(LISTA_COMPRAS_PATH, JSON.stringify(datos, null, 2), "utf8");
}

// A qué rol de compras corresponde un teléfono dado (cocina / barra / salon=cajera), o null.
function rolDeComprasSegunTelefono(config, telefono) {
  const staff = config.staff || {};
  const tel = soloDigitos(telefono);
  if (staff.cocina && soloDigitos(staff.cocina.telefono) === tel) return "cocina";
  if (staff.barra && soloDigitos(staff.barra.telefono) === tel) return "barra";
  if (staff.cajera && soloDigitos(staff.cajera.telefono) === tel) return "salon";
  return null;
}

// Arma el texto del mensaje con la lista de compras pendiente (lo que todavía no se compró).
function construirMensajeListaCompras(items, rolesFaltantes) {
  const pendientes = items.filter((i) => !i.comprado);
  if (pendientes.length === 0 && rolesFaltantes.length === 0) {
    return "🛒 No queda nada pendiente en la lista de compras — ¡ya está todo comprado! 🎉";
  }
  const porCategoria = {};
  pendientes.forEach((item) => {
    const cat = item.categoria || "Otros";
    if (!porCategoria[cat]) porCategoria[cat] = [];
    porCategoria[cat].push(item.texto);
  });

  let mensaje = "🛒 *Lista de compras pendiente*\n";
  Object.keys(porCategoria).forEach((cat) => {
    mensaje += `\n*${cat}*\n`;
    porCategoria[cat].forEach((texto) => {
      mensaje += `· ${texto}\n`;
    });
  });

  const NOMBRES_ROL = { cocina: "Cocina", barra: "Barra", salon: "Salón" };
  if (rolesFaltantes.length > 0) {
    mensaje += `\n⚠️ Todavía no llegó el pedido de: ${rolesFaltantes.map((r) => NOMBRES_ROL[r]).join(", ")}. Les mandé un mensaje pidiéndoselo.`;
  }
  return mensaje;
}

// Llamada aparte a Claude (no es parte de la charla con el dueño) para organizar los
// pedidos sueltos de cocina/barra/salón en una sola lista, por categoría de comercio.
const LISTA_COMPRAS_SYSTEM_PROMPT = `Sos un asistente que organiza listas de compras para un restaurante bar mexicano en Formosa, Argentina. Te paso los pedidos de compra que mandaron por separado el encargado de cocina, el de barra y la encargada de salón para el día siguiente. Tu trabajo es unificarlos en una sola lista organizada por categoría de comercio (por ejemplo: Verdulería, Fiambres, Super, Carnicería, Bebidas, Otros — usá las categorías que correspondan según los productos reales, no inventes categorías vacías).

Reglas importantes:
- NUNCA inventes ni agregues productos que no estén en los pedidos originales.
- Si el mismo producto aparece en más de un pedido, sumalos en una sola línea con la cantidad total si podés calcularla con certeza; si no está claro cómo sumarlos, dejalos como líneas separadas.
- Mantené las cantidades y unidades tal como las escribieron, no las inventes ni las cambies.

Respondé ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown, sin \`\`\`), con esta forma exacta:
{"items": [{"texto": "1 bolsa de papa", "categoria": "Verdulería"}, {"texto": "cheddar feta", "categoria": "Fiambres"}]}`;

async function consolidarListaCompras(envios) {
  const partes = [];
  if (envios.cocina.recibido) partes.push(`Pedido de COCINA:\n${envios.cocina.textoOriginal}`);
  if (envios.barra.recibido) partes.push(`Pedido de BARRA:\n${envios.barra.textoOriginal}`);
  if (envios.salon.recibido) partes.push(`Pedido de SALÓN:\n${envios.salon.textoOriginal}`);
  if (partes.length === 0) return [];

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        system: LISTA_COMPRAS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: partes.join("\n\n") }],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Error de la API de Claude al consolidar lista de compras:", data);
      return [];
    }
    const textoRespuesta = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim()
      .replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(textoRespuesta);
    return (parsed.items || []).map((item) => ({
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      texto: item.texto,
      categoria: item.categoria || "Otros",
      comprado: false,
    }));
  } catch (err) {
    console.error("Error consolidando lista de compras:", err);
    return [];
  }
}

// ---- Perfiles de clientes (nombre, cumpleaños, historial de pedidos) ----
const CLIENTES_PATH = path.join(DATA_DIR, "clientes.json");
function loadClientes() {
  try {
    return JSON.parse(fs.readFileSync(CLIENTES_PATH, "utf8"));
  } catch {
    return [];
  }
}
function saveClientes(lista) {
  fs.writeFileSync(CLIENTES_PATH, JSON.stringify(lista, null, 2), "utf8");
}
function buscarCliente(lista, telefono) {
  return lista.find((c) => soloDigitos(c.telefono) === soloDigitos(telefono));
}

// ---- Inbox: historial de conversaciones persistente + modo manual por chat
//      (para poder responder vos mismo desde /admin/inbox, sin depender de
//      la app de WhatsApp Business en el celular) ----
const INBOX_PATH = path.join(DATA_DIR, "inbox.json");
function loadInbox() {
  try {
    return JSON.parse(fs.readFileSync(INBOX_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveInbox(inbox) {
  fs.writeFileSync(INBOX_PATH, JSON.stringify(inbox, null, 2), "utf8");
}
function agregarMensajeInbox(telefono, rol, texto, nombre) {
  const inbox = loadInbox();
  const tel = soloDigitos(telefono);
  if (!inbox[tel]) {
    inbox[tel] = { telefono: tel, nombre: nombre || "", modoManual: false, ultimaActividad: new Date().toISOString(), mensajes: [] };
  }
  if (nombre) inbox[tel].nombre = nombre;
  inbox[tel].mensajes.push({ rol, texto, fecha: new Date().toISOString() });
  if (inbox[tel].mensajes.length > 100) inbox[tel].mensajes = inbox[tel].mensajes.slice(-100);
  inbox[tel].ultimaActividad = new Date().toISOString();
  saveInbox(inbox);
  return inbox[tel];
}
function chatEnModoManual(telefono) {
  const inbox = loadInbox();
  const chat = inbox[soloDigitos(telefono)];
  return !!(chat && chat.modoManual);
}

// ---- Postulantes / CVs ----
const PUESTOS_DISPONIBLES = ["mozo", "cajero", "barman", "cocinero", "ayudante de cocina", "bachero"];
const CVS_DIR = path.join(DATA_DIR, "cvs");
if (!fs.existsSync(CVS_DIR)) fs.mkdirSync(CVS_DIR, { recursive: true });
const POSTULANTES_PATH = path.join(DATA_DIR, "postulantes.json");
function loadPostulantes() {
  try {
    return JSON.parse(fs.readFileSync(POSTULANTES_PATH, "utf8"));
  } catch {
    return [];
  }
}
function savePostulantes(lista) {
  fs.writeFileSync(POSTULANTES_PATH, JSON.stringify(lista, null, 2), "utf8");
}
// Busca un postulante que ya haya dado nombre+puesto pero todavía no mandó el CV.
function buscarPostulantePendiente(lista, telefono) {
  return lista.find((p) => soloDigitos(p.telefono) === soloDigitos(telefono) && p.estado === "esperando_cv");
}
// Saca la marca interna [[POSTULANTE_DATOS: {...}]] y devuelve el texto limpio + los datos
function extractPostulanteDatosMarker(text) {
  const regex = /\[\[POSTULANTE_DATOS:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, datosPostulante: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    return { cleanText, datosPostulante: JSON.parse(match[1]) };
  } catch {
    console.error("No se pudo parsear POSTULANTE_DATOS:", match[1]);
    return { cleanText, datosPostulante: null };
  }
}
function esCumpleañosHoy(cumpleanosDDMM, fechaHoyISO) {
  if (!cumpleanosDDMM || !fechaHoyISO) return false;
  const hoyDDMM = fechaHoyISO.slice(5); // "YYYY-MM-DD" -> "MM-DD"
  const [dia, mes] = cumpleanosDDMM.split("-");
  if (!dia || !mes) return false;
  const normalizado = `${mes.padStart(2, "0")}-${dia.padStart(2, "0")}`;
  return normalizado === hoyDDMM;
}

// Devuelve la fecha ISO (YYYY-MM-DD) del próximo cumpleaños de una persona
function proximoCumpleISO(cumpleanosDDMM, fechaHoyISO) {
  const [dia, mes] = (cumpleanosDDMM || "").split("-").map(Number);
  if (!dia || !mes || !fechaHoyISO) return null;
  const [anioHoy] = fechaHoyISO.split("-").map(Number);
  const hoy = new Date(`${fechaHoyISO}T00:00:00-03:00`);
  let anio = anioHoy;
  let fechaStr = `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
  if (new Date(`${fechaStr}T00:00:00-03:00`) < hoy) {
    anio += 1;
    fechaStr = `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
  }
  return fechaStr;
}

// Calcula cuántos días faltan para el próximo cumpleaños de una persona (0 = hoy)
function diasHastaProximoCumple(cumpleanosDDMM, fechaHoyISO) {
  const [dia, mes] = (cumpleanosDDMM || "").split("-").map(Number);
  if (!dia || !mes || !fechaHoyISO) return null;
  const [anioHoy] = fechaHoyISO.split("-").map(Number);
  const hoy = new Date(`${fechaHoyISO}T00:00:00-03:00`);
  let proximo = new Date(`${anioHoy}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}T00:00:00-03:00`);
  if (proximo < hoy) {
    proximo = new Date(`${anioHoy + 1}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}T00:00:00-03:00`);
  }
  return Math.round((proximo - hoy) / (1000 * 60 * 60 * 24));
}

// Saca la marca interna [[CLIENTE_DATOS: {...}]] y devuelve el texto limpio + los datos aprendidos
function extractClienteDatosMarker(text) {
  const regex = /\[\[CLIENTE_DATOS:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, datosCliente: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    return { cleanText, datosCliente: JSON.parse(match[1]) };
  } catch {
    console.error("No se pudo parsear CLIENTE_DATOS:", match[1]);
    return { cleanText, datosCliente: null };
  }
}

// ==================== Sistema de diseño compartido del panel admin ====================
// Dashboard oscuro moderno con los colores de marca de Chaparrita como acentos.
// Todas las páginas del panel usan este mismo bloque de estilos como base.
const ADMIN_BASE_CSS = `
  :root {
    --coral: #E8674A;
    --turquesa: #128C7E;
    --ocre: #E0A324;
    --jalapeno: #A93B3B;
    --verde-wa: #25D366;
    --verde-wa-oscuro: #075E54;
    --bg: #F0F2F5;
    --bg-elevado: #FFFFFF;
    --card: #FFFFFF;
    --card-hover: #F5F6F6;
    --borde: #E9EDEF;
    --texto: #111B21;
    --texto-tenue: #667781;
    --exito: #25D366;
    --alerta: #E0A324;
    --peligro: #E8674A;
    --radio: 12px;
    --radio-chico: 8px;
    --sombra: 0 2px 10px -2px rgba(17,27,33,0.12);
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: var(--bg);
    color: var(--texto);
    margin: 0;
    min-height: 100vh;
  }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: #C7CCD1; border-radius: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }

  .contenedor { max-width: 720px; margin: 0 auto; padding: 22px 18px 60px; }
  .contenedor-ancho { max-width: 960px; margin: 0 auto; padding: 22px 18px 60px; }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 22px;
  }
  .marca { display: flex; align-items: center; gap: 10px; }
  .marca .icono {
    width: 38px; height: 38px; border-radius: 11px;
    background: linear-gradient(135deg, var(--verde-wa-oscuro), var(--verde-wa));
    display: flex; align-items: center; justify-content: center; font-size: 19px;
    box-shadow: var(--sombra);
  }
  .marca b { font-size: 16px; letter-spacing: 0.2px; }
  .marca span { display: block; font-size: 11px; color: var(--texto-tenue); }

  a.volver {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--texto-tenue); text-decoration: none; font-size: 13px;
    padding: 7px 12px; border-radius: 20px; border: 1px solid var(--borde);
    background: var(--bg-elevado); transition: all .15s ease;
  }
  a.volver:hover { color: var(--texto); border-color: var(--turquesa); }

  h1 { font-size: 21px; margin: 4px 0 4px; letter-spacing: -0.2px; }
  h2 { font-size: 14px; color: var(--coral); text-transform: uppercase; letter-spacing: 0.6px; margin-top: 30px; margin-bottom: 10px; border-bottom: 1px solid var(--borde); padding-bottom: 8px; font-weight: 700; }
  p.sub { color: var(--texto-tenue); font-size: 13px; line-height: 1.5; margin-top: 2px; }

  .tile-grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 18px; }
  a.tile {
    display: flex; align-items: flex-start; gap: 14px;
    padding: 16px; border-radius: var(--radio);
    background: var(--card); border: 1px solid var(--borde);
    text-decoration: none; color: var(--texto);
    transition: all .18s ease; position: relative; overflow: hidden;
  }
  a.tile::before {
    content: ""; position: absolute; inset: 0; opacity: 0; transition: opacity .18s ease;
    background: linear-gradient(135deg, rgba(232,103,74,0.08), rgba(47,156,149,0.08));
  }
  a.tile:hover { border-color: var(--turquesa); transform: translateY(-1px); box-shadow: var(--sombra); }
  a.tile:hover::before { opacity: 1; }
  a.tile .tile-icono {
    width: 42px; height: 42px; border-radius: 12px; flex-shrink: 0;
    background: var(--bg-elevado); display: flex; align-items: center; justify-content: center;
    font-size: 20px; border: 1px solid var(--borde); z-index: 1;
  }
  a.tile .tile-texto { z-index: 1; }
  a.tile b { display: block; color: var(--texto); font-size: 14.5px; margin-bottom: 3px; }
  a.tile .tile-desc { font-size: 12.5px; color: var(--texto-tenue); line-height: 1.4; }

  .card { background: var(--card); border: 1px solid var(--borde); border-radius: var(--radio); padding: 16px; margin-top: 12px; }
  .row { display: flex; gap: 10px; } .row > * { flex: 1; }

  label { font-weight: 600; font-size: 12px; display: block; margin-top: 12px; color: var(--texto-tenue); text-transform: uppercase; letter-spacing: 0.3px; }
  input[type=text], input[type=number], input[type=password], input[type=file], textarea, select {
    font-size: 14px; padding: 10px 12px; width: 100%; box-sizing: border-box; margin-top: 5px;
    border: 1px solid var(--borde); border-radius: var(--radio-chico);
    background: var(--bg-elevado); color: var(--texto); outline: none; transition: border-color .15s ease;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--turquesa); }
  textarea { min-height: 64px; font-family: inherit; }

  button { font-family: inherit; font-size: 13.5px; padding: 10px 16px; border: none; border-radius: var(--radio-chico); cursor: pointer; margin-top: 10px; font-weight: 600; transition: all .15s ease; }
  .btn-primary { background: linear-gradient(135deg, var(--verde-wa-oscuro), var(--verde-wa)); color: #fff; box-shadow: 0 6px 16px -6px rgba(37,211,102,0.45); }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn-secondary { background: var(--bg-elevado); color: var(--texto); border: 1px solid var(--borde); }
  .btn-secondary:hover { border-color: var(--turquesa); }
  .btn-danger { background: transparent; color: var(--coral); padding: 5px 9px; margin: 0; border: 1px solid transparent; }
  .btn-danger:hover { background: rgba(232,103,74,0.1); }
  button:disabled { opacity: 0.5; cursor: default; }

  .badge { display: inline-block; border-radius: 20px; padding: 3px 11px; font-size: 11.5px; font-weight: 700; }
  .badge-alto, .badge-on { background: rgba(63,203,140,0.15); color: var(--exito); }
  .badge-medio { background: rgba(224,163,36,0.15); color: var(--alerta); }
  .badge-bajo, .badge-off { background: rgba(232,103,74,0.15); color: var(--peligro); }
  .badge-pendiente { background: var(--bg-elevado); color: var(--texto-tenue); border: 1px solid var(--borde); }

  #msg { margin-top: 14px; font-weight: 600; font-size: 13.5px; color: var(--texto-tenue); }
  .msg-ok { color: var(--exito) !important; }
  .msg-error { color: var(--coral) !important; }

  .tag { display: inline-flex; align-items: center; gap: 6px; background: var(--bg-elevado); border: 1px solid var(--borde); border-radius: 16px; padding: 4px 10px; margin: 4px 6px 0 0; font-size: 13px; }

  .toggle-switch { position: relative; display: inline-block; width: 50px; height: 28px; flex-shrink: 0; }
  .toggle-switch input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; cursor: pointer; inset: 0; background: var(--borde); border-radius: 28px; transition: .2s; }
  .toggle-slider::before { content: ""; position: absolute; height: 22px; width: 22px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: .2s; }
  .toggle-switch input:checked + .toggle-slider { background: linear-gradient(135deg, var(--turquesa), var(--exito)); }
  .toggle-switch input:checked + .toggle-slider::before { transform: translateX(22px); }

  .empty-state { text-align: center; padding: 40px 20px; color: var(--texto-tenue); font-size: 13.5px; }
  .empty-state .icono { font-size: 32px; margin-bottom: 10px; opacity: 0.6; }

  a.logout { display: inline-flex; align-items: center; gap: 5px; color: var(--texto-tenue); text-decoration: none; font-size: 12.5px; }
  a.logout:hover { color: var(--coral); }
`;

const ADMIN_CONFIG_PAGE = [

  '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
  '<title>Chaparrita - Editar configuracion</title>',
  `<style>${ADMIN_BASE_CSS}
    .contenedor-config { max-width: 640px; margin: 0 auto; padding: 22px 18px 60px; }
    #formArea { display: none; }
  </style>`,
  '</head><body>',
  '<div class="contenedor-config">',
  '<a class="volver" href="/admin">← Volver al panel</a>',
  '<h1>Editar precios, horarios, promos y teléfonos</h1>',
  '<button class="btn-secondary" id="btnReset">Restaurar valores del repositorio (GitHub)</button>',
  '<p class="sub">Usalo solo si los cambios que hacés acá no se guardan al reiniciar el servidor. Pisa TODO lo que hayas cambiado en este panel con lo que esté subido en GitHub.</p>',
  '<div id="msg">Cargando...</div>',
  '<div id="formArea"></div>',
  '<script>',
  'var cfg = null;',
  'var DIAS = ["Lunes","Martes","Miercoles","Jueves","Viernes","Sabado","Domingo"];',
  'var DIAS_KEY = ["Lunes","Martes","Mi\u00e9rcoles","Jueves","Viernes","S\u00e1bado","Domingo"];',
  'function el(tag, attrs, kids) {',
  '  var e = document.createElement(tag);',
  '  if (attrs) { for (var k in attrs) { if (k === "text") { e.textContent = attrs[k]; } else if (k === "html") { e.innerHTML = attrs[k]; } else { e.setAttribute(k, attrs[k]); } } }',
  '  if (kids) { kids.forEach(function(kd){ if (typeof kd === "string") { e.appendChild(document.createTextNode(kd)); } else if (kd) { e.appendChild(kd); } }); }',
  '  return e;',
  '}',
  'function field(labelText, inputEl) { return el("div", {}, [el("label", {text: labelText}), inputEl]); }',
  'function textInput(value) { var i = el("input", {type:"text"}); i.value = value || ""; return i; }',
  'function numInput(value) { var i = el("input", {type:"number"}); i.value = value != null ? value : 0; return i; }',
  'function taInput(value) { var i = el("textarea"); i.value = value || ""; return i; }',
  '',
  'function cargarConfig() {',
  '  fetch("/admin/config-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
  '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
  '    .then(function(data){ cfg = data; renderForm(); document.getElementById("formArea").style.display="block"; document.getElementById("msg").textContent=""; })',
  '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; } });',
  '}',
  'cargarConfig();',
  'document.getElementById("btnReset").addEventListener("click", function() {',
  '  if (!confirm("Esto va a pisar TODO lo que hayas cargado en el panel con lo que esta subido en GitHub ahora mismo. Seguro?")) return;',
  '  fetch("/admin/config-reset-from-repo", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
  '    .then(function(r){ if (!r.ok) { throw new Error("No se pudo restaurar"); } return r.json(); })',
  '    .then(function(data){ cfg = data.config; renderForm(); document.getElementById("formArea").style.display="block"; document.getElementById("msg").textContent = "Listo, se restauro desde el repositorio."; document.getElementById("msg").className = "msg-ok"; })',
  '    .catch(function(e){ document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; });',
  '});',
  '',
  'function renderForm() {',
  '  var area = document.getElementById("formArea");',
  '  area.innerHTML = "";',
  '',
  '  area.appendChild(el("h2", {text:"Horarios y tienda online"}));',
  '  var horariosInput = taInput(cfg.horarios);',
  '  area.appendChild(field("Horarios de atencion", horariosInput));',
  '  var tiendaInput = textInput(cfg.tiendaOnlineUrl);',
  '  area.appendChild(field("Link tienda online", tiendaInput));',
  '',
  '  area.appendChild(el("h2", {text:"Amenities por sector"}));',
  '  var amAdentro = textInput(cfg.amenities.adentro);',
  '  var amPatio = textInput(cfg.amenities.patio);',
  '  var amVereda = textInput(cfg.amenities.vereda);',
  '  area.appendChild(field("Adentro", amAdentro));',
  '  area.appendChild(field("Patio interno", amPatio));',
  '  area.appendChild(field("Vereda", amVereda));',
  '',
  '  area.appendChild(el("h2", {text:"Mesas por sector y disponibilidad"}));',
  '  area.appendChild(el("p", {text:"El agente calcula solo cu\u00e1ntas mesas quedan libres para cada horario, sin que nadie tenga que marcarlo a mano.", style:"font-size:12px;color:var(--texto-tenue);margin:2px 0 8px 0;"}));',
  '  var mesasCfg = cfg.mesasPorSector || {adentro:0, patio:0, vereda:0};',
  '  var mesasAdentro = numInput(mesasCfg.adentro);',
  '  var mesasPatio = numInput(mesasCfg.patio);',
  '  var mesasVereda = numInput(mesasCfg.vereda);',
  '  area.appendChild(el("div", {class:"row"}, [field("Mesas adentro", mesasAdentro), field("Mesas patio", mesasPatio), field("Mesas vereda", mesasVereda)]));',
  '  var duracionMesaInput = numInput(cfg.duracionMesaMinutos || 90);',
  '  area.appendChild(field("Duraci\u00f3n promedio de una mesa ocupada (minutos)", duracionMesaInput));',
  '',
  '  area.appendChild(el("h2", {text:"Productos agotados hoy"}));',
  '  var agotadosBox = el("div", {id:"agotadosBox"});',
  '  var agotadosList = cfg.agotados.slice();',
  '  function pintarAgotados() {',
  '    agotadosBox.innerHTML = "";',
  '    agotadosList.forEach(function(item, idx) {',
  '      var btn = el("button", {type:"button", text:"x", class:"btn-danger"});',
  '      btn.addEventListener("click", function(){ agotadosList.splice(idx,1); pintarAgotados(); });',
  '      agotadosBox.appendChild(el("span", {class:"tag"}, [item, btn]));',
  '    });',
  '  }',
  '  pintarAgotados();',
  '  area.appendChild(agotadosBox);',
  '  var nuevoAgotadoInput = textInput("");',
  '  var btnAddAgotado = el("button", {type:"button", text:"+ Agregar", class:"btn-secondary"});',
  '  btnAddAgotado.addEventListener("click", function(){ if (nuevoAgotadoInput.value.trim()) { agotadosList.push(nuevoAgotadoInput.value.trim()); nuevoAgotadoInput.value=""; pintarAgotados(); } });',
  '  area.appendChild(el("div", {class:"row"}, [nuevoAgotadoInput, btnAddAgotado]));',
  '',
  '  area.appendChild(el("h2", {text:"Cumpleanos - promos todo incluido"}));',
  '  var minPersonasInput = numInput(cfg["cumplea\u00f1os"].minPersonas);',
  '  area.appendChild(field("Minimo de personas para la promo", minPersonasInput));',
  '  var paquetesBox = el("div", {id:"paquetesBox"});',
  '  var paquetesList = JSON.parse(JSON.stringify(cfg["cumplea\u00f1os"].paquetes));',
  '  function pintarPaquetes() {',
  '    paquetesBox.innerHTML = "";',
  '    paquetesList.forEach(function(p, idx) {',
  '      var nombreI = textInput(p.nombre); nombreI.oninput = function(){ p.nombre = nombreI.value; };',
  '      var emojiI = textInput(p.emoji); emojiI.oninput = function(){ p.emoji = emojiI.value; };',
  '      var precioI = numInput(p.precioPersona); precioI.oninput = function(){ p.precioPersona = Number(precioI.value); };',
  '      var descI = taInput(p.descripcion); descI.oninput = function(){ p.descripcion = descI.value; };',
  '      var btnDel = el("button", {type:"button", text:"Eliminar promo", class:"btn-danger"});',
  '      btnDel.addEventListener("click", function(){ paquetesList.splice(idx,1); pintarPaquetes(); });',
  '      var card = el("div", {class:"card"}, [',
  '        el("div", {class:"row"}, [field("Emoji", emojiI), field("Nombre", nombreI), field("Precio por persona", precioI)]),',
  '        field("Descripcion detallada (opcional)", descI),',
  '        btnDel',
  '      ]);',
  '      paquetesBox.appendChild(card);',
  '    });',
  '  }',
  '  pintarPaquetes();',
  '  area.appendChild(paquetesBox);',
  '  var btnAddPaquete = el("button", {type:"button", text:"+ Agregar promo", class:"btn-secondary"});',
  '  btnAddPaquete.addEventListener("click", function(){ paquetesList.push({nombre:"Nueva promo", emoji:"\ud83c\udf89", precioPersona:15000, descripcion:""}); pintarPaquetes(); });',
  '  area.appendChild(btnAddPaquete);',
  '',
  '  area.appendChild(el("h2", {text:"Precios base para presupuesto a medida (menos del minimo)"}));',
  '  var bp = cfg["cumplea\u00f1os"].basePrecios;',
  '  var bpPizza = numInput(bp.pizza), bpTacos = numInput(bp.tacos), bpHamb = numInput(bp.hamburguesas), bpLomi = numInput(bp.lomitos), bpBebida = numInput(bp.bebida), bpShot = numInput(bp.shot), bpTorta = numInput(bp.torta);',
  '  area.appendChild(el("div", {class:"row"}, [field("Pizza (cada 2 personas)", bpPizza), field("Tacos (por persona)", bpTacos)]));',
  '  area.appendChild(el("div", {class:"row"}, [field("Hamburguesas (por persona)", bpHamb), field("Lomitos (por persona)", bpLomi)]));',
  '  area.appendChild(el("div", {class:"row"}, [field("Bebida (cada 2 personas)", bpBebida), field("Shot brindis (por persona)", bpShot)]));',
  '  area.appendChild(field("Torta Grido (fija)", bpTorta));',
  '',
  '  var descuentoInput = numInput(Math.round(cfg["cumplea\u00f1os"].descuentoPresupuestoAMedida * 100));',
  '  var senaInput = numInput(Math.round(cfg["cumplea\u00f1os"].se\u00f1aPorcentaje * 100));',
  '  area.appendChild(el("div", {class:"row"}, [field("Descuento presupuesto a medida (%)", descuentoInput), field("Sena requerida (%)", senaInput)]));',
  '',
  '  area.appendChild(el("h2", {text:"Cuenta para la sena"}));',
  '  var ct = cfg["cumplea\u00f1os"].cuenta;',
  '  var ctTitular = textInput(ct.titular), ctCuit = textInput(ct.cuit), ctCvu = textInput(ct.cvu), ctAlias = textInput(ct.alias);',
  '  area.appendChild(field("Titular", ctTitular));',
  '  area.appendChild(el("div", {class:"row"}, [field("CUIT/CUIL", ctCuit), field("Alias", ctAlias)]));',
  '  area.appendChild(field("CVU", ctCvu));',
  '',
  '  area.appendChild(el("h2", {text:"Equipo (telefonos internos, nunca se muestran al cliente)"}));',
  '  var stf = cfg.staff;',
  '  var cajNombre = textInput(stf.cajera.nombre), cajTel = textInput(stf.cajera.telefono);',
  '  var duenoNombre = textInput(stf.due\u00f1o.nombre), duenoTel = textInput(stf.due\u00f1o.telefono);',
  '  var cocinaObj = stf.cocina || {nombre:"", telefono:""};',
  '  var cocinaNombre = textInput(cocinaObj.nombre), cocinaTel = textInput(cocinaObj.telefono);',
  '  var barraObj = stf.barra || {nombre:"", telefono:""};',
  '  var barraNombre = textInput(barraObj.nombre), barraTel = textInput(barraObj.telefono);',
  '  area.appendChild(el("div", {class:"row"}, [field("Nombre cajera/o (tambi\u00e9n encargada de sal\u00f3n)", cajNombre), field("Telefono (con 549...)", cajTel)]));',
  '  area.appendChild(el("div", {class:"row"}, [field("Nombre dueno/a", duenoNombre), field("Telefono (con 549...)", duenoTel)]));',
  '  area.appendChild(el("div", {class:"row"}, [field("Nombre jefe de cocina", cocinaNombre), field("Telefono (con 549...)", cocinaTel)]));',
  '  area.appendChild(el("div", {class:"row"}, [field("Nombre encargado/a de barra", barraNombre), field("Telefono (con 549...)", barraTel)]));',
  '  area.appendChild(el("p", {text:"A cocina se le reenvia automaticamente el resumen apenas se confirma un pedido. Cocina, barra y sal\u00f3n (cajera) son quienes mandan su lista de compras diaria.", style:"font-size:12px;color:var(--texto-tenue);margin:2px 0 0 0;"}));',
  '',
  '  var grupoInput = textInput(cfg.grupoReservasWhatsappId);',
  '  area.appendChild(field("ID de WhatsApp del grupo Reservas Chaparrita", grupoInput));',
  '',
  '  area.appendChild(el("h2", {text:"Oferta proactiva antes del cumpleanos"}));',
  '  area.appendChild(el("p", {text:"Le manda un WhatsApp al cliente antes de su cumple ofreciendole reservar (con los beneficios de abajo) o las promos grupales.", style:"font-size:12px;color:#6b6258;margin:2px 0 8px 0;"}));',
  '  var ofertaCumple = cfg["ofertaCumplea\u00f1osProximo"] || {activo:true, diasAntes:7};',
  '  var ofertaCumpleActivo = el("input", {type:"checkbox"}); ofertaCumpleActivo.checked = ofertaCumple.activo !== false;',
  '  var lblOfertaActivo = el("label", {text:" Activo"}); lblOfertaActivo.style.display="inline"; lblOfertaActivo.style.fontWeight="normal";',
  '  area.appendChild(el("div", {}, [ofertaCumpleActivo, lblOfertaActivo]));',
  '  var ofertaCumpleDias = numInput(ofertaCumple.diasAntes);',
  '  area.appendChild(field("Dias de anticipacion", ofertaCumpleDias));',
  '',
  '  area.appendChild(el("h2", {text:"Cumpleanos de clientes (mimo personal)"}));',
  '  area.appendChild(el("p", {text:"Cuando un cliente conocido escribe el dia de su cumple.", style:"font-size:12px;color:#6b6258;margin:2px 0 8px 0;"}));',
  '  var cumpleCli = cfg["cumplea\u00f1osCliente"] || {activo:true, descuentoPorcentaje:10, shotsTequilaSiFestejaEnLocal:true};',
  '  var cumpleCliActivo = el("input", {type:"checkbox"}); cumpleCliActivo.checked = cumpleCli.activo !== false;',
  '  var lblCumpleCliActivo = el("label", {text:" Activo"}); lblCumpleCliActivo.style.display="inline"; lblCumpleCliActivo.style.fontWeight="normal";',
  '  area.appendChild(el("div", {}, [cumpleCliActivo, lblCumpleCliActivo]));',
  '  var cumpleCliDesc = numInput(cumpleCli.descuentoPorcentaje);',
  '  var cumpleCliShots = el("input", {type:"checkbox"}); cumpleCliShots.checked = cumpleCli.shotsTequilaSiFestejaEnLocal !== false;',
  '  var lblCumpleCliShots = el("label", {text:" Incluir ronda de shots de tequila si vienen a festejar al local"}); lblCumpleCliShots.style.display="inline"; lblCumpleCliShots.style.fontWeight="normal";',
  '  area.appendChild(field("Descuento (%)", cumpleCliDesc));',
  '  area.appendChild(el("div", {style:"margin-top:6px;"}, [cumpleCliShots, lblCumpleCliShots]));',
  '',
  '  area.appendChild(el("h2", {text:"Aviso diario de cumpleanos"}));',
  '  area.appendChild(el("p", {text:"Te avisa por WhatsApp quien cumple hoy y quien cumple en los proximos 7 dias. Si dejas el telefono vacio, se le manda al dueno.", style:"font-size:12px;color:#6b6258;margin:2px 0 8px 0;"}));',
  '  var avisoCumple = cfg.avisoCumpleañosDiario || {activo:true, telefono:"", hora:"09:00"};',
  '  var avisoCumpleActivo = el("input", {type:"checkbox"}); avisoCumpleActivo.checked = avisoCumple.activo !== false;',
  '  var lblAvisoActivo = el("label", {text:" Activo"}); lblAvisoActivo.style.display="inline"; lblAvisoActivo.style.fontWeight="normal";',
  '  area.appendChild(el("div", {}, [avisoCumpleActivo, lblAvisoActivo]));',
  '  var avisoCumpleTel = textInput(avisoCumple.telefono);',
  '  var avisoCumpleHora = textInput(avisoCumple.hora || "09:00");',
  '  area.appendChild(el("div", {class:"row"}, [field("Telefono que recibe el aviso (vacio = dueno)", avisoCumpleTel), field("Hora del aviso (HH:MM)", avisoCumpleHora)]));',
  '',
  '  area.appendChild(el("h2", {text:"Tacos libres para todo el publico"}));',
  '  area.appendChild(el("p", {text:"Dias abiertos a cualquier cliente (sin minimo de personas), distinto de la promo de cumpleanos.", style:"font-size:12px;color:#6b6258;margin:2px 0 8px 0;"}));',
  '  var tlp = cfg.tacosLibresPublico || {dias:[], precioPersona:0};',
  '  var tlpDiasBox = el("div", {class:"row"});',
  '  var tlpDiasChecks = {};',
  '  DIAS_KEY.forEach(function(diaKey) {',
  '    var chk = el("input", {type:"checkbox"});',
  '    chk.checked = tlp.dias.indexOf(diaKey) !== -1;',
  '    tlpDiasChecks[diaKey] = chk;',
  '    var lbl = el("label", {text:" " + diaKey});',
  '    lbl.style.display = "inline"; lbl.style.fontWeight = "normal"; lbl.style.marginRight = "10px";',
  '    var wrap = el("span", {style:"display:inline-flex;align-items:center;margin:4px 10px 4px 0;"}, [chk, lbl]);',
  '    tlpDiasBox.appendChild(wrap);',
  '  });',
  '  area.appendChild(field("Dias con tacos libres", tlpDiasBox));',
  '  var tlpPrecioInput = numInput(tlp.precioPersona);',
  '  area.appendChild(field("Precio por persona", tlpPrecioInput));',
  '',
  '  area.appendChild(el("h2", {text:"Delivery - cadetes"}));',
  '  area.appendChild(el("p", {text:"Cargá el telefono con codigo de pais y 9 (ej: 549370XXXXXXX). Solo se le consulta el envio a los que esten Activos.", style:"font-size:12px;color:#6b6258;margin:2px 0 8px 0;"}));',
  '  var cadetesBox = el("div", {id:"cadetesBox"});',
  '  var cadetesList = JSON.parse(JSON.stringify(cfg.deliveryConfig || []));',
  '  function pintarCadetes() {',
  '    cadetesBox.innerHTML = "";',
  '    cadetesList.forEach(function(c, idx) {',
  '      var nombreI = textInput(c.nombre); nombreI.oninput = function(){ c.nombre = nombreI.value; };',
  '      var telI = textInput(c.telefono); telI.oninput = function(){ c.telefono = telI.value; };',
  '      var activoI = el("input", {type:"checkbox"}); activoI.checked = !!c.activo; activoI.onchange = function(){ c.activo = activoI.checked; };',
  '      var lblActivo = el("label", {text:" Activo (se le consulta el envio)"});',
  '      lblActivo.style.display = "inline"; lblActivo.style.fontWeight = "normal";',
  '      var btnDel = el("button", {type:"button", text:"Eliminar cadete", class:"btn-danger"});',
  '      btnDel.addEventListener("click", function(){ cadetesList.splice(idx,1); pintarCadetes(); });',
  '      var wrapChk = el("div", {}, [activoI, lblActivo]);',
  '      var card = el("div", {class:"card"}, [',
  '        el("div", {class:"row"}, [field("Nombre", nombreI), field("Telefono", telI)]),',
  '        wrapChk, btnDel',
  '      ]);',
  '      cadetesBox.appendChild(card);',
  '    });',
  '  }',
  '  pintarCadetes();',
  '  area.appendChild(cadetesBox);',
  '  var btnAddCadete = el("button", {type:"button", text:"+ Agregar cadete", class:"btn-secondary"});',
  '  btnAddCadete.addEventListener("click", function(){ cadetesList.push({nombre:"Nuevo cadete", telefono:"", activo:true}); pintarCadetes(); });',
  '  area.appendChild(btnAddCadete);',
  '',
  '  area.appendChild(el("h2", {text:"Aviso de reservas al staff"}));',
  '  area.appendChild(el("p", {text:"La API de WhatsApp no permite mandar mensajes a grupos, asi que cuando se confirma una reserva se le avisa individualmente a cada persona activa de esta lista (ademas del grupo viejo, si sigue cargado). Cargá el telefono con codigo de pais y 9 (ej: 549370XXXXXXX).", style:"font-size:12px;color:var(--texto-tenue);margin:2px 0 8px 0;"}));',
  '  var avisosBox = el("div", {id:"avisosBox"});',
  '  var avisosList = JSON.parse(JSON.stringify(cfg.avisosReservas || []));',
  '  function pintarAvisos() {',
  '    avisosBox.innerHTML = "";',
  '    avisosList.forEach(function(a, idx) {',
  '      var nombreI = textInput(a.nombre); nombreI.oninput = function(){ a.nombre = nombreI.value; };',
  '      var telI = textInput(a.telefono); telI.oninput = function(){ a.telefono = telI.value; };',
  '      var activoI = el("input", {type:"checkbox"}); activoI.checked = !!a.activo; activoI.onchange = function(){ a.activo = activoI.checked; };',
  '      var lblActivo = el("label", {text:" Activo (recibe el aviso de reservas)"});',
  '      lblActivo.style.display = "inline"; lblActivo.style.fontWeight = "normal";',
  '      var btnDel = el("button", {type:"button", text:"Eliminar", class:"btn-danger"});',
  '      btnDel.addEventListener("click", function(){ avisosList.splice(idx,1); pintarAvisos(); });',
  '      var wrapChk = el("div", {}, [activoI, lblActivo]);',
  '      var card = el("div", {class:"card"}, [',
  '        el("div", {class:"row"}, [field("Nombre", nombreI), field("Telefono", telI)]),',
  '        wrapChk, btnDel',
  '      ]);',
  '      avisosBox.appendChild(card);',
  '    });',
  '  }',
  '  pintarAvisos();',
  '  area.appendChild(avisosBox);',
  '  var btnAddAviso = el("button", {type:"button", text:"+ Agregar persona", class:"btn-secondary"});',
  '  btnAddAviso.addEventListener("click", function(){ avisosList.push({nombre:"Nueva persona", telefono:"", activo:true}); pintarAvisos(); });',
  '  area.appendChild(btnAddAviso);',
  '',
  '  area.appendChild(el("h2", {text:"Promociones por dia de la semana"}));',
  '  var promosDiaData = JSON.parse(JSON.stringify(cfg.promosDia));',
  '  var promosDiaBox = el("div", {id:"promosDiaBox"});',
  '  function pintarDia(diaKey, box) {',
  '    box.innerHTML = "";',
  '    var lista = promosDiaData[diaKey];',
  '    lista.forEach(function(p, idx) {',
  '      var tituloI = textInput(p.titulo); tituloI.oninput = function(){ p.titulo = tituloI.value; };',
  '      var descI = textInput(p.desc); descI.oninput = function(){ p.desc = descI.value; };',
  '      var activaI = el("input", {type:"checkbox"}); activaI.checked = !!p.activa; activaI.onchange = function(){ p.activa = activaI.checked; };',
  '      var lblActiva = el("label", {text:" Activa"});',
  '      lblActiva.style.display = "inline"; lblActiva.style.fontWeight = "normal";',
  '      var btnDel = el("button", {type:"button", text:"Eliminar", class:"btn-danger"});',
  '      btnDel.addEventListener("click", function(){ lista.splice(idx,1); pintarDia(diaKey, box); });',
  '      var wrapChk = el("div", {}, [activaI, lblActiva]);',
  '      var card = el("div", {class:"card"}, [',
  '        field("Titulo de la promo", tituloI),',
  '        field("Descripcion", descI),',
  '        wrapChk, btnDel',
  '      ]);',
  '      box.appendChild(card);',
  '    });',
  '    var btnAdd = el("button", {type:"button", text:"+ Agregar promo " + diaKey, class:"btn-secondary"});',
  '    btnAdd.addEventListener("click", function(){ lista.push({titulo:"Nueva promo", desc:"", activa:true}); pintarDia(diaKey, box); });',
  '    box.appendChild(btnAdd);',
  '  }',
  '  DIAS_KEY.forEach(function(diaKey) {',
  '    var diaBox = el("div", {class:"card"});',
  '    diaBox.appendChild(el("div", {text: diaKey, style:"font-weight:bold;margin-bottom:6px;"}));',
  '    var innerBox = el("div");',
  '    diaBox.appendChild(innerBox);',
  '    pintarDia(diaKey, innerBox);',
  '    promosDiaBox.appendChild(diaBox);',
  '  });',
  '  area.appendChild(promosDiaBox);',
  '',
  '  area.appendChild(el("h2", {text:"Base de conocimiento"}));',
  '  area.appendChild(el("p", {text:"Preguntas puntuales que quer\u00e9s que Chaparrita responda siempre de la misma forma (ej: \u00bftienen productos para cel\u00edacos? \u00bfc\u00f3mo es lo de tacos libres, es sin l\u00edmite?). El agente las va a seguir al pie de la letra.", style:"font-size:12px;color:var(--texto-tenue);margin:2px 0 8px 0;"}));',
  '  var conocimientoBox = el("div", {id:"conocimientoBox"});',
  '  var conocimientoList = JSON.parse(JSON.stringify(cfg.baseConocimiento || []));',
  '  function pintarConocimiento() {',
  '    conocimientoBox.innerHTML = "";',
  '    conocimientoList.forEach(function(item, idx) {',
  '      var preguntaI = textInput(item.pregunta); preguntaI.oninput = function(){ item.pregunta = preguntaI.value; };',
  '      var respuestaI = taInput(item.respuesta); respuestaI.oninput = function(){ item.respuesta = respuestaI.value; };',
  '      var btnDel = el("button", {type:"button", text:"Eliminar", class:"btn-danger"});',
  '      btnDel.addEventListener("click", function(){ conocimientoList.splice(idx,1); pintarConocimiento(); });',
  '      var card = el("div", {class:"card"}, [',
  '        field("Pregunta o tema", preguntaI),',
  '        field("Respuesta exacta que debe dar", respuestaI),',
  '        btnDel',
  '      ]);',
  '      conocimientoBox.appendChild(card);',
  '    });',
  '  }',
  '  pintarConocimiento();',
  '  area.appendChild(conocimientoBox);',
  '  var btnAddConocimiento = el("button", {type:"button", text:"+ Agregar pregunta", class:"btn-secondary"});',
  '  btnAddConocimiento.addEventListener("click", function(){ conocimientoList.push({pregunta:"", respuesta:""}); pintarConocimiento(); });',
  '  area.appendChild(btnAddConocimiento);',
  '',
  '  var btnGuardar = el("button", {type:"button", text:"Guardar todos los cambios", class:"btn-primary"});',
  '  btnGuardar.style.marginTop = "24px";',
  '  btnGuardar.style.width = "100%";',
  '  btnGuardar.addEventListener("click", function() {',
  '    var nuevo = JSON.parse(JSON.stringify(cfg));',
  '    nuevo.horarios = horariosInput.value;',
  '    nuevo.tiendaOnlineUrl = tiendaInput.value;',
  '    nuevo.amenities = {adentro: amAdentro.value, patio: amPatio.value, vereda: amVereda.value};',
  '    nuevo.mesasPorSector = {adentro: Number(mesasAdentro.value), patio: Number(mesasPatio.value), vereda: Number(mesasVereda.value)};',
  '    nuevo.duracionMesaMinutos = Number(duracionMesaInput.value);',
  '    nuevo.agotados = agotadosList;',
  '    nuevo["cumplea\u00f1os"].minPersonas = Number(minPersonasInput.value);',
  '    nuevo["cumplea\u00f1os"].paquetes = paquetesList;',
  '    nuevo["cumplea\u00f1os"].basePrecios = {pizza:Number(bpPizza.value), tacos:Number(bpTacos.value), hamburguesas:Number(bpHamb.value), lomitos:Number(bpLomi.value), bebida:Number(bpBebida.value), shot:Number(bpShot.value), torta:Number(bpTorta.value)};',
  '    nuevo["cumplea\u00f1os"].descuentoPresupuestoAMedida = Number(descuentoInput.value) / 100;',
  '    nuevo["cumplea\u00f1os"].se\u00f1aPorcentaje = Number(senaInput.value) / 100;',
  '    nuevo["cumplea\u00f1os"].cuenta = {titular: ctTitular.value, cuit: ctCuit.value, cvu: ctCvu.value, alias: ctAlias.value};',
  '    nuevo.staff = {cajera:{nombre:cajNombre.value, telefono:cajTel.value}, due\u00f1o:{nombre:duenoNombre.value, telefono:duenoTel.value}, cocina:{nombre:cocinaNombre.value, telefono:cocinaTel.value}, barra:{nombre:barraNombre.value, telefono:barraTel.value}};',
  '    nuevo.grupoReservasWhatsappId = grupoInput.value;',
  '    nuevo.deliveryConfig = cadetesList;',
  '    nuevo.avisosReservas = avisosList;',
  '    nuevo.tacosLibresPublico = {dias: DIAS_KEY.filter(function(d){ return tlpDiasChecks[d].checked; }), precioPersona: Number(tlpPrecioInput.value)};',
  '    nuevo["ofertaCumplea\u00f1osProximo"] = {activo: ofertaCumpleActivo.checked, diasAntes: Number(ofertaCumpleDias.value)};',
  '    nuevo["cumplea\u00f1osCliente"] = {activo: cumpleCliActivo.checked, descuentoPorcentaje: Number(cumpleCliDesc.value), shotsTequilaSiFestejaEnLocal: cumpleCliShots.checked};',
  '    nuevo.avisoCumpleañosDiario = {activo: avisoCumpleActivo.checked, telefono: avisoCumpleTel.value, hora: avisoCumpleHora.value};',
  '    nuevo.promosDia = promosDiaData;',
  '    nuevo.baseConocimiento = conocimientoList;',
  '    document.getElementById("msg").textContent = "Guardando...";',
  '    document.getElementById("msg").className = "";',
  '    fetch("/admin/config-save", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({config: nuevo})})',
  '      .then(function(r){ if (!r.ok) { throw new Error("No se pudo guardar"); } return r.json(); })',
  '      .then(function(){ document.getElementById("msg").textContent = "Listo, se guardaron los cambios. El agente ya los usa."; document.getElementById("msg").className = "msg-ok"; window.scrollTo(0,0); })',
  '      .catch(function(e){ document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; });',
  '  });',
  '  area.appendChild(btnGuardar);',
  '}',
  '</' + 'script>',
  '</div>',
  '</body></html>'
].join("\n");

// ---- Memoria de conversación por número (en memoria; para producción real
//      conviene pasar esto a una base de datos, ej. Postgres en Railway) ----
const conversations = new Map(); // phone -> [{role, content}]

// ---- Consultas de envío pendientes: cadetePhone (normalizado) -> {customerPhone, direccion, askedAt} ----
const pendingDeliveryQuotes = new Map();

// ---- Comprobantes de pago pendientes de confirmación: staffPhone (normalizado) -> {customerPhone, askedAt} ----
const pendingComprobantes = new Map();

function soloDigitos(numero) {
  return (numero || "").replace(/[^\d]/g, "");
}

const {
  ANTHROPIC_API_KEY,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  ADMIN_PASSWORD,
  PORT = 3000,
} = process.env;

// ==================== Sesión de administrador (login único, cookie) ====================
// Antes cada página del panel pedía la contraseña por separado. Ahora te logueás una
// vez en /admin/login y esa sesión te sirve para todas las páginas del panel por 12hs.
const crypto = require("crypto");
const ADMIN_SESSIONS = new Map(); // token -> timestamp de expiración (ms)
const ADMIN_SESSION_COOKIE = "chap_admin_sesion";
const ADMIN_SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 horas

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((parte) => {
    const idx = parte.indexOf("=");
    if (idx === -1) return;
    const clave = parte.slice(0, idx).trim();
    const valor = parte.slice(idx + 1).trim();
    cookies[clave] = decodeURIComponent(valor);
  });
  return cookies;
}

function tieneSesionAdminValida(req) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_SESSION_COOKIE];
  if (!token) return false;
  const expira = ADMIN_SESSIONS.get(token);
  if (!expira || expira < Date.now()) {
    ADMIN_SESSIONS.delete(token);
    return false;
  }
  return true;
}

function crearSesionAdmin(res) {
  const token = crypto.randomBytes(24).toString("hex");
  ADMIN_SESSIONS.set(token, Date.now() + ADMIN_SESSION_DURATION_MS);
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(ADMIN_SESSION_DURATION_MS / 1000)}; SameSite=Lax`
  );
}

function cerrarSesionAdmin(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_SESSION_COOKIE];
  if (token) ADMIN_SESSIONS.delete(token);
  res.setHeader("Set-Cookie", `${ADMIN_SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// Middleware para páginas HTML del panel: si no hay sesión, redirige al login.
function requireAdminPage(req, res, next) {
  if (tieneSesionAdminValida(req)) return next();
  return res.redirect("/admin/login");
}

// Middleware para los endpoints de datos (fetch/JSON) del panel: si no hay sesión, 401.
function requireAdminApi(req, res, next) {
  if (tieneSesionAdminValida(req)) return next();
  return res.status(401).json({ error: "Sesión vencida, iniciá sesión de nuevo." });
}

app.get("/admin/login", (_req, res) => {
  res.type("html").send([
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<title>Chaparrita - Ingresar</title>',
    `<style>${ADMIN_BASE_CSS}
      .login-shell { max-width: 380px; margin: 100px auto; text-align: center; padding: 0 20px; }
      .login-icono { width: 64px; height: 64px; border-radius: 18px; margin: 0 auto 18px; background: linear-gradient(135deg, var(--verde-wa-oscuro), var(--verde-wa)); display: flex; align-items: center; justify-content: center; font-size: 30px; box-shadow: var(--sombra); }
      .login-shell input[type=password] { text-align: center; font-size: 16px; padding: 13px; }
      .login-shell button { width: 100%; padding: 13px; font-size: 14.5px; }
    </style>`,
    '</head><body>',
    '<div class="login-shell">',
    '<div class="login-icono">🌮</div>',
    '<h1>Panel de Chaparrita</h1>',
    '<p class="sub">Ingresá la contraseña de administrador una vez, y no te la vuelve a pedir por unas horas.</p>',
    '<input type="password" id="password" placeholder="Contraseña" autofocus />',
    '<button class="btn-primary" id="btnEntrar">Entrar</button>',
    '<div id="msg"></div>',
    '</div>',
    '<script>',
    'function intentarEntrar() {',
    '  var pw = document.getElementById("password").value;',
    '  fetch("/admin/login-check", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password: pw})})',
    '    .then(function(r){ if (!r.ok) { throw new Error("Contraseña incorrecta"); } return r.json(); })',
    '    .then(function(){ window.location.href = "/admin"; })',
    '    .catch(function(e){ document.getElementById("msg").textContent = e.message; document.getElementById("msg").className = "msg-error"; });',
    '}',
    'document.getElementById("btnEntrar").addEventListener("click", intentarEntrar);',
    'document.getElementById("password").addEventListener("keydown", function(e){ if (e.key === "Enter") intentarEntrar(); });',
    '</' + 'script>',
    '</body></html>'
  ].join("\n"));
});

app.post("/admin/login-check", (req, res) => {
  if (!ADMIN_PASSWORD || req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  crearSesionAdmin(res);
  res.json({ ok: true });
});

app.get("/admin/logout", (req, res) => {
  cerrarSesionAdmin(req, res);
  res.redirect("/admin/login");
});

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

    const from = message.from; // número del cliente (o del cadete, si nos está contestando)
    console.log(`Mensaje recibido de ${from}, tipo: ${message.type}`);

    const config = loadConfig();
    if (config.asistenteActivo === false) {
      console.log("El asistente está apagado (asistenteActivo=false) — no se responde, queda para que lo atienda un operador.");
      return;
    }

    // ¿Este mensaje viene de un cadete que tenemos cargado? Si es así, no lo procesamos
    // con Claude — puede ser la respuesta a una consulta de envío pendiente.
    const cadetes = config.deliveryConfig || [];
    const cadeteQueEscribe = cadetes.find((c) => soloDigitos(c.telefono) === soloDigitos(from));
    if (cadeteQueEscribe && message.type === "text") {
      // Lo guardamos en la bandeja de /admin/inbox igual, aunque el cadete no pase por
      // Claude — así queda visible en "Atender manualmente" como cualquier otra conversación.
      agregarMensajeInbox(from, "cliente", message.text.body, cadeteQueEscribe.nombre);

      const pendiente = pendingDeliveryQuotes.get(soloDigitos(cadeteQueEscribe.telefono));
      if (pendiente) {
        pendingDeliveryQuotes.delete(soloDigitos(cadeteQueEscribe.telefono));
        const textoCadete = message.text.body;
        console.log(`Respuesta de cadete ${cadeteQueEscribe.nombre}: "${textoCadete}" — reenviando a ${pendiente.customerPhone}`);
        await sendWhatsappText(
          pendiente.customerPhone,
          `¡Ya volvió nuestro cadete! Nos dice: "${textoCadete}" para el envío a ${pendiente.direccion}. ¿Le damos para adelante con el pedido?`
        );
        const histCliente = conversations.get(pendiente.customerPhone) || [];
        histCliente.push({ role: "assistant", content: [{ type: "text", text: `(El cadete confirmó el costo de envío a ${pendiente.direccion}: "${textoCadete}")` }] });
        conversations.set(pendiente.customerPhone, histCliente);
      } else {
        console.log(`Mensaje de cadete ${cadeteQueEscribe.nombre} sin ninguna consulta pendiente asociada — se ignora (pero queda guardado en /admin/inbox).`);
      }
      return;
    }

    // ¿Este mensaje viene de alguien del staff (cajera/dueño) que tiene un comprobante
    // pendiente de confirmar? Si es así, tratamos su respuesta como la confirmación (o
    // rechazo) del pago, y NO lo procesamos como si fuera un cliente hablándole al bot.
    const staffConfig = config.staff || {};
    const staffQueEscribe = [staffConfig.cajera, staffConfig.dueño]
      .filter(Boolean)
      .find((s) => soloDigitos(s.telefono) === soloDigitos(from));
    if (staffQueEscribe && message.type === "text") {
      const pendienteComprobante = pendingComprobantes.get(soloDigitos(from));
      if (pendienteComprobante) {
        pendingComprobantes.delete(soloDigitos(from));
        const textoStaff = message.text.body;
        agregarMensajeInbox(from, "cliente", textoStaff, staffQueEscribe.nombre);
        console.log(`Respuesta de staff (${staffQueEscribe.nombre}) sobre comprobante: "${textoStaff}" — reenviando a ${pendienteComprobante.customerPhone}`);
        await sendWhatsappText(
          pendienteComprobante.customerPhone,
          `Nuestro equipo revisó tu comprobante y nos dice: "${textoStaff}"`
        );
        const histClienteComprobante = conversations.get(pendienteComprobante.customerPhone) || [];
        histClienteComprobante.push({ role: "assistant", content: [{ type: "text", text: `(El equipo respondió sobre el comprobante de pago: "${textoStaff}")` }] });
        conversations.set(pendienteComprobante.customerPhone, histClienteComprobante);
        return;
      }
      // Si no hay ningún comprobante pendiente, dejamos que el mensaje siga el flujo
      // normal (por si el staff quiere probar el bot o hablar como cualquier cliente).
    }

    // ¿Este mensaje viene de cocina, barra o salón (cajera)? Si es así, y no era sobre un
    // comprobante (ya se manejó arriba), lo tratamos como su pedido de compras del día —
    // no pasa por Claude, se guarda tal cual para consolidarlo después.
    const rolCompras = rolDeComprasSegunTelefono(config, from);
    if (rolCompras && message.type === "text") {
      const fechaHoyCompras = fechaDeHoyISOArgentina();
      const listaCompras = loadListaCompras(fechaHoyCompras);
      listaCompras.envios[rolCompras] = { recibido: true, textoOriginal: message.text.body };
      saveListaCompras(listaCompras);
      agregarMensajeInbox(from, "cliente", message.text.body, (staffConfig[rolCompras === "salon" ? "cajera" : rolCompras] || {}).nombre);
      console.log(`Pedido de compras recibido de ${rolCompras} (${from}).`);
      await sendWhatsappText(from, "¡Recibido! 📝 Ya anoté tu pedido de compras para hoy, gracias 🙌");
      return;
    }

    // ¿Hay un postulante esperando mandar su CV en este número, y este mensaje es
    // una imagen o un documento (PDF)? Si es así, lo tratamos como el CV — guardamos
    // el archivo, lo evaluamos con IA, y confirmamos la recepción. No pasa por Claude
    // en este turno (evitamos que se procese como comprobante de pago u otra cosa).
    const postulantes = loadPostulantes();
    const postulantePendiente = buscarPostulantePendiente(postulantes, from);
    if (postulantePendiente && (message.type === "image" || message.type === "document")) {
      try {
        console.log(`Recibiendo CV de ${postulantePendiente.nombre} (${from}) para el puesto de ${postulantePendiente.puesto}...`);
        const mediaId = message.type === "image" ? message.image.id : message.document.id;
        const { base64, mimeType } = await downloadWhatsappMedia(mediaId);
        const extension = mimeType === "application/pdf" ? "pdf" : mimeType.split("/")[1] || "bin";
        const nombreArchivo = `${postulantePendiente.id}.${extension}`;
        fs.writeFileSync(path.join(CVS_DIR, nombreArchivo), Buffer.from(base64, "base64"));

        let textoExtraido = "";
        if (mimeType === "application/pdf") {
          try {
            const parsed = await pdfParse(Buffer.from(base64, "base64"));
            textoExtraido = parsed.text.trim();
          } catch (err) {
            console.error("No se pudo extraer texto del PDF del CV:", err);
          }
        }

        const evaluacion = await evaluarCV(
          postulantePendiente.nombre,
          postulantePendiente.puesto,
          textoExtraido,
          mimeType === "application/pdf" ? null : base64,
          mimeType === "application/pdf" ? null : mimeType
        );

        postulantePendiente.cvArchivo = nombreArchivo;
        postulantePendiente.cvTipo = mimeType;
        postulantePendiente.evaluacion = evaluacion;
        postulantePendiente.estado = "evaluado";
        postulantePendiente.fechaCv = new Date().toISOString();
        savePostulantes(postulantes);

        const primerNombre = postulantePendiente.nombre ? postulantePendiente.nombre.split(" ")[0] : "";
        const mensajeConfirmacion = `¡Va que va${primerNombre ? ", " + primerNombre : ""}! Ya recibimos tu CV para el puesto de ${postulantePendiente.puesto}, buena onda 🙌 Lo vamos a tener guardado, y si en el futuro se abre un lugar para eso, nos comunicamos contigo al toque. ¡Que tengas un excelente día, compa!`;
        await sendWhatsappText(from, mensajeConfirmacion);
        agregarMensajeInbox(from, "chaparrita", mensajeConfirmacion);
        console.log(`CV de ${postulantePendiente.nombre} evaluado. Puntaje: ${evaluacion.puntaje}`);
      } catch (err) {
        console.error("Error procesando CV recibido:", err);
        await sendWhatsappText(from, "Uy, tuvimos un problemita técnico recibiendo tu archivo. ¿Me lo podés volver a mandar en un ratito?");
      }
      return;
    }

    // Tipos de mensaje que todavía no podemos "entender" (audio, video, sticker, ubicación, etc):
    // respondemos directo, sin pasar por Claude, para garantizar que el cliente SIEMPRE reciba algo.
    // Los PDFs (document) SÍ los dejamos pasar, para poder leerlos como posibles comprobantes.
    if (message.type !== "text" && message.type !== "image" && message.type !== "document") {
      console.log(`Tipo de mensaje no soportado todavía (${message.type}) — respondemos con un mensaje directo.`);
      const avisoPorTipo = {
        audio: "¡Uy, todavía no puedo escuchar audios! ¿Me lo escribís por acá nomás? Así te ayudo al toque 🙌",
        video: "Por ahora no puedo ver videos, pero contame por escrito qué necesitás y te ayudo enseguida 🙌",
        sticker: "¡Jaja me gustó el sticker! ¿En qué te puedo ayudar? Contame por escrito 🙌",
        location: "¡Recibí tu ubicación! Contame por escrito qué necesitás así seguimos 🙌",
      };
      const aviso = avisoPorTipo[message.type] || "Por ahora no puedo procesar ese tipo de mensaje. ¿Me contás por escrito qué necesitás? 🙌";
      await sendWhatsappText(from, aviso);
      return;
    }

    // Guardamos el mensaje entrante en el inbox persistente para el panel /admin/inbox,
    // sin importar si el mensaje es texto o imagen (usamos un texto descriptivo para imágenes).
    const clientesParaNombre = loadClientes();
    const perfilParaNombre = buscarCliente(clientesParaNombre, from);
    const textoParaInbox = message.type === "text" ? message.text.body : "[Imagen]" + (message.image?.caption ? `: ${message.image.caption}` : "");
    agregarMensajeInbox(from, "cliente", textoParaInbox, perfilParaNombre ? perfilParaNombre.nombre : "");

    // Si esta conversación puntual está en modo manual (alguien la está atendiendo a mano
    // desde /admin/inbox), el bot no contesta — se corta acá.
    if (chatEnModoManual(from)) {
      console.log(`Chat con ${from} está en modo manual — el bot no responde, queda para que lo atienda un humano desde /admin/inbox.`);
      return;
    }

    const contentBlocks = await buildUserContentBlocks(message);
    if (!contentBlocks) return;

    const history = conversations.get(from) || [];
    history.push({ role: "user", content: contentBlocks });

    const menuText = loadMenuText();
    const diaHoy = diaDeHoyArgentina();
    const fechaHoy = fechaDeHoyISOArgentina();
    const horaActual = horaActualArgentina();
    const promosHoy = (config.promosDia && config.promosDia[diaHoy]) ? config.promosDia[diaHoy].filter((p) => p.activa) : [];
    const clientes = loadClientes();
    const perfilCliente = buscarCliente(clientes, from) || null;
    const esDueño = !!(staffConfig.dueño && staffConfig.dueño.telefono && soloDigitos(staffConfig.dueño.telefono) === soloDigitos(from));
    let replyText = await askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño);
    console.log(`Respuesta de Claude generada (${replyText.length} caracteres):`, replyText.slice(0, 200));

    // Si Claude necesita saber la disponibilidad real de mesas para seguir la reserva,
    // la calculamos al instante y le devolvemos el dato en la misma conversación, para
    // que arme la respuesta final ya con el número real (el cliente nunca ve este ida y vuelta).
    const { cleanText: sinConsultaDispo, consulta: consultaDisponibilidad } = extractDisponibilidadMarker(replyText);
    if (consultaDisponibilidad && SECTORES_VALIDOS.includes((consultaDisponibilidad.sector || "").toLowerCase())) {
      const reservasActuales = loadReservas();
      const disponibilidad = calcularDisponibilidad(
        config,
        reservasActuales,
        consultaDisponibilidad.sector.toLowerCase(),
        consultaDisponibilidad.fecha,
        consultaDisponibilidad.hora
      );
      console.log(`Disponibilidad consultada (${consultaDisponibilidad.sector}, ${consultaDisponibilidad.fecha} ${consultaDisponibilidad.hora}): ${disponibilidad.libres}/${disponibilidad.totalMesas} libres.`);

      if (sinConsultaDispo) {
        history.push({ role: "assistant", content: [{ type: "text", text: sinConsultaDispo }] });
      }
      history.push({
        role: "user",
        content: [{
          type: "text",
          text: `[[DATOS_DISPONIBILIDAD: ${JSON.stringify(disponibilidad)}]] (Esto es información interna del sistema, no un mensaje real del cliente — es el resultado de la consulta de disponibilidad que pediste. Usalo para responder de forma natural y seguir la conversación con el cliente.)`,
        }],
      });
      replyText = await askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño);
      console.log(`Respuesta de Claude tras consultar disponibilidad (${replyText.length} caracteres):`, replyText.slice(0, 200));
    }

    // Si Claude quiere ver las reservas que ya tiene cargadas este cliente (para
    // confirmarle si están hechas, o para poder modificarlas/cancelarlas), se las
    // pasamos al instante, en el mismo ida y vuelta que la disponibilidad de mesas.
    const { cleanText: sinConsultaReservas, quiereConsultarReservas } = extractConsultarReservasMarker(replyText);
    if (quiereConsultarReservas) {
      const reservasCliente = loadReservas()
        .filter((r) => soloDigitos(r.telefono) === soloDigitos(from))
        .map((r) => ({ id: r.id, fecha: r.fecha, hora: r.hora, personas: r.personas, sector: r.sector }));
      console.log(`Cliente ${from} consultó sus reservas — se encontraron ${reservasCliente.length}.`);

      if (sinConsultaReservas) {
        history.push({ role: "assistant", content: [{ type: "text", text: sinConsultaReservas }] });
      }
      history.push({
        role: "user",
        content: [{
          type: "text",
          text: `[[DATOS_MIS_RESERVAS: ${JSON.stringify(reservasCliente)}]] (Esto es información interna del sistema, no un mensaje real del cliente — es la lista real de sus reservas cargadas, con el "id" de cada una para poder modificarla o cancelarla si lo pide. Si la lista está vacía, es que no tiene ninguna reserva cargada. Usalo para responder de forma natural.)`,
        }],
      });
      replyText = await askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño);
      console.log(`Respuesta de Claude tras consultar reservas del cliente (${replyText.length} caracteres):`, replyText.slice(0, 200));
    }

    // Si el dueño pidió el resumen (o el estado) de la lista de compras del día, la
    // consolidamos (si hace falta), le avisamos a quien todavía no mandó su pedido, y le
    // devolvemos el detalle real — nunca inventado — para que Claude arme la respuesta.
    const { cleanText: sinConsultaCompras, quiereListaCompras } = extractConsultarListaComprasMarker(replyText);
    if (quiereListaCompras) {
      const fechaHoyCompras = fechaDeHoyISOArgentina();
      const listaCompras = loadListaCompras(fechaHoyCompras);

      if (listaCompras.items.length === 0) {
        const nuevosItems = await consolidarListaCompras(listaCompras.envios);
        if (nuevosItems.length > 0) {
          listaCompras.items = nuevosItems;
          saveListaCompras(listaCompras);
        }
      }

      const rolesFaltantes = ROLES_COMPRAS.filter((r) => !listaCompras.envios[r].recibido);
      const NOMBRES_ROL_STAFF = { cocina: "cocina", barra: "barra", salon: "cajera" };
      for (const rol of rolesFaltantes) {
        const staffDelRol = staffConfig[NOMBRES_ROL_STAFF[rol]];
        const telRol = staffDelRol && soloDigitos(staffDelRol.telefono);
        if (telRol && telRol.length >= 10) {
          await sendWhatsappText(telRol, "¡Hola! 👋 Necesitamos tu lista de compras para hoy — ¿nos la mandás por acá cuando puedas? 🙏");
        }
      }
      if (rolesFaltantes.length > 0) {
        console.log(`Lista de compras: se pidió el pedido a los roles faltantes: ${rolesFaltantes.join(", ")}.`);
      }

      // Mandamos la lista con el formato prolijo (por categoría) como mensaje aparte,
      // así el dueño siempre la recibe bien armada, sin depender de cómo la redacte Claude.
      await sendWhatsappText(from, construirMensajeListaCompras(listaCompras.items, rolesFaltantes));
      agregarMensajeInbox(from, "chaparrita", construirMensajeListaCompras(listaCompras.items, rolesFaltantes));

      if (sinConsultaCompras) {
        history.push({ role: "assistant", content: [{ type: "text", text: sinConsultaCompras }] });
      }
      history.push({
        role: "user",
        content: [{
          type: "text",
          text: `[[DATOS_LISTA_COMPRAS: ${JSON.stringify({ items: listaCompras.items, rolesFaltantes })}]] (Esto es información interna del sistema, no un mensaje real del cliente — es la lista de compras real de hoy, con el "id" de cada ítem para poder marcarlo como comprado si el dueño lo pide. "comprado":true significa que ya se compró. Usalo para responder de forma natural.)`,
        }],
      });
      replyText = await askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño);
      console.log(`Respuesta de Claude tras consultar lista de compras (${replyText.length} caracteres):`, replyText.slice(0, 200));
    }

    const { cleanText: sinDatos, datos: datosReserva } = extractReservaDatosMarker(replyText);
    const { cleanText, reservaConfirmada } = extractReservaMarker(sinDatos);
    const { cleanText: sinEnvio, direccionEnvio } = extractConsultaEnvioMarker(cleanText);
    const { cleanText: sinPedido, pedidoConfirmado } = extractPedidoMarker(sinEnvio);
    const { cleanText: sinDatosCliente, datosCliente } = extractClienteDatosMarker(sinPedido);
    const { cleanText: sinPostulante, datosPostulante } = extractPostulanteDatosMarker(sinDatosCliente);
    const { cleanText: sinEspera, datosEspera } = extractListaEsperaMarker(sinPostulante);
    const { cleanText: sinActualizacion, actualizacion } = extractActualizarReservaMarker(sinEspera);
    const { cleanText: sinCancelacion, cancelacion } = extractCancelarReservaMarker(sinActualizacion);
    const { cleanText: cleanText2, marcarComprado } = extractMarcarCompradoMarker(sinCancelacion);

    history.push({ role: "assistant", content: [{ type: "text", text: cleanText2 }] });
    conversations.set(from, history);

    await sendWhatsappText(from, cleanText2);
    agregarMensajeInbox(from, "chaparrita", cleanText2);

    if (reservaConfirmada && config.grupoReservasWhatsappId) {
      await sendWhatsappText(config.grupoReservasWhatsappId, reservaConfirmada);
    }

    // Aviso individual al staff (alternativa que sí funciona con Cloud API, que no
    // soporta mandar mensajes a grupos de WhatsApp reales).
    if (reservaConfirmada && Array.isArray(config.avisosReservas)) {
      const avisosActivos = config.avisosReservas.filter((a) => a.activo && a.telefono);
      for (const aviso of avisosActivos) {
        const telLimpio = soloDigitos(aviso.telefono);
        if (telLimpio && telLimpio.length >= 10) {
          await sendWhatsappText(telLimpio, reservaConfirmada);
        } else {
          console.log(`Aviso de reserva: el teléfono de "${aviso.nombre}" no es válido (${aviso.telefono}), se saltea.`);
        }
      }
      if (avisosActivos.length > 0) {
        console.log(`Aviso de reserva confirmada enviado individualmente a ${avisosActivos.length} persona(s) del staff.`);
      }
    }

    if (pedidoConfirmado) {
      const telCocina = soloDigitos((config.staff && config.staff.cocina && config.staff.cocina.telefono) || "");
      if (telCocina && telCocina.length >= 10) {
        await sendWhatsappText(telCocina, pedidoConfirmado);
        console.log(`Pedido confirmado reenviado a cocina (${telCocina}).`);
      } else {
        console.log("Hubo un pedido confirmado pero no hay teléfono de cocina cargado en config.staff.cocina.");
      }
    }

    // Actualizamos el perfil del cliente: datos nuevos que haya contado (nombre/cumpleaños) y su historial de pedidos.
    // El nombre puede venir de la marca CLIENTE_DATOS, pero como respaldo (por si Claude se
    // olvida de esa marca en medio de una charla larga) también aceptamos el nombre que venga
    // de una reserva, un postulante o una lista de espera — esas marcas siempre piden el
    // nombre completo, así que son una fuente confiable igual.
    const nombreDetectado =
      (datosCliente && datosCliente.nombre) ||
      (datosReserva && datosReserva.nombre) ||
      (datosPostulante && datosPostulante.nombre) ||
      (datosEspera && datosEspera.nombre) ||
      null;

    if (datosCliente || pedidoConfirmado || nombreDetectado) {
      let cliente = buscarCliente(clientes, from);
      if (!cliente) {
        cliente = { telefono: from, nombre: "", cumpleanos: "", primeraVez: new Date().toISOString(), ultimaVez: new Date().toISOString(), cantidadPedidos: 0, historialPedidos: [], notas: "" };
        clientes.push(cliente);
      }
      if (nombreDetectado) {
        cliente.nombre = nombreDetectado;
        // Actualizamos también el nombre en /admin/inbox al instante, sin esperar
        // a que el cliente mande otro mensaje para que se refleje ahí.
        const inboxActualizado = loadInbox();
        const telInbox = soloDigitos(from);
        if (inboxActualizado[telInbox]) {
          inboxActualizado[telInbox].nombre = nombreDetectado;
          saveInbox(inboxActualizado);
        }
      }
      if (datosCliente && datosCliente.cumpleanos) cliente.cumpleanos = datosCliente.cumpleanos;
      if (pedidoConfirmado) {
        const itemsMatch = pedidoConfirmado.match(/Ítems:\s*(.+)/);
        cliente.historialPedidos = cliente.historialPedidos || [];
        cliente.historialPedidos.push({ fecha: new Date().toISOString(), resumen: itemsMatch ? itemsMatch[1].trim() : pedidoConfirmado.slice(0, 200) });
        if (cliente.historialPedidos.length > 10) cliente.historialPedidos = cliente.historialPedidos.slice(-10);
        cliente.cantidadPedidos = (cliente.cantidadPedidos || 0) + 1;
      }
      cliente.ultimaVez = new Date().toISOString();
      saveClientes(clientes);
    }

    // Si Claude detectó nombre + puesto de alguien buscando trabajo, guardamos (o
    // actualizamos) el registro de postulante, quedando a la espera de que mande el CV.
    if (datosPostulante && datosPostulante.nombre && PUESTOS_DISPONIBLES.includes(datosPostulante.puesto)) {
      let postulante = postulantes.find((p) => soloDigitos(p.telefono) === soloDigitos(from) && p.estado === "esperando_cv");
      if (!postulante) {
        postulante = { id: Date.now() + "-" + Math.random().toString(36).slice(2, 8), telefono: from, estado: "esperando_cv", fecha: new Date().toISOString() };
        postulantes.push(postulante);
      }
      postulante.nombre = datosPostulante.nombre;
      postulante.puesto = datosPostulante.puesto;
      savePostulantes(postulantes);
      console.log(`Postulante registrado, esperando CV: ${postulante.nombre} — puesto: ${postulante.puesto} (${from}).`);
    }

    if (datosReserva && datosReserva.fecha && datosReserva.hora) {
      const reservas = loadReservas();
      reservas.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        telefono: from,
        nombre: datosReserva.nombre || "",
        fecha: datosReserva.fecha,
        hora: datosReserva.hora,
        sector: (datosReserva.sector || "").toLowerCase(),
        personas: datosReserva.personas || null,
        recordatorioEnviado: false,
        creadaEn: new Date().toISOString(),
      });
      saveReservas(reservas);
      console.log(`Reserva guardada para recordatorio: ${datosReserva.nombre} - ${datosReserva.fecha} ${datosReserva.hora} (sector: ${datosReserva.sector || "sin especificar"})`);
    }

    // Si el cliente aceptó anotarse en la lista de espera porque no había mesas disponibles.
    if (datosEspera && datosEspera.telefono) {
      const listaEspera = loadListaEspera();
      listaEspera.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        telefono: from,
        nombre: datosEspera.nombre || "",
        sector: (datosEspera.sector || "").toLowerCase(),
        fecha: datosEspera.fecha || "",
        hora: datosEspera.hora || "",
        personas: datosEspera.personas || null,
        estado: "esperando",
        notificado: false,
        creadaEn: new Date().toISOString(),
      });
      saveListaEspera(listaEspera);
      console.log(`Cliente anotado en lista de espera: ${datosEspera.nombre} — ${datosEspera.sector} ${datosEspera.fecha} ${datosEspera.hora}.`);
    }

    // Si el cliente pidió modificar una reserva ya cargada (solo puede tocar las suyas,
    // verificamos que el teléfono coincida antes de aplicar cualquier cambio).
    if (actualizacion && actualizacion.id) {
      const reservasParaEditar = loadReservas();
      const reservaAEditar = reservasParaEditar.find((r) => r.id === actualizacion.id && soloDigitos(r.telefono) === soloDigitos(from));
      if (reservaAEditar) {
        const cambioFechaUHora = (actualizacion.fecha && actualizacion.fecha !== reservaAEditar.fecha) || (actualizacion.hora && actualizacion.hora !== reservaAEditar.hora);
        if (actualizacion.fecha) reservaAEditar.fecha = actualizacion.fecha;
        if (actualizacion.hora) reservaAEditar.hora = actualizacion.hora;
        if (actualizacion.personas) reservaAEditar.personas = Number(actualizacion.personas);
        if (actualizacion.sector) reservaAEditar.sector = actualizacion.sector.toLowerCase();
        if (cambioFechaUHora) reservaAEditar.recordatorioEnviado = false; // para que el recordatorio salga en el nuevo horario
        saveReservas(reservasParaEditar);
        console.log(`Reserva ${reservaAEditar.id} actualizada por el cliente: ${JSON.stringify(actualizacion)}`);
      } else {
        console.log(`El cliente ${from} pidió actualizar la reserva ${actualizacion.id}, pero no se encontró o no le pertenece.`);
      }
    }

    // Si el cliente pidió cancelar una reserva ya cargada (misma verificación de seguridad).
    if (cancelacion && cancelacion.id) {
      const reservasParaCancelar = loadReservas();
      const existiaYEraDelCliente = reservasParaCancelar.some((r) => r.id === cancelacion.id && soloDigitos(r.telefono) === soloDigitos(from));
      if (existiaYEraDelCliente) {
        saveReservas(reservasParaCancelar.filter((r) => r.id !== cancelacion.id));
        console.log(`Reserva ${cancelacion.id} cancelada por el cliente ${from}.`);
      } else {
        console.log(`El cliente ${from} pidió cancelar la reserva ${cancelacion.id}, pero no se encontró o no le pertenece.`);
      }
    }

    // Si el dueño confirmó que ya compró ciertos ítems de la lista de compras, los marcamos.
    if (marcarComprado && Array.isArray(marcarComprado.ids) && marcarComprado.ids.length > 0) {
      const fechaHoyMarcar = fechaDeHoyISOArgentina();
      const listaComprasMarcar = loadListaCompras(fechaHoyMarcar);
      let huboCambiosCompras = false;
      listaComprasMarcar.items.forEach((item) => {
        if (marcarComprado.ids.includes(item.id)) {
          item.comprado = true;
          huboCambiosCompras = true;
        }
      });
      if (huboCambiosCompras) {
        saveListaCompras(listaComprasMarcar);
        console.log(`Ítems marcados como comprados: ${marcarComprado.ids.join(", ")}.`);
      }
    }

    // Si Claude pidió consultar el costo de envío, le mandamos la consulta al primer cadete activo.
    if (direccionEnvio) {
      const activos = cadetes.filter((c) => c.activo);
      if (activos.length > 0) {
        const elegido = activos[0];
        const telCadete = soloDigitos(elegido.telefono);
        pendingDeliveryQuotes.set(telCadete, { customerPhone: from, direccion: direccionEnvio, askedAt: Date.now() });
        await sendWhatsappText(telCadete, `Hola ${elegido.nombre}! ¿Cuánto sale el envío desde Chaparrita hasta ${direccionEnvio}? Contestame con el precio nomás así se lo paso al cliente 🙌`);
        console.log(`Consulta de envío enviada a ${elegido.nombre} (${telCadete}) para dirección: ${direccionEnvio}`);
      } else {
        console.log("Claude pidió consultar envío pero no hay cadetes activos configurados.");
      }
    }

    // Si el cliente mandó una imagen o un PDF (probablemente un comprobante), le reenviamos
    // el archivo a quienes manejan pagos (NO a cocina), y guardamos que quedó pendiente
    // de confirmación — así, cuando el staff responda, sabemos que es sobre esto y no
    // lo tratamos como si fuera un cliente nuevo escribiéndole al bot.
    if ((message.type === "image" && message.image?.id) || (message.type === "document" && message.document?.id)) {
      const staff = config.staff || {};
      const staffPhones = [staff.cajera, staff.dueño]
        .filter(Boolean)
        .map((s) => soloDigitos(s.telefono))
        .filter((tel) => tel && tel.length >= 10);
      const captionAviso = `📎 Comprobante recibido de +${from}. Revisá y confirmá el pago cuando puedas — el cliente ya está esperando la confirmación. Contestame acá mismo con "sí" o "no" (o contame el motivo si no es válido) para que se lo reenvíe automáticamente.`;
      for (const tel of staffPhones) {
        if (message.type === "image") {
          await sendWhatsappImage(tel, message.image.id, captionAviso);
        } else {
          await sendWhatsappDocument(tel, message.document.id, captionAviso, message.document.filename || "comprobante.pdf");
        }
        pendingComprobantes.set(tel, { customerPhone: from, askedAt: Date.now() });
      }
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

  if (message.type === "document") {
    const mediaId = message.document.id;
    const { base64, mimeType } = await downloadWhatsappMedia(mediaId);
    if (mimeType === "application/pdf") {
      return [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: message.document.caption || "Te mando el PDF (puede ser un comprobante de pago)." },
      ];
    }
    return [{ type: "text", text: "[El cliente mandó un archivo que no es un PDF ni una imagen — todavía no lo podemos leer automáticamente]" }];
  }

  // Otros tipos (audio, ubicación, etc.) — se pueden sumar acá.
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
async function askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño) {
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
      system: buildSystemPrompt(config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño),
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

// ==================== Evaluación automática de CVs ====================
// Llamada aparte a Claude (no es parte de la charla con el cliente) para puntuar
// el CV según experiencia, formación y disponibilidad horaria.
const EVALUACION_CV_SYSTEM_PROMPT = `Sos un evaluador de CVs para un restaurante bar mexicano en Formosa, Argentina llamado Chaparrita. Te paso el nombre del postulante, el puesto al que aplica, y el contenido de su CV (como texto extraído de un PDF, o directamente la imagen del CV). Tu trabajo es evaluarlo con criterio realista de gastronomía/hotelería, considerando:

1) EXPERIENCIA LABORAL: mirá la duración de cada trabajo anterior, no solo la cantidad.
   - Trabajos de 1 a 2+ años en un mismo lugar indican estabilidad y compromiso — es un punto a favor fuerte.
   - Varios trabajos de muy poca duración (semanas o pocos meses) en distintos lugares pueden ser señal de un problema de personalidad, disciplina o conflictos laborales — marcalo como una alerta, sin ser injusto (a veces hay explicaciones válidas como changas de temporada, que no son lo mismo).
   - La experiencia específica en el rubro gastronómico y en tareas similares al puesto al que aplica (mozo, cajero, barman, cocinero, ayudante de cocina, bachero/lavacopas) vale mucho más que experiencia en rubros totalmente distintos.

2) FORMACIÓN / ESTUDIOS: distinguí claramente el nivel real de la formación.
   - Un curso formal de varios meses o un título terciario/técnico relacionado (por ejemplo curso de bartender de varios meses, escuela de gastronomía, curso de coctelería con carga horaria) vale mucho más que:
   - Una charla, taller o seminario de un solo día — esto casi no suma como formación real, aunque muestre interés.
   - Si no hay ninguna formación relacionada, no lo penalices de más si la experiencia laboral es sólida (para varios de estos puestos la experiencia práctica pesa más que el estudio formal).

3) DISPONIBILIDAD HORARIA: si el CV menciona disponibilidad horaria, notalo. Los puestos de restaurante bar suelen necesitar gente disponible de noche y fines de semana — si el postulante aclara que tiene esa disponibilidad, es un punto a favor. Si el CV no menciona nada de disponibilidad, indicalo como "no especificada" sin penalizar.

Respondé ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown, sin \`\`\`), con esta forma exacta:
{"puntaje": NUMERO_DEL_1_AL_10, "resumenExperiencia": "2-3 frases sobre la experiencia laboral y su relevancia/estabilidad", "resumenEducacion": "2-3 frases sobre la formación y qué tan relevante es", "disponibilidad": "lo que diga el CV sobre disponibilidad horaria, o 'No especificada' si no dice nada", "comentario": "conclusión breve de 1-2 frases sobre qué tan recomendable es este postulante para el puesto"}`;

async function evaluarCV(nombre, puesto, textoExtraido, imagenBase64, imagenMimeType) {
  const contenidoUsuario = [];
  contenidoUsuario.push({
    type: "text",
    text: `Nombre del postulante: ${nombre}\nPuesto al que aplica: ${puesto}\n\n${
      textoExtraido
        ? `Contenido del CV (extraído de un PDF):\n${textoExtraido.slice(0, 8000)}`
        : "El CV viene como imagen adjunta, evaluá lo que puedas leer en ella."
    }`,
  });
  if (imagenBase64 && imagenMimeType) {
    contenidoUsuario.push({ type: "image", source: { type: "base64", media_type: imagenMimeType, data: imagenBase64 } });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        system: EVALUACION_CV_SYSTEM_PROMPT,
        messages: [{ role: "user", content: contenidoUsuario }],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Error de la API de Claude al evaluar CV:", data);
      return { puntaje: null, resumenExperiencia: "", resumenEducacion: "", disponibilidad: "", comentario: "No se pudo evaluar automáticamente, revisar el CV a mano." };
    }
    const textoRespuesta = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim()
      .replace(/^```json\s*|\s*```$/g, "");
    return JSON.parse(textoRespuesta);
  } catch (err) {
    console.error("Error evaluando CV:", err);
    return { puntaje: null, resumenExperiencia: "", resumenEducacion: "", disponibilidad: "", comentario: "No se pudo evaluar automáticamente, revisar el CV a mano." };
  }
}

// Saca la marca interna [[RESERVA_DATOS: {...json...}]] y devuelve el texto limpio + los datos parseados
function extractReservaDatosMarker(text) {
  const regex = /\[\[RESERVA_DATOS:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, datos: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    const datos = JSON.parse(match[1]);
    return { cleanText, datos };
  } catch (e) {
    console.error("No se pudo parsear RESERVA_DATOS:", match[1]);
    return { cleanText, datos: null };
  }
}

// Saca la marca interna [[PEDIDO_CONFIRMADO]] y devuelve el texto limpio + el resumen para cocina
function extractPedidoMarker(text) {
  const marker = "[[PEDIDO_CONFIRMADO]]";
  const idx = text.indexOf(marker);
  if (idx === -1) return { cleanText: text, pedidoConfirmado: null };
  const cleanText = text.slice(0, idx).trim();
  const pedidoConfirmado = text.slice(idx + marker.length).trim();
  return { cleanText, pedidoConfirmado };
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

// Saca la marca interna [[CONSULTAR_ENVIO: direccion]] y devuelve el texto limpio + la dirección a cotizar
function extractConsultaEnvioMarker(text) {
  const regex = /\[\[CONSULTAR_ENVIO:\s*([^\]]+)\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, direccionEnvio: null };
  const cleanText = text.replace(regex, "").trim();
  return { cleanText, direccionEnvio: match[1].trim() };
}

// Argentina: los mensajes ENTRANTES llegan con "549" + número (ej 5493704332207),
// pero para ENVIAR hay que sacarle el 9 (549XXXXXXXXXX -> 54XXXXXXXXXX), es un
// comportamiento conocido y documentado de la WhatsApp Cloud API para números argentinos.
function normalizarParaEnvioAR(numero) {
  if (numero.startsWith("549")) {
    return "54" + numero.slice(3);
  }
  return numero;
}

// ==================== Envío de mensajes por WhatsApp ====================
async function sendWhatsappText(to, body) {
  const destino = normalizarParaEnvioAR(to);
  console.log(`Enviando mensaje a ${destino} (original: ${to}) vía WhatsApp (Phone Number ID: ${WHATSAPP_PHONE_NUMBER_ID})...`);
  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: destino,
        type: "text",
        text: { body },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("ERROR al enviar mensaje por WhatsApp:", JSON.stringify(data));
      return false;
    }
    console.log("Mensaje enviado a WhatsApp OK:", JSON.stringify(data));
    return true;
  } catch (err) {
    console.error("ERROR de red al enviar mensaje por WhatsApp:", err.message);
    return false;
  }
}

async function sendWhatsappImage(to, mediaId, caption) {
  const destino = normalizarParaEnvioAR(to);
  console.log(`Reenviando imagen (media id ${mediaId}) a ${destino}...`);
  const response = await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: destino,
      type: "image",
      image: { id: mediaId, caption },
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("ERROR al reenviar imagen por WhatsApp:", JSON.stringify(data));
  } else {
    console.log("Imagen reenviada a WhatsApp OK:", JSON.stringify(data));
  }
}

async function sendWhatsappDocument(to, mediaId, caption, filename) {
  const destino = normalizarParaEnvioAR(to);
  console.log(`Reenviando documento (media id ${mediaId}) a ${destino}...`);
  const response = await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: destino,
      type: "document",
      document: { id: mediaId, caption, filename: filename || "documento.pdf" },
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("ERROR al reenviar documento por WhatsApp:", JSON.stringify(data));
  } else {
    console.log("Documento reenviado a WhatsApp OK:", JSON.stringify(data));
  }
}

app.get("/", (_req, res) => res.send("Chaparrita agente — backend activo ✅"));

// ==================== Panel de administración ====================
app.get("/admin", requireAdminPage, (_req, res) => {
  res.type("html").send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8"><title>Chaparrita — Panel</title>
      <style>${ADMIN_BASE_CSS}</style>
    </head>
    <body>
      <div class="contenedor">
        <div class="topbar">
          <div class="marca">
            <div class="icono">🌮</div>
            <div><b>Chaparrita</b><span>Panel de administración</span></div>
          </div>
          <a class="logout" href="/admin/logout">Cerrar sesión ⏻</a>
        </div>
        <div class="tile-grid">
          <a class="tile" href="/admin/switch"><div class="tile-icono">🔌</div><div class="tile-texto"><b>Prender / apagar el asistente</b><div class="tile-desc">Pausalo cuando un operador quiera atender en persona.</div></div></a>
          <a class="tile" href="/admin/inbox"><div class="tile-icono">💬</div><div class="tile-texto"><b>Atender manualmente</b><div class="tile-desc">Vé las conversaciones y respondé vos mismo cuando quieras, sin usar el celular.</div></div></a>
          <a class="tile" href="/admin/reservas"><div class="tile-icono">📅</div><div class="tile-texto"><b>Reservas</b><div class="tile-desc">Vé las reservas del día, editalas o reenviá la confirmación por WhatsApp.</div></div></a>
          <a class="tile" href="/admin/clientes"><div class="tile-icono">👥</div><div class="tile-texto"><b>Clientes conocidos</b><div class="tile-desc">Nombres, cumpleaños e historial de pedidos que fue guardando el agente.</div></div></a>
          <a class="tile" href="/admin/postulantes"><div class="tile-icono">🧾</div><div class="tile-texto"><b>Postulantes / CVs</b><div class="tile-desc">Gente que dejó su CV, con puntaje automático según experiencia, formación y disponibilidad.</div></div></a>
          <a class="tile" href="/admin/listaespera"><div class="tile-icono">⏳</div><div class="tile-texto"><b>Lista de espera de mesas</b><div class="tile-desc">Clientes esperando lugar cuando el sector está lleno — se les avisa solo por WhatsApp.</div></div></a>
          <a class="tile" href="/admin/inactivos"><div class="tile-icono">📉</div><div class="tile-texto"><b>Clientes inactivos</b><div class="tile-desc">Detecta clientes que dejaron de pedir y te avisa por WhatsApp.</div></div></a>
          <a class="tile" href="/admin/menu"><div class="tile-icono">📋</div><div class="tile-texto"><b>Actualizar el menú</b><div class="tile-desc">Subir un PDF nuevo con precios y productos.</div></div></a>
          <a class="tile" href="/admin/config"><div class="tile-icono">⚙️</div><div class="tile-texto"><b>Precios, horarios, promos y teléfonos</b><div class="tile-desc">Editar promos de cumpleaños, seña, horarios, productos agotados, promos por día y teléfonos del equipo.</div></div></a>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get("/admin/menu", requireAdminPage, (_req, res) => {
  res.type("html").send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8"><title>Chaparrita — Actualizar menú</title>
      <style>${ADMIN_BASE_CSS}
        .dropzone { border: 2px dashed var(--borde); border-radius: var(--radio); padding: 30px 16px; text-align: center; margin-top: 14px; transition: border-color .15s ease; }
        .dropzone:hover { border-color: var(--turquesa); }
        .dropzone .icono { font-size: 30px; margin-bottom: 8px; }
        .dropzone input[type=file] { margin-top: 12px; }
      </style>
    </head>
    <body>
      <div class="contenedor">
        <a class="volver" href="/admin">← Volver al panel</a>
        <h1>🌮 Actualizar menú de Chaparrita</h1>
        <p class="sub">Subí el PDF del menú nuevo. El agente lo va a usar en la próxima conversación, sin necesidad de tocar código.</p>
        <form action="/admin/upload-menu" method="POST" enctype="multipart/form-data">
          <div class="dropzone">
            <div class="icono">📄</div>
            <label style="margin-top:0">Archivo PDF del menú</label>
            <input type="file" name="menuPdf" accept="application/pdf" required />
          </div>
          <button class="btn-primary" type="submit" style="width:100%">Subir y actualizar menú</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post("/admin/upload-menu", requireAdminApi, upload.single("menuPdf"), async (req, res) => {
  try {
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
      <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>${ADMIN_BASE_CSS}</style></head>
      <body><div class="contenedor" style="text-align:center;padding-top:60px;">
      <div style="font-size:44px;margin-bottom:10px;">✅</div>
      <h1>Menú actualizado</h1>
      <p class="sub">Se guardaron ${text.length} caracteres de texto extraído del PDF. El agente ya lo va a usar desde el próximo mensaje.</p>
      <p style="margin-top:20px;"><a class="volver" href="/admin/menu" style="display:inline-flex;margin-right:8px;">Volver a subir otro</a> <a class="volver" href="/admin" style="display:inline-flex;">Volver al panel</a></p>
      </div></body></html>
    `);
  } catch (err) {
    console.error("Error al procesar el PDF del menú:", err);
    res.status(500).send("Hubo un error al procesar el PDF. Probá de nuevo.");
  }
});

// ==================== Switch rápido para prender/apagar el asistente ====================
app.get("/admin/clientes", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<title>Chaparrita - Clientes</title>',
    `<style>${ADMIN_BASE_CSS}
      .filtros-row { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
      .filtros-row button { margin-top: 0; }
      .filtros-row button.activo { background: linear-gradient(135deg, var(--verde-wa-oscuro), var(--verde-wa)); color: #fff; }
      .cliente-nombre { font-weight: 700; font-size: 15px; }
      .cliente-tel { font-size: 12px; color: var(--texto-tenue); margin-top: 2px; }
      .cliente-detalle { font-size: 12.5px; margin-top: 8px; color: var(--texto-tenue); line-height: 1.5; }
      .cumple-badge { display: inline-block; background: rgba(232,103,74,0.15); color: var(--coral); border-radius: 12px; padding: 2px 9px; font-size: 11px; font-weight: 700; margin-left: 8px; }
      .cliente-editar { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: flex-end; }
      .cliente-editar div { flex: 1; min-width: 110px; }
      .cliente-editar label { margin-top: 0; }
      .cliente-editar input[type=text] { margin-top: 4px; }
      .cliente-editar button { margin-top: 0; white-space: nowrap; }
    </style>`,
    '</head><body>',
    '<div class="contenedor">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>👥 Clientes conocidos</h1>',
    '<div id="msg">Cargando...</div>',
    '<div class="filtros-row" id="filtros" style="display:none;">',
    '  <button id="btnOrdenVisita" class="btn-secondary activo">Por última visita</button>',
    '  <button id="btnOrdenCumple" class="btn-secondary">🎂 Próximos cumpleaños</button>',
    '</div>',
    '<input type="text" id="buscador" placeholder="Buscar por nombre o teléfono..." style="display:none;margin-top:10px;" />',
    '<div id="lista"></div>',
    '<script>',
    'var todos = [];',
    'var modoOrden = "visita";',
    'function diasHastaCumple(cumpleanosDDMM) {',
    '  if (!cumpleanosDDMM) return null;',
    '  var partes = cumpleanosDDMM.split("-"); var dia = parseInt(partes[0],10); var mes = parseInt(partes[1],10);',
    '  if (!dia || !mes) return null;',
    '  var hoy = new Date(); hoy.setHours(0,0,0,0);',
    '  var anio = hoy.getFullYear();',
    '  var prox = new Date(anio, mes-1, dia);',
    '  if (prox < hoy) prox = new Date(anio+1, mes-1, dia);',
    '  return Math.round((prox - hoy) / (1000*60*60*24));',
    '}',
    'function cargar() {',
    '  fetch("/admin/clientes-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      todos = data;',
    '      document.getElementById("filtros").style.display = "flex";',
    '      document.getElementById("buscador").style.display = "block";',
    '      document.getElementById("msg").textContent = todos.length + " clientes guardados.";',
    '      pintar(todos);',
    '    })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; } });',
    '}',
    'cargar();',
    'document.getElementById("btnOrdenVisita").addEventListener("click", function(){ modoOrden = "visita"; this.className="btn-secondary activo"; document.getElementById("btnOrdenCumple").className="btn-secondary"; pintar(todos); });',
    'document.getElementById("btnOrdenCumple").addEventListener("click", function(){ modoOrden = "cumple"; this.className="btn-secondary activo"; document.getElementById("btnOrdenVisita").className="btn-secondary"; pintar(todos); });',
    'document.getElementById("buscador").addEventListener("input", function() {',
    '  var q = this.value.toLowerCase();',
    '  var filtrados = todos.filter(function(c) { return (c.nombre||"").toLowerCase().indexOf(q) !== -1 || (c.telefono||"").indexOf(q) !== -1; });',
    '  pintar(filtrados);',
    '});',
    'function pintar(lista) {',
    '  var cont = document.getElementById("lista");',
    '  cont.innerHTML = "";',
    '  var ordenados = lista.slice();',
    '  if (modoOrden === "cumple") {',
    '    ordenados = ordenados.filter(function(c){ return c.cumpleanos; });',
    '    ordenados.forEach(function(c){ c._dias = diasHastaCumple(c.cumpleanos); });',
    '    ordenados.sort(function(a,b){ return (a._dias==null?999:a._dias) - (b._dias==null?999:b._dias); });',
    '  } else {',
    '    ordenados.sort(function(a,b){ return new Date(b.ultimaVez||0) - new Date(a.ultimaVez||0); });',
    '  }',
    '  ordenados.forEach(function(c) {',
    '    var div = document.createElement("div");',
    '    div.className = "card";',
    '    var pedidos = (c.historialPedidos||[]).slice(-3).map(function(p){ return p.resumen; }).join(" | ") || "sin pedidos registrados";',
    '    var etiquetaCumple = "";',
    '    if (c.cumpleanos) {',
    '      var dias = c._dias != null ? c._dias : diasHastaCumple(c.cumpleanos);',
    '      var txt = dias === 0 ? "¡ES HOY!" : ("en " + dias + " días");',
    '      etiquetaCumple = "<span class=\\"cumple-badge\\">🎂 " + c.cumpleanos + " (" + txt + ")</span>";',
    '    }',
    '    div.innerHTML = "<span class=\\"cliente-nombre\\">" + (c.nombre || "(sin nombre)") + "</span>" + etiquetaCumple +',
    '      "<div class=\\"cliente-tel\\">+" + c.telefono + "</div>" +',
    '      "<div class=\\"cliente-detalle\\">Pedidos: " + (c.cantidadPedidos||0) + " · Últimos: " + pedidos + "</div>" +',
    '      "<div class=\\"cliente-editar\\">" +',
    '      "<div><label>Nombre</label><input type=\\"text\\" data-campo=\\"nombre\\" value=\\"" + (c.nombre || "").replace(/"/g,"&quot;") + "\\" /></div>" +',
    '      "<div><label>Cumpleaños (DD-MM)</label><input type=\\"text\\" data-campo=\\"cumpleanos\\" placeholder=\\"ej: 15-03\\" value=\\"" + (c.cumpleanos || "") + "\\" /></div>" +',
    '      "<button class=\\"btn-secondary\\" data-accion=\\"guardar\\">Guardar</button>" +',
    '      "</div>";',
    '    div.querySelector("[data-accion=guardar]").addEventListener("click", function(){',
    '      var nombreNuevo = div.querySelector("[data-campo=nombre]").value;',
    '      var cumpleNuevo = div.querySelector("[data-campo=cumpleanos]").value;',
    '      var btn = div.querySelector("[data-accion=guardar]");',
    '      btn.textContent = "Guardando...";',
    '      fetch("/admin/clientes-guardar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({telefono: c.telefono, campos: {nombre: nombreNuevo, cumpleanos: cumpleNuevo}})})',
    '        .then(function(r){ return r.json(); })',
    '        .then(function(){ btn.textContent = "¡Guardado!"; setTimeout(cargar, 700); })',
    '        .catch(function(){ btn.textContent = "Error"; });',
    '    });',
    '    cont.appendChild(div);',
    '  });',
    '  if (ordenados.length === 0) { cont.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icono\\">👥</div>No hay clientes que coincidan.</div>"; }',
    '}',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/clientes-data", requireAdminApi, (req, res) => {
  res.json(loadClientes());
});

app.post("/admin/clientes-guardar", requireAdminApi, (req, res) => {
  try {
    const clientes = loadClientes();
    const cliente = clientes.find((c) => soloDigitos(c.telefono) === soloDigitos(req.body.telefono));
    if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });
    const campos = req.body.campos || {};
    if (typeof campos.nombre === "string") cliente.nombre = campos.nombre;
    if (typeof campos.cumpleanos === "string") cliente.cumpleanos = campos.cumpleanos;
    saveClientes(clientes);

    // Reflejamos el nombre también en /admin/inbox al instante, igual que hace el bot.
    if (campos.nombre) {
      const inbox = loadInbox();
      const tel = soloDigitos(req.body.telefono);
      if (inbox[tel]) {
        inbox[tel].nombre = campos.nombre;
        saveInbox(inbox);
      }
    }
    console.log(`Cliente ${req.body.telefono} editado manualmente desde /admin/clientes.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al guardar cliente:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

// ==================== Postulantes / CVs ====================
app.get("/admin/postulantes", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<title>Chaparrita - Postulantes</title>',
    `<style>${ADMIN_BASE_CSS}
      .postulante-nombre { font-weight: 700; font-size: 15px; }
      .postulante-puesto { font-size: 12px; color: var(--turquesa); text-transform: capitalize; font-weight: 600; margin-top: 2px; }
      .postulante-tel { font-size: 12px; color: var(--texto-tenue); margin-top: 2px; }
      .postulante-detalle { font-size: 12.5px; margin-top: 8px; line-height: 1.55; color: var(--texto-tenue); }
      .postulante-detalle b { color: var(--coral); }
      .acciones { margin-top: 12px; display: flex; gap: 8px; }
      .acciones a { font-size: 12px; color: var(--turquesa); text-decoration: none; border: 1px solid var(--turquesa); border-radius: 8px; padding: 6px 11px; }
      .acciones a:hover { background: rgba(47,156,149,0.12); }
    </style>`,
    '</head><body>',
    '<div class="contenedor">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>🧾 Postulantes / CVs</h1>',
    '<select id="filtroPuesto">',
    '  <option value="">Todos los puestos</option>',
    '  <option value="mozo">Mozo</option>',
    '  <option value="cajero">Cajero</option>',
    '  <option value="barman">Barman</option>',
    '  <option value="cocinero">Cocinero</option>',
    '  <option value="ayudante de cocina">Ayudante de cocina</option>',
    '  <option value="bachero">Bachero / Lavacopas</option>',
    '</select>',
    '<div id="msg">Cargando...</div>',
    '<div id="lista"></div>',
    '<script>',
    'var todos = [];',
    'function cargar() {',
    '  fetch("/admin/postulantes-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      todos = data.postulantes;',
    '      document.getElementById("msg").textContent = todos.length + " postulantes guardados.";',
    '      pintar();',
    '    })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; } });',
    '}',
    'cargar();',
    'document.getElementById("filtroPuesto").addEventListener("change", pintar);',
    'function badgeClase(puntaje) {',
    '  if (puntaje == null) return "badge-pendiente";',
    '  if (puntaje >= 7) return "badge-alto";',
    '  if (puntaje >= 4) return "badge-medio";',
    '  return "badge-bajo";',
    '}',
    'function pintar() {',
    '  var cont = document.getElementById("lista");',
    '  cont.innerHTML = "";',
    '  var filtro = document.getElementById("filtroPuesto").value;',
    '  var lista = todos.slice().sort(function(a,b){ return new Date(b.fecha) - new Date(a.fecha); });',
    '  if (filtro) lista = lista.filter(function(p){ return p.puesto === filtro; });',
    '  if (lista.length === 0) { cont.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icono\\">🧾</div>No hay postulantes que coincidan.</div>"; return; }',
    '  lista.forEach(function(p) {',
    '    var div = document.createElement("div");',
    '    div.className = "card";',
    '    var ev = p.evaluacion || {};',
    '    var badge = p.estado === "evaluado"',
    '      ? "<span class=\\"badge " + badgeClase(ev.puntaje) + "\\">" + (ev.puntaje != null ? ev.puntaje + "/10" : "Sin evaluar") + "</span>"',
    '      : "<span class=\\"badge badge-pendiente\\">Esperando CV</span>";',
    '    var detalle = p.estado === "evaluado"',
    '      ? "<div class=\\"postulante-detalle\\"><b>Experiencia:</b> " + (ev.resumenExperiencia || "-") + "</div>" +',
    '        "<div class=\\"postulante-detalle\\"><b>Formación:</b> " + (ev.resumenEducacion || "-") + "</div>" +',
    '        "<div class=\\"postulante-detalle\\"><b>Disponibilidad:</b> " + (ev.disponibilidad || "-") + "</div>" +',
    '        "<div class=\\"postulante-detalle\\"><b>Conclusión:</b> " + (ev.comentario || "-") + "</div>"',
    '      : "<div class=\\"postulante-detalle\\">Todavía no mandó el CV.</div>";',
    '    var acciones = "<div class=\\"acciones\\">" +',
    '      (p.cvArchivo ? "<a href=\\"/admin/postulantes/cv/" + p.id + "\\" target=\\"_blank\\">Ver CV</a>" : "") +',
    '      "<a href=\\"/admin/inbox?tel=" + p.telefono + "\\">Ir al chat</a>" +',
    '      "</div>";',
    '    div.innerHTML = "<span class=\\"postulante-nombre\\">" + (p.nombre || "(sin nombre)") + "</span>" + badge +',
    '      "<div class=\\"postulante-puesto\\">" + (p.puesto || "") + "</div>" +',
    '      "<div class=\\"postulante-tel\\">+" + p.telefono + " · " + new Date(p.fecha).toLocaleDateString("es-AR") + "</div>" +',
    '      detalle + acciones;',
    '    cont.appendChild(div);',
    '  });',
    '}',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/postulantes-data", requireAdminApi, (_req, res) => {
  res.json({ postulantes: loadPostulantes() });
});

app.get("/admin/postulantes/cv/:id", requireAdminPage, (req, res) => {
  const postulantes = loadPostulantes();
  const postulante = postulantes.find((p) => p.id === req.params.id);
  if (!postulante || !postulante.cvArchivo) {
    return res.status(404).send("CV no encontrado.");
  }
  const filePath = path.join(CVS_DIR, postulante.cvArchivo);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("El archivo del CV ya no está disponible.");
  }
  res.sendFile(filePath);
});

// ==================== Lista de espera de mesas ====================
app.get("/admin/listaespera", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<title>Chaparrita - Lista de espera</title>',
    `<style>${ADMIN_BASE_CSS}
      .espera-nombre { font-weight: 700; font-size: 15px; }
      .espera-tel { font-size: 12px; color: var(--texto-tenue); margin-top: 2px; }
      .espera-detalle { font-size: 12.5px; margin-top: 8px; color: var(--texto-tenue); line-height: 1.5; }
      .acciones { margin-top: 12px; display: flex; gap: 8px; }
      .acciones a, .acciones button { font-size: 12px; text-decoration: none; border-radius: 8px; padding: 6px 11px; cursor: pointer; }
      .acciones a { color: var(--turquesa); border: 1px solid var(--turquesa); background: transparent; }
      .acciones a:hover { background: rgba(18,140,126,0.1); }
      .acciones button { color: var(--coral); border: 1px solid var(--coral); background: transparent; margin-top: 0; }
      .acciones button:hover { background: rgba(232,103,74,0.1); }
    </style>`,
    '</head><body>',
    '<div class="contenedor">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>⏳ Lista de espera de mesas</h1>',
    '<p class="sub">Clientes que pidieron reservar en un sector sin lugar disponible. Cuando se libera una mesa, el sistema les avisa solo por WhatsApp.</p>',
    '<div id="msg">Cargando...</div>',
    '<div id="lista"></div>',
    '<script>',
    'function cargar() {',
    '  fetch("/admin/listaespera-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      document.getElementById("msg").textContent = data.lista.length + " en espera.";',
    '      pintar(data.lista);',
    '    })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; } });',
    '}',
    'cargar();',
    'function pintar(lista) {',
    '  var cont = document.getElementById("lista");',
    '  cont.innerHTML = "";',
    '  var activos = lista.filter(function(e){ return e.estado === "esperando"; }).sort(function(a,b){ return new Date(a.creadaEn) - new Date(b.creadaEn); });',
    '  if (activos.length === 0) { cont.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icono\\">⏳</div>No hay nadie en lista de espera ahora mismo.</div>"; return; }',
    '  activos.forEach(function(e) {',
    '    var div = document.createElement("div");',
    '    div.className = "card";',
    '    var badge = e.notificado ? "<span class=\\"badge badge-alto\\">Avisado</span>" : "<span class=\\"badge badge-pendiente\\">Esperando</span>";',
    '    div.innerHTML = "<span class=\\"espera-nombre\\">" + (e.nombre || "(sin nombre)") + "</span> " + badge +',
    '      "<div class=\\"espera-tel\\">+" + e.telefono + "</div>" +',
    '      "<div class=\\"espera-detalle\\">Sector: " + e.sector + " · " + e.fecha + " " + e.hora + "hs · " + (e.personas || "?") + " personas</div>" +',
    '      "<div class=\\"acciones\\"><a href=\\"/admin/inbox?tel=" + e.telefono + "\\">Ir al chat</a><button data-id=\\"" + e.id + "\\">Quitar de la lista</button></div>";',
    '    cont.appendChild(div);',
    '  });',
    '  Array.prototype.forEach.call(cont.querySelectorAll("button[data-id]"), function(btn) {',
    '    btn.addEventListener("click", function() {',
    '      fetch("/admin/listaespera-quitar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({id: btn.getAttribute("data-id")})})',
    '        .then(function(r){ return r.json(); })',
    '        .then(function(){ cargar(); });',
    '    });',
    '  });',
    '}',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/listaespera-data", requireAdminApi, (_req, res) => {
  res.json({ lista: loadListaEspera() });
});

app.post("/admin/listaespera-quitar", requireAdminApi, (req, res) => {
  try {
    const lista = loadListaEspera();
    const actualizada = lista.filter((e) => e.id !== req.body.id);
    saveListaEspera(actualizada);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al quitar de lista de espera:", err);
    res.status(500).json({ error: "No se pudo quitar" });
  }
});

// ==================== Panel de reservas (ver, editar y confirmar manualmente) ====================
app.get("/admin/reservas", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<title>Chaparrita - Reservas</title>',
    `<style>${ADMIN_BASE_CSS}
      .filtro-fecha-row { display: flex; gap: 8px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
      .filtro-fecha-row input[type=date] { margin-top: 0; width: auto; }
      .filtro-fecha-row button { margin-top: 0; }
      .reserva-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
      .reserva-nombre { font-weight: 700; font-size: 15px; }
      .reserva-tel { font-size: 12px; color: var(--texto-tenue); margin-top: 2px; }
      .reserva-campos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
      .reserva-campos label { margin-top: 0; }
      .reserva-acciones { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
      .reserva-acciones button, .reserva-acciones a { font-size: 12.5px; padding: 7px 12px; margin-top: 0; text-decoration: none; border-radius: 8px; }
      .btn-guardar-mini { background: var(--bg-elevado); color: var(--texto); border: 1px solid var(--borde); cursor: pointer; }
      .btn-guardar-mini:hover { border-color: var(--turquesa); }
      .btn-enviar-mini { background: linear-gradient(135deg, var(--verde-wa-oscuro), var(--verde-wa)); color: #fff; border: none; cursor: pointer; }
      .btn-eliminar-mini { background: transparent; color: var(--coral); border: 1px solid var(--coral); cursor: pointer; }
      .btn-eliminar-mini:hover { background: rgba(232,103,74,0.1); }
      .link-chat-mini { background: transparent; color: var(--turquesa); border: 1px solid var(--turquesa); }
      .link-chat-mini:hover { background: rgba(18,140,126,0.1); }
      .badge-recordatorio { font-size: 10.5px; }
    </style>`,
    '</head><body>',
    '<div class="contenedor">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>📅 Reservas</h1>',
    '<p class="sub">Vista de las reservas cargadas por el agente. Podés editarlas, reenviar la confirmación por WhatsApp, o eliminarlas.</p>',
    '<div class="filtro-fecha-row">',
    '  <input type="date" id="filtroFecha" />',
    '  <button class="btn-secondary" id="btnHoy">Hoy</button>',
    '  <button class="btn-secondary" id="btnTodas">Ver todas</button>',
    '</div>',
    '<div id="msg">Cargando...</div>',
    '<div id="lista"></div>',
    '<script>',
    'var todas = [];',
    'function hoyISO() {',
    '  var d = new Date();',
    '  var tz = new Date(d.toLocaleString("en-US", {timeZone:"America/Argentina/Buenos_Aires"}));',
    '  var y = tz.getFullYear(); var m = String(tz.getMonth()+1).padStart(2,"0"); var day = String(tz.getDate()).padStart(2,"0");',
    '  return y + "-" + m + "-" + day;',
    '}',
    'document.getElementById("filtroFecha").value = hoyISO();',
    'function cargar() {',
    '  fetch("/admin/reservas-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      todas = data.reservas;',
    '      document.getElementById("msg").textContent = "";',
    '      pintar();',
    '    })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; } });',
    '}',
    'cargar();',
    'document.getElementById("btnHoy").addEventListener("click", function(){ document.getElementById("filtroFecha").value = hoyISO(); pintar(); });',
    'document.getElementById("btnTodas").addEventListener("click", function(){ document.getElementById("filtroFecha").value = ""; pintar(); });',
    'document.getElementById("filtroFecha").addEventListener("change", pintar);',
    'function pintar() {',
    '  var cont = document.getElementById("lista");',
    '  cont.innerHTML = "";',
    '  var fechaFiltro = document.getElementById("filtroFecha").value;',
    '  var lista = todas.slice();',
    '  if (fechaFiltro) lista = lista.filter(function(r){ return r.fecha === fechaFiltro; });',
    '  lista.sort(function(a,b){ return (a.fecha+a.hora).localeCompare(b.fecha+b.hora); });',
    '  if (lista.length === 0) { cont.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icono\\">📅</div>No hay reservas para mostrar.</div>"; return; }',
    '  lista.forEach(function(r) {',
    '    var div = document.createElement("div");',
    '    div.className = "card";',
    '    var badgeRec = r.recordatorioEnviado ? "<span class=\\"badge badge-alto badge-recordatorio\\">Recordatorio enviado</span>" : "<span class=\\"badge badge-pendiente badge-recordatorio\\">Sin recordatorio aún</span>";',
    '    div.innerHTML =',
    '      "<div class=\\"reserva-top\\"><div><span class=\\"reserva-nombre\\">" + (r.nombre || "(sin nombre)") + "</span><div class=\\"reserva-tel\\">+" + r.telefono + "</div></div>" + badgeRec + "</div>" +',
    '      "<div class=\\"reserva-campos\\">" +',
    '      "<div><label>Fecha</label><input type=\\"date\\" data-campo=\\"fecha\\" value=\\"" + r.fecha + "\\" /></div>" +',
    '      "<div><label>Hora</label><input type=\\"time\\" data-campo=\\"hora\\" value=\\"" + r.hora + "\\" /></div>" +',
    '      "<div><label>Personas</label><input type=\\"number\\" data-campo=\\"personas\\" value=\\"" + (r.personas || "") + "\\" /></div>" +',
    '      "<div><label>Sector</label><select data-campo=\\"sector\\">" +',
    '        ["adentro","patio","vereda"].map(function(s){ return "<option value=\\"" + s + "\\"" + (r.sector === s ? " selected" : "") + ">" + s + "</option>"; }).join("") +',
    '      "</select></div>" +',
    '      "</div>" +',
    '      "<div class=\\"reserva-acciones\\">" +',
    '      "<button class=\\"btn-guardar-mini\\" data-accion=\\"guardar\\">Guardar cambios</button>" +',
    '      "<button class=\\"btn-enviar-mini\\" data-accion=\\"enviar\\">Enviar confirmación por WhatsApp</button>" +',
    '      "<button class=\\"btn-eliminar-mini\\" data-accion=\\"eliminar\\">Eliminar</button>" +',
    '      "<a class=\\"link-chat-mini\\" href=\\"/admin/inbox?tel=" + r.telefono + "\\">Ir al chat</a>" +',
    '      "</div>";',
    '',
    '    function leerCampos() {',
    '      var campos = {};',
    '      div.querySelectorAll("[data-campo]").forEach(function(input){ campos[input.getAttribute("data-campo")] = input.value; });',
    '      return campos;',
    '    }',
    '',
    '    div.querySelector("[data-accion=guardar]").addEventListener("click", function(btn){',
    '      var campos = leerCampos();',
    '      fetch("/admin/reservas-guardar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({id: r.id, campos: campos})})',
    '        .then(function(resp){ return resp.json(); })',
    '        .then(function(){ cargar(); });',
    '    });',
    '    div.querySelector("[data-accion=enviar]").addEventListener("click", function(){',
    '      var campos = leerCampos();',
    '      var btn = div.querySelector("[data-accion=enviar]");',
    '      btn.textContent = "Enviando...";',
    '      btn.disabled = true;',
    '      fetch("/admin/reservas-enviar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({id: r.id, campos: campos})})',
    '        .then(function(resp){ return resp.json(); })',
    '        .then(function(data){ btn.textContent = data.ok ? "¡Enviado!" : "Error al enviar"; setTimeout(function(){ cargar(); }, 900); })',
    '        .catch(function(){ btn.textContent = "Error al enviar"; });',
    '    });',
    '    div.querySelector("[data-accion=eliminar]").addEventListener("click", function(){',
    '      if (!confirm("¿Eliminar esta reserva? No se puede deshacer.")) return;',
    '      fetch("/admin/reservas-eliminar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({id: r.id})})',
    '        .then(function(resp){ return resp.json(); })',
    '        .then(function(){ cargar(); });',
    '    });',
    '',
    '    cont.appendChild(div);',
    '  });',
    '}',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/reservas-data", requireAdminApi, (_req, res) => {
  res.json({ reservas: loadReservas() });
});

app.post("/admin/reservas-guardar", requireAdminApi, (req, res) => {
  try {
    const reservas = loadReservas();
    const reserva = reservas.find((r) => r.id === req.body.id);
    if (!reserva) return res.status(404).json({ error: "Reserva no encontrada" });
    const campos = req.body.campos || {};
    if (campos.fecha) reserva.fecha = campos.fecha;
    if (campos.hora) reserva.hora = campos.hora;
    if (campos.personas) reserva.personas = Number(campos.personas);
    if (campos.sector) reserva.sector = campos.sector;
    saveReservas(reservas);
    console.log(`Reserva ${reserva.id} editada manualmente desde /admin/reservas.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al guardar reserva:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

app.post("/admin/reservas-enviar", requireAdminApi, async (req, res) => {
  try {
    const reservas = loadReservas();
    const reserva = reservas.find((r) => r.id === req.body.id);
    if (!reserva) return res.status(404).json({ error: "Reserva no encontrada" });
    const campos = req.body.campos || {};
    if (campos.fecha) reserva.fecha = campos.fecha;
    if (campos.hora) reserva.hora = campos.hora;
    if (campos.personas) reserva.personas = Number(campos.personas);
    if (campos.sector) reserva.sector = campos.sector;
    saveReservas(reservas);

    const mensaje = construirMensajeConfirmacionReserva(reserva);
    const enviado = await sendWhatsappText(reserva.telefono, mensaje);
    agregarMensajeInbox(reserva.telefono, "humano", mensaje);
    console.log(`Confirmación de reserva ${reserva.id} reenviada manualmente desde /admin/reservas (${enviado ? "OK" : "FALLÓ"}).`);
    res.json({ ok: enviado });
  } catch (err) {
    console.error("Error al enviar confirmación de reserva:", err);
    res.status(500).json({ error: "No se pudo enviar" });
  }
});

app.post("/admin/reservas-eliminar", requireAdminApi, (req, res) => {
  try {
    const reservas = loadReservas();
    const actualizada = reservas.filter((r) => r.id !== req.body.id);
    saveReservas(actualizada);
    console.log(`Reserva ${req.body.id} eliminada desde /admin/reservas.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al eliminar reserva:", err);
    res.status(500).json({ error: "No se pudo eliminar" });
  }
});


app.get("/admin/inbox", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<title>Chaparrita - Atender manualmente</title>',
    `<style>${ADMIN_BASE_CSS}
      body { overflow: hidden; }
      .wa-shell { display: flex; height: 100vh; max-width: 1180px; margin: 0 auto; background: var(--bg-elevado); }

      /* ---- Barra lateral (lista de chats) ---- */
      .wa-sidebar { width: 100%; max-width: 360px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--borde); background: var(--card); }
      .wa-sidebar-header { padding: 14px 16px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--borde); flex-shrink: 0; }
      .wa-sidebar-header a.volver { padding: 6px 10px; font-size: 12px; }
      .wa-buscador-wrap { padding: 10px 12px; flex-shrink: 0; }
      .wa-buscador-wrap input { margin-top: 0; border-radius: 20px; padding: 9px 14px; font-size: 13px; }
      .wa-lista-chats { flex: 1; overflow-y: auto; }

      .wa-avatar { width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 700; color: #fff; }

      .wa-chat-item { display: flex; gap: 12px; align-items: center; padding: 11px 14px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.03); transition: background .12s ease; }
      .wa-chat-item:hover { background: var(--card-hover); }
      .wa-chat-item.activo { background: var(--card-hover); border-left: 3px solid var(--turquesa); padding-left: 11px; }
      .wa-chat-info { flex: 1; min-width: 0; }
      .wa-chat-top-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
      .wa-chat-nombre { font-weight: 600; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .wa-chat-hora { font-size: 11px; color: var(--texto-tenue); flex-shrink: 0; }
      .wa-chat-preview-row { display: flex; justify-content: space-between; align-items: center; margin-top: 3px; gap: 6px; }
      .wa-chat-preview { font-size: 12.5px; color: var(--texto-tenue); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .wa-manual-pill { background: rgba(224,163,36,0.18); color: var(--ocre); font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 10px; flex-shrink: 0; }

      /* ---- Panel de conversación ---- */
      .wa-main { flex: 1; display: flex; flex-direction: column; min-width: 0; background:
          radial-gradient(circle at 8px 8px, rgba(17,27,33,0.035) 1.4px, transparent 1.6px);
          background-size: 26px 26px; background-color: #EFEAE2; }
      .wa-main-header { display: flex; align-items: center; gap: 12px; padding: 11px 18px; background: var(--card); border-bottom: 1px solid var(--borde); flex-shrink: 0; }
      .wa-main-header .wa-btn-volver-movil { display: none; background: none; border: none; color: var(--texto); font-size: 18px; cursor: pointer; margin: 0; padding: 0; }
      .wa-main-header-info b { display: block; font-size: 14.5px; }
      .wa-main-header-info span { font-size: 11.5px; color: var(--texto-tenue); }
      .wa-toggle-manual { margin-left: auto; display: flex; align-items: center; gap: 8px; }
      .wa-toggle-manual span { font-size: 11.5px; color: var(--texto-tenue); text-align: right; max-width: 110px; line-height: 1.3; }

      .wa-mensajes { flex: 1; overflow-y: auto; padding: 18px 24px; display: flex; flex-direction: column; gap: 3px; }
      .wa-fila { display: flex; }
      .wa-fila.entrante { justify-content: flex-start; }
      .wa-fila.saliente { justify-content: flex-end; }
      .wa-burbuja { max-width: 62%; padding: 7px 10px 6px; border-radius: 9px; font-size: 13.8px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; box-shadow: 0 1px 1.5px rgba(17,27,33,0.13); position: relative; }
      .wa-fila.entrante .wa-burbuja { background: #FFFFFF; color: var(--texto); border-top-left-radius: 2px; }
      .wa-fila.saliente .wa-burbuja { background: #D9FDD3; color: #111B21; border-top-right-radius: 2px; }
      .wa-meta { display: flex; align-items: center; gap: 4px; justify-content: flex-end; margin-top: 3px; font-size: 10.5px; color: rgba(17,27,33,0.45); }
      .wa-fila.entrante .wa-meta { color: var(--texto-tenue); }
      .wa-check { color: #53BDEB; font-size: 12px; }
      .wa-autor { font-size: 10px; opacity: 0.7; }

      .wa-compose { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--card); border-top: 1px solid var(--borde); flex-shrink: 0; }
      .wa-compose input { margin-top: 0; border-radius: 22px; padding: 11px 16px; font-size: 13.8px; }
      .wa-btn-enviar { width: 42px; height: 42px; border-radius: 50%; border: none; background: linear-gradient(135deg, var(--verde-wa-oscuro), var(--verde-wa)); color: #fff; font-size: 16px; cursor: pointer; margin: 0; flex-shrink: 0; }

      .wa-estado-vacio { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--texto-tenue); text-align: center; padding: 20px; }
      .wa-estado-vacio .icono { font-size: 46px; margin-bottom: 14px; opacity: 0.5; }
      .wa-estado-vacio b { color: var(--texto); font-size: 15px; display: block; margin-bottom: 4px; }

      @media (max-width: 860px) {
        .wa-shell { display: block; height: 100vh; }
        .wa-sidebar { max-width: none; height: 100vh; }
        .wa-sidebar.wa-oculta-movil { display: none; }
        .wa-main { display: none; position: fixed; inset: 0; z-index: 5; }
        .wa-main.wa-main-visible { display: flex; }
        .wa-main-header .wa-btn-volver-movil { display: block; }
      }
    </style>`,
    '</head><body>',
    '<div class="wa-shell">',
    '  <div class="wa-sidebar" id="listaChats">',
    '    <div class="wa-sidebar-header">',
    '      <a class="volver" href="/admin">←</a>',
    '      <b>💬 Atender manualmente</b>',
    '    </div>',
    '    <div class="wa-buscador-wrap"><input type="text" id="buscadorChats" placeholder="Buscar conversación..." /></div>',
    '    <div id="msg" style="padding:0 16px;">Cargando...</div>',
    '    <div class="wa-lista-chats" id="listaChatsCont"></div>',
    '  </div>',
    '  <div class="wa-main" id="vistaChat">',
    '    <div class="wa-estado-vacio" id="estadoVacioChat">',
    '      <div class="icono">💬</div>',
    '      <b>Elegí una conversación</b>',
    '      Los mensajes que mandes acá salen directo por WhatsApp, como si los mandara Chaparrita.',
    '    </div>',
    '    <div id="chatAbierto" style="display:none;flex:1;display:flex;flex-direction:column;min-height:0;">',
    '      <div class="wa-main-header">',
    '        <button class="wa-btn-volver-movil" id="btnVolverLista">←</button>',
    '        <div class="wa-avatar" id="avatarChatActivo">?</div>',
    '        <div class="wa-main-header-info"><b id="nombreChatActivo">-</b><span id="telChatActivo"></span></div>',
    '        <div class="wa-toggle-manual">',
    '          <span>Modo manual<br/>(el bot no responde)</span>',
    '          <label class="toggle-switch"><input type="checkbox" id="chkManual" /><span class="toggle-slider"></span></label>',
    '        </div>',
    '      </div>',
    '      <div class="wa-mensajes" id="mensajes"></div>',
    '      <div class="wa-compose">',
    '        <input type="text" id="textoAEnviar" placeholder="Escribí un mensaje..." />',
    '        <button class="wa-btn-enviar" id="btnEnviar">➤</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '</div>',
    '<script>',
    'var telefonoActivo = null;',
    'var todosLosChats = [];',
    'var COLORES_AVATAR = ["#E8674A","#2F9C95","#E0A324","#A93B3B","#6B4FA0","#3B7DA9"];',
    'function colorAvatar(texto) {',
    '  var suma = 0; for (var i = 0; i < texto.length; i++) suma += texto.charCodeAt(i);',
    '  return COLORES_AVATAR[suma % COLORES_AVATAR.length];',
    '}',
    'function inicial(nombre, telefono) {',
    '  var base = (nombre || telefono || "?").trim();',
    '  return base.charAt(0).toUpperCase();',
    '}',
    'function cargarLista() {',
    '  fetch("/admin/inbox-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      document.getElementById("msg").textContent = "";',
    '      todosLosChats = data.chats;',
    '      var telParam = new URLSearchParams(window.location.search).get("tel");',
    '      pintarLista(todosLosChats);',
    '      if (telParam) { abrirChat(telParam); }',
    '    })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; } });',
    '}',
    'cargarLista();',
    'document.getElementById("buscadorChats").addEventListener("input", function() {',
    '  var q = this.value.toLowerCase();',
    '  var filtrados = todosLosChats.filter(function(c) { return (c.nombre||"").toLowerCase().indexOf(q) !== -1 || (c.telefono||"").indexOf(q) !== -1; });',
    '  pintarLista(filtrados);',
    '});',
    'function pintarLista(chats) {',
    '  var cont = document.getElementById("listaChatsCont");',
    '  cont.innerHTML = "";',
    '  var ordenados = chats.slice().sort(function(a,b){ return new Date(b.ultimaActividad) - new Date(a.ultimaActividad); });',
    '  if (ordenados.length === 0) { cont.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icono\\">💬</div>Todavía no hay conversaciones guardadas.</div>"; return; }',
    '  ordenados.forEach(function(c) {',
    '    var div = document.createElement("div");',
    '    div.className = "wa-chat-item" + (c.telefono === telefonoActivo ? " activo" : "");',
    '    var ultimoMsg = c.mensajes.length ? c.mensajes[c.mensajes.length - 1] : null;',
    '    var horaTxt = ultimoMsg ? new Date(ultimoMsg.fecha).toLocaleTimeString("es-AR", {hour:"2-digit", minute:"2-digit"}) : "";',
    '    var pill = c.modoManual ? "<span class=\\"wa-manual-pill\\">MANUAL</span>" : "";',
    '    var av = document.createElement("div");',
    '    av.className = "wa-avatar"; av.style.background = colorAvatar(c.telefono); av.textContent = inicial(c.nombre, c.telefono);',
    '    var info = document.createElement("div");',
    '    info.className = "wa-chat-info";',
    '    info.innerHTML = "<div class=\\"wa-chat-top-row\\"><span class=\\"wa-chat-nombre\\">" + (c.nombre || ("+" + c.telefono)) + "</span><span class=\\"wa-chat-hora\\">" + horaTxt + "</span></div>" +',
    '      "<div class=\\"wa-chat-preview-row\\"><span class=\\"wa-chat-preview\\">" + (ultimoMsg ? ultimoMsg.texto.replace(/</g,"&lt;") : "") + "</span>" + pill + "</div>";',
    '    div.appendChild(av); div.appendChild(info);',
    '    div.addEventListener("click", function(){ abrirChat(c.telefono); });',
    '    cont.appendChild(div);',
    '  });',
    '}',
    'function abrirChat(telefono) {',
    '  telefonoActivo = telefono;',
    '  document.getElementById("vistaChat").classList.add("wa-main-visible");',
    '  document.getElementById("listaChats").classList.add("wa-oculta-movil");',
    '  fetch("/admin/inbox-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      todosLosChats = data.chats;',
    '      var chat = data.chats.find(function(c){ return c.telefono === telefono; });',
    '      if (!chat) return;',
    '      document.getElementById("estadoVacioChat").style.display = "none";',
    '      document.getElementById("chatAbierto").style.display = "flex";',
    '      document.getElementById("nombreChatActivo").textContent = chat.nombre || ("+" + chat.telefono);',
    '      document.getElementById("telChatActivo").textContent = "+" + chat.telefono;',
    '      var av = document.getElementById("avatarChatActivo");',
    '      av.style.background = colorAvatar(chat.telefono); av.textContent = inicial(chat.nombre, chat.telefono);',
    '      document.getElementById("chkManual").checked = !!chat.modoManual;',
    '      pintarMensajes(chat.mensajes);',
    '      pintarLista(todosLosChats);',
    '    });',
    '}',
    'function pintarMensajes(mensajes) {',
    '  var cont = document.getElementById("mensajes");',
    '  cont.innerHTML = "";',
    '  mensajes.forEach(function(m) {',
    '    var esSaliente = m.rol !== "cliente";',
    '    var fila = document.createElement("div");',
    '    fila.className = "wa-fila " + (esSaliente ? "saliente" : "entrante");',
    '    var hora = new Date(m.fecha).toLocaleTimeString("es-AR", {hour:"2-digit", minute:"2-digit"});',
    '    var meta = esSaliente',
    '      ? hora + " <span class=\\"wa-check\\">✓✓</span>" + (m.rol === "humano" ? " <span class=\\"wa-autor\\">· vos</span>" : "")',
    '      : hora;',
    '    fila.innerHTML = "<div class=\\"wa-burbuja\\">" + m.texto.replace(/</g,"&lt;") + "<div class=\\"wa-meta\\">" + meta + "</div></div>";',
    '    cont.appendChild(fila);',
    '  });',
    '  cont.scrollTop = cont.scrollHeight;',
    '}',
    'document.getElementById("btnVolverLista").addEventListener("click", function(){',
    '  document.getElementById("vistaChat").classList.remove("wa-main-visible");',
    '  document.getElementById("listaChats").classList.remove("wa-oculta-movil");',
    '  telefonoActivo = null;',
    '});',
    'document.getElementById("chkManual").addEventListener("change", function() {',
    '  var activo = this.checked;',
    '  fetch("/admin/inbox-toggle-manual", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({telefono: telefonoActivo, modoManual: activo})})',
    '    .then(function(r){ return r.json(); })',
    '    .catch(function(){});',
    '});',
    'document.getElementById("btnEnviar").addEventListener("click", enviarMensaje);',
    'document.getElementById("textoAEnviar").addEventListener("keydown", function(e){ if (e.key === "Enter") enviarMensaje(); });',
    'function enviarMensaje() {',
    '  var input = document.getElementById("textoAEnviar");',
    '  var texto = input.value.trim();',
    '  if (!texto || !telefonoActivo) return;',
    '  input.value = "";',
    '  fetch("/admin/inbox-send", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({telefono: telefonoActivo, mensaje: texto})})',
    '    .then(function(r){ if (!r.ok) { throw new Error("No se pudo enviar"); } return r.json(); })',
    '    .then(function(){ abrirChat(telefonoActivo); })',
    '    .catch(function(e){ alert("Error al enviar: " + e.message); });',
    '}',
    '</' + 'script>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/inbox-data", requireAdminApi, (req, res) => {
  const inbox = loadInbox();
  res.json({ chats: Object.values(inbox) });
});

app.post("/admin/inbox-toggle-manual", requireAdminApi, (req, res) => {
  try {
    const inbox = loadInbox();
    const tel = soloDigitos(req.body.telefono);
    if (!inbox[tel]) {
      return res.status(404).json({ error: "Chat no encontrado" });
    }
    inbox[tel].modoManual = !!req.body.modoManual;
    saveInbox(inbox);
    console.log(`Chat con ${tel} pasó a modo ${inbox[tel].modoManual ? "MANUAL" : "AUTOMÁTICO"} desde /admin/inbox.`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al cambiar modo manual:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

app.post("/admin/inbox-send", requireAdminApi, async (req, res) => {
  try {
    const telefono = req.body.telefono;
    const mensaje = (req.body.mensaje || "").trim();
    if (!telefono || !mensaje) {
      return res.status(400).json({ error: "Falta teléfono o mensaje" });
    }
    const enviado = await sendWhatsappText(telefono, mensaje);
    if (!enviado) {
      return res.status(502).json({ error: "No se pudo enviar el mensaje por WhatsApp" });
    }
    agregarMensajeInbox(telefono, "humano", mensaje);

    // También lo sumamos al historial que usa Claude, para que si el chat vuelve a modo
    // automático más tarde, el bot tenga contexto de lo que ya se le contestó a mano.
    const history = conversations.get(soloDigitos(telefono)) || conversations.get(telefono) || [];
    history.push({ role: "assistant", content: [{ type: "text", text: mensaje }] });
    conversations.set(telefono, history);

    res.json({ ok: true });
  } catch (err) {
    console.error("Error al enviar mensaje manual:", err);
    res.status(500).json({ error: "No se pudo enviar" });
  }
});

app.get("/admin/switch", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<title>Chaparrita - Prender o apagar</title>',
    `<style>${ADMIN_BASE_CSS}
      .estado-card { display: flex; align-items: center; justify-content: space-between; padding: 22px 20px; }
      .estado-info b { display: block; font-size: 16px; margin-bottom: 4px; }
      .estado-info span { font-size: 12.5px; color: var(--texto-tenue); }
    </style>`,
    '</head><body>',
    '<div class="contenedor">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>🔌 Prender / apagar el asistente</h1>',
    '<p class="sub">Mientras está apagado, Chaparrita no responde nada por WhatsApp — queda todo para que lo atienda un operador a mano.</p>',
    '<div class="card estado-card" id="estado" style="display:none">',
    '  <div class="estado-info"><b id="estadoTexto">...</b><span>Tocá el switch para cambiar</span></div>',
    '  <label class="toggle-switch"><input type="checkbox" id="chkToggle" /><span class="toggle-slider"></span></label>',
    '</div>',
    '<div id="msg">Cargando...</div>',
    '<script>',
    'var activo = null;',
    'function pintar() {',
    '  var texto = document.getElementById("estadoTexto");',
    '  var chk = document.getElementById("chkToggle");',
    '  chk.checked = !!activo;',
    '  texto.textContent = activo ? "🟢 Asistente ENCENDIDO" : "🔴 Asistente APAGADO";',
    '}',
    'function cargar() {',
    '  fetch("/admin/switch-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){ activo = data.activo; pintar(); document.getElementById("estado").style.display = "flex"; document.getElementById("msg").textContent = ""; })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; } });',
    '}',
    'cargar();',
    'document.getElementById("chkToggle").addEventListener("change", function() {',
    '  var nuevoValor = this.checked;',
    '  fetch("/admin/switch-save", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({activo: nuevoValor})})',
    '    .then(function(r){ if (!r.ok) { throw new Error("No se pudo guardar"); } return r.json(); })',
    '    .then(function(){ activo = nuevoValor; pintar(); document.getElementById("msg").textContent = "Listo, se guardó."; document.getElementById("msg").className = "msg-ok"; })',
    '    .catch(function(e){ document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; });',
    '});',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/switch-data", requireAdminApi, (req, res) => {
  const config = loadConfig();
  res.json({ activo: config.asistenteActivo !== false });
});

app.post("/admin/switch-save", requireAdminApi, (req, res) => {
  const config = loadConfig();
  config.asistenteActivo = !!req.body.activo;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  console.log(`Asistente ${config.asistenteActivo ? "ENCENDIDO" : "APAGADO"} desde /admin/switch.`);
  res.json({ ok: true, activo: config.asistenteActivo });
});

// ==================== Editor de configuración (precios, promos, teléfonos, horarios) ====================
app.get("/admin/config", requireAdminPage, (_req, res) => {
  res.type("html").send(ADMIN_CONFIG_PAGE);
});

app.post("/admin/config-data", requireAdminApi, (req, res) => {
  res.json(loadConfig());
});

app.post("/admin/config-save", requireAdminApi, (req, res) => {
  try {
    const nuevaConfig = req.body.config;
    if (!nuevaConfig || typeof nuevaConfig !== "object") {
      return res.status(400).json({ error: "Config inválida" });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(nuevaConfig, null, 2), "utf8");
    console.log("Configuración actualizada desde /admin/config.");
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al guardar config:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

// Fuerza a copiar el config.json que viene con el código (el del repo) al volumen persistente,
// pisando lo que haya ahí guardado. Útil cuando el volumen quedó con datos viejos.
app.post("/admin/config-reset-from-repo", requireAdminApi, (req, res) => {
  try {
    if (!fs.existsSync(LEGACY_CONFIG_PATH)) {
      return res.status(404).json({ error: "No se encontró config.json en el repo" });
    }
    fs.copyFileSync(LEGACY_CONFIG_PATH, CONFIG_PATH);
    console.log("Config restaurada a la fuerza desde el config.json del repositorio.");
    res.json({ ok: true, config: loadConfig() });
  } catch (err) {
    console.error("Error al restaurar config desde el repo:", err);
    res.status(500).json({ error: "No se pudo restaurar" });
  }
});

// ==================== Clientes inactivos (dejaron de pedir) ====================
const PISO_MINIMO_DIAS_INACTIVO = 15;

function calcularClientesInactivos(clientes) {
  const ahoraMs = Date.now();
  return clientes
    .map((c) => {
      const pedidos = (c.historialPedidos || []).slice().sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
      if (pedidos.length < 3) return null; // necesitamos al menos 3 pedidos para calcular un ritmo real

      const fechasMs = pedidos.map((p) => new Date(p.fecha).getTime()).filter((t) => !isNaN(t));
      if (fechasMs.length < 3) return null;

      const intervalos = [];
      for (let i = 1; i < fechasMs.length; i++) intervalos.push(fechasMs[i] - fechasMs[i - 1]);
      const promedioDias = intervalos.reduce((a, b) => a + b, 0) / intervalos.length / (1000 * 60 * 60 * 24);

      const ultimaFechaMs = fechasMs[fechasMs.length - 1];
      const diasSinPedir = (ahoraMs - ultimaFechaMs) / (1000 * 60 * 60 * 24);
      const umbral = Math.max(PISO_MINIMO_DIAS_INACTIVO, promedioDias * 2);

      if (diasSinPedir < umbral) return null;

      return {
        nombre: c.nombre || "(sin nombre)",
        telefono: c.telefono,
        diasSinPedir: Math.round(diasSinPedir),
        promedioDias: Math.round(promedioDias),
        ultimoPedido: pedidos[pedidos.length - 1].resumen || "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.diasSinPedir - a.diasSinPedir);
}

function construirMensajeInactivos(inactivos) {
  let mensaje = `📉 *Clientes que dejaron de pedir* (${inactivos.length})\n\n`;
  inactivos.forEach((c) => {
    mensaje += `👤 *${c.nombre}* (+${c.telefono})\n`;
    mensaje += `Pedía cada ~${c.promedioDias} días, hace ${c.diasSinPedir} días que no pide.\n`;
    mensaje += `Último pedido: ${c.ultimoPedido}\n\n`;
  });
  mensaje += `Ofreceles un 10% OFF en el próximo pedido si querés reactivarlos 🌮`;
  return mensaje;
}

app.get("/admin/inactivos", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<title>Chaparrita - Clientes inactivos</title>',
    `<style>${ADMIN_BASE_CSS}
      .inactivo-nombre { font-weight: 700; font-size: 15px; }
      .inactivo-tel { font-size: 12px; color: var(--texto-tenue); margin-top: 2px; }
      .inactivo-detalle { font-size: 12.5px; margin-top: 6px; color: var(--texto-tenue); line-height: 1.5; }
    </style>`,
    '</head><body>',
    '<div class="contenedor">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>📉 Clientes inactivos</h1>',
    '<p class="sub">Detecta clientes que pedían regularmente y hace rato no piden. Al revisar, también te llega un aviso a WhatsApp con la lista.</p>',
    '<button class="btn-primary" id="btnVer">Revisar clientes inactivos</button>',
    '<div id="msg"></div>',
    '<div id="lista"></div>',
    '<script>',
    'document.getElementById("btnVer").addEventListener("click", function() {',
    '  document.getElementById("msg").textContent = "Revisando...";',
    '  document.getElementById("msg").className = "";',
    '  fetch("/admin/inactivos-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      var cont = document.getElementById("lista");',
    '      cont.innerHTML = "";',
    '      data.inactivos.forEach(function(c) {',
    '        var div = document.createElement("div");',
    '        div.className = "card";',
    '        div.innerHTML = "<span class=\\"inactivo-nombre\\">" + c.nombre + "</span><div class=\\"inactivo-tel\\">+" + c.telefono + "</div>" +',
    '          "<div class=\\"inactivo-detalle\\">Pedía cada ~" + c.promedioDias + " días · hace " + c.diasSinPedir + " días que no pide</div>" +',
    '          "<div class=\\"inactivo-detalle\\">Último pedido: " + c.ultimoPedido + "</div>";',
    '        cont.appendChild(div);',
    '      });',
    '      if (data.inactivos.length === 0) { cont.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icono\\">✨</div>No se encontraron clientes inactivos por ahora.</div>"; }',
    '      var txt = data.inactivos.length + " clientes inactivos encontrados.";',
    '      txt += data.avisoEnviado ? " Te mandamos el resumen por WhatsApp." : (data.inactivos.length > 0 ? " (No se pudo mandar el WhatsApp — revisá el teléfono del dueño en Configuración.)" : "");',
    '      document.getElementById("msg").textContent = txt;',
    '      document.getElementById("msg").className = "msg-ok";',
    '    })',
    '    .catch(function(e){ document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; });',
    '});',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/inactivos-data", requireAdminApi, async (req, res) => {
  try {
    const clientes = loadClientes();
    const inactivos = calcularClientesInactivos(clientes);
    const config = loadConfig();
    const telefonoDestino = soloDigitos((config.staff && config.staff.dueño && config.staff.dueño.telefono) || "");

    let avisoEnviado = false;
    if (inactivos.length > 0 && telefonoDestino && telefonoDestino.length >= 10) {
      const mensaje = construirMensajeInactivos(inactivos);
      avisoEnviado = await sendWhatsappText(telefonoDestino, mensaje);
    }

    res.json({ inactivos, avisoEnviado });
  } catch (err) {
    console.error("Error calculando clientes inactivos:", err);
    res.status(500).json({ error: "No se pudo calcular" });
  }
});

// ==================== Recordatorio automático 1 hora antes de la reserva ====================
async function chequearRecordatorios() {
  try {
    const reservas = loadReservas();
    if (reservas.length === 0) return;
    const ahoraMs = Date.now();
    let huboCambios = false;

    for (const r of reservas) {
      if (r.recordatorioEnviado) continue;
      let targetMs;
      try {
        targetMs = new Date(`${r.fecha}T${r.hora}:00-03:00`).getTime();
      } catch {
        r.recordatorioEnviado = true; // fecha/hora mal formada, no reintentamos
        huboCambios = true;
        continue;
      }
      if (isNaN(targetMs)) {
        r.recordatorioEnviado = true;
        huboCambios = true;
        continue;
      }
      const minutosFaltantes = (targetMs - ahoraMs) / 60000;

      if (minutosFaltantes <= 65 && minutosFaltantes > -30) {
        const nombre = r.nombre ? r.nombre.split(" ")[0] : "";
        const personasTxt = r.personas ? `para ${r.personas} personas` : "";
        const mensaje =
          `¡Hola ${nombre ? nombre + "!" : "!"} 👋 Te escribimos de Chaparrita para confirmar tu reserva de hoy a las ${r.hora}hs ${personasTxt}.\n\n` +
          `¿Nos confirmás que llegan a ese horario y con esa cantidad de personas?\n\n` +
          `Te recordamos que el monto que ya quedó confirmado se abona igual, aunque no lleguen a venir todos los invitados. ¡Te esperamos! 🌮`;
        const enviado = await sendWhatsappText(r.telefono, mensaje);
        if (enviado) {
          r.recordatorioEnviado = true;
          huboCambios = true;
          console.log(`Recordatorio de reserva enviado a ${r.telefono} (${r.nombre || "sin nombre"}, ${r.fecha} ${r.hora}hs).`);
        } else {
          console.log(`No se pudo enviar el recordatorio a ${r.telefono} — se reintenta en el próximo chequeo.`);
        }
      } else if (minutosFaltantes <= -30) {
        // Ya pasó de largo (por ejemplo si el servidor estuvo apagado) — no lo mandamos tarde.
        r.recordatorioEnviado = true;
        huboCambios = true;
      }
    }

    if (huboCambios) saveReservas(reservas);
  } catch (err) {
    console.error("Error chequeando recordatorios de reserva:", err);
  }
}

setInterval(chequearRecordatorios, 5 * 60 * 1000); // cada 5 minutos
setTimeout(chequearRecordatorios, 15 * 1000); // y un primer chequeo a los 15seg de arrancar

// ==================== Aviso diario de cumpleaños próximos ====================
let ultimoAvisoCumpleañosFecha = null; // para no mandar el aviso dos veces el mismo día

async function chequearAvisoCumpleañosDiario() {
  try {
    const config = loadConfig();
    const cfg = config.avisoCumpleañosDiario;
    if (!cfg || cfg.activo === false) return;

    const fechaHoy = fechaDeHoyISOArgentina();
    const horaActual = horaActualArgentina();
    if (ultimoAvisoCumpleañosFecha === fechaHoy) return; // ya se mandó hoy
    if (horaActual < (cfg.hora || "09:00")) return; // todavía no es la hora configurada

    const clientes = loadClientes();
    const conCumple = clientes.filter((c) => c.cumpleanos);
    if (conCumple.length === 0) {
      ultimoAvisoCumpleañosFecha = fechaHoy;
      return;
    }

    const hoy = conCumple.filter((c) => esCumpleañosHoy(c.cumpleanos, fechaHoy));
    const proximos = conCumple
      .map((c) => ({ ...c, diasFaltan: diasHastaProximoCumple(c.cumpleanos, fechaHoy) }))
      .filter((c) => c.diasFaltan !== null && c.diasFaltan > 0 && c.diasFaltan <= 7)
      .sort((a, b) => a.diasFaltan - b.diasFaltan);

    if (hoy.length === 0 && proximos.length === 0) {
      ultimoAvisoCumpleañosFecha = fechaHoy;
      return;
    }

    let mensaje = "🎂 *Cumpleaños de clientes*\n\n";
    if (hoy.length > 0) {
      mensaje += "*¡Hoy cumplen!*\n";
      hoy.forEach((c) => {
        mensaje += `- ${c.nombre || "(sin nombre)"} (+${c.telefono})\n`;
      });
      mensaje += "\n";
    }
    if (proximos.length > 0) {
      mensaje += "*Esta semana:*\n";
      proximos.forEach((c) => {
        mensaje += `- ${c.nombre || "(sin nombre)"} en ${c.diasFaltan} día${c.diasFaltan === 1 ? "" : "s"} (+${c.telefono})\n`;
      });
    }

    const telefonoDestino = soloDigitos(cfg.telefono) || soloDigitos((config.staff && config.staff.dueño && config.staff.dueño.telefono) || "");
    if (telefonoDestino && telefonoDestino.length >= 10) {
      const enviado = await sendWhatsappText(telefonoDestino, mensaje);
      if (enviado) {
        ultimoAvisoCumpleañosFecha = fechaHoy;
        console.log("Aviso diario de cumpleaños enviado.");
      } else {
        console.log("No se pudo enviar el aviso diario de cumpleaños — se reintenta en el próximo chequeo.");
      }
    } else {
      console.log("Aviso diario de cumpleaños: no hay teléfono configurado (ni dueño cargado) para mandarlo.");
      ultimoAvisoCumpleañosFecha = fechaHoy;
    }
  } catch (err) {
    console.error("Error chequeando aviso diario de cumpleaños:", err);
  }
}

setInterval(chequearAvisoCumpleañosDiario, 5 * 60 * 1000); // cada 5 minutos
setTimeout(chequearAvisoCumpleañosDiario, 20 * 1000); // primer chequeo a los 20seg de arrancar

// ==================== Oferta proactiva al cliente cuando falta ~1 semana para su cumpleaños ====================
async function chequearOfertaCumpleañosProximo() {
  try {
    const config = loadConfig();
    const cfg = config.ofertaCumpleañosProximo || { activo: true, diasAntes: 7 };
    if (cfg.activo === false) return;

    const fechaHoy = fechaDeHoyISOArgentina();
    const diasAntes = cfg.diasAntes || 7;
    const clientes = loadClientes();
    let huboCambios = false;

    for (const c of clientes) {
      if (!c.cumpleanos) continue;
      const dias = diasHastaProximoCumple(c.cumpleanos, fechaHoy);
      const fechaObjetivo = proximoCumpleISO(c.cumpleanos, fechaHoy);
      if (dias !== diasAntes) continue;
      if (c.ofertaCumpleEnviadaPara === fechaObjetivo) continue; // ya le mandamos la oferta para este cumpleaños

      const cumpleCfg = config.cumpleañosCliente || {};
      const nombre = c.nombre ? c.nombre.split(" ")[0] : "";
      const mensaje =
        `¡Hola${nombre ? " " + nombre : ""}! 🎉 Nos dimos cuenta que tu cumple se viene la semana que entra — ¡queremos que lo festejes con nosotros en Chaparrita! 🌮\n\n` +
        `Tenés dos opciones:\n` +
        `1) Reservás una mesa para vos y los tuyos, comés rico, y te hacemos un ${cumpleCfg.descuentoPorcentaje || 10}% de descuento en la cuenta${cumpleCfg.shotsTequilaSiFestejaEnLocal !== false ? " + una ronda de shots de tequila para brindar 🥂" : ""}.\n` +
        `2) Si armás algo más grande con más invitados, tenemos promos especiales de cumpleaños "Todo Incluido" (pizza, tacos, hamburguesas o lomitos + bebidas + brindis + torta).\n\n` +
        `¿Te gustaría reservar? Contanos la fecha, el horario y cuántos son, y lo dejamos todo listo 🙌`;

      const enviado = await sendWhatsappText(c.telefono, mensaje);
      if (enviado) {
        c.ofertaCumpleEnviadaPara = fechaObjetivo;
        huboCambios = true;
        console.log(`Oferta de cumpleaños próximo enviada a ${c.telefono} (${c.nombre || "sin nombre"}).`);
      } else {
        console.log(`No se pudo enviar la oferta de cumpleaños a ${c.telefono} — se reintenta en el próximo chequeo.`);
      }
    }

    if (huboCambios) saveClientes(clientes);
  } catch (err) {
    console.error("Error chequeando oferta de cumpleaños próximo:", err);
  }
}

setInterval(chequearOfertaCumpleañosProximo, 5 * 60 * 1000); // cada 5 minutos
setTimeout(chequearOfertaCumpleañosProximo, 25 * 1000); // primer chequeo a los 25seg de arrancar

// ==================== Lista de espera de mesas: avisar cuando se libera un lugar ====================
async function chequearListaEspera() {
  try {
    const listaEspera = loadListaEspera();
    const pendientes = listaEspera.filter((e) => e.estado === "esperando" && !e.notificado);
    if (pendientes.length === 0) return;

    const config = loadConfig();
    const reservas = loadReservas();
    let huboCambios = false;

    for (const espera of pendientes) {
      if (!SECTORES_VALIDOS.includes(espera.sector) || !espera.fecha || !espera.hora) continue;
      const disponibilidad = calcularDisponibilidad(config, reservas, espera.sector, espera.fecha, espera.hora);
      if (disponibilidad.libres > 0) {
        const nombre = espera.nombre ? espera.nombre.split(" ")[0] : "";
        const mensaje =
          `¡Buenas noticias${nombre ? ", " + nombre : ""}! 🎉 Se liberó una mesa en el sector ${espera.sector} para el ${espera.fecha} a las ${espera.hora}hs, justo lo que estabas esperando.\n\n` +
          `¿Confirmamos tu reserva? Respondeme por acá así te la dejamos anotada — si no llego a tener noticias tuyas en un rato, se la ofrecemos a la siguiente persona en la lista.`;
        const enviado = await sendWhatsappText(espera.telefono, mensaje);
        if (enviado) {
          espera.notificado = true;
          espera.notificadoEn = new Date().toISOString();
          huboCambios = true;
          console.log(`Aviso de lista de espera enviado a ${espera.telefono} (${espera.nombre || "sin nombre"}, sector ${espera.sector}).`);
        } else {
          console.log(`No se pudo avisar a ${espera.telefono} de la lista de espera — se reintenta en el próximo chequeo.`);
        }
      }
    }

    if (huboCambios) saveListaEspera(listaEspera);
  } catch (err) {
    console.error("Error chequeando lista de espera de mesas:", err);
  }
}

setInterval(chequearListaEspera, 15 * 60 * 1000); // cada 15 minutos
setTimeout(chequearListaEspera, 30 * 1000); // primer chequeo a los 30seg de arrancar

app.listen(PORT, () => console.log(`Chaparrita backend escuchando en el puerto ${PORT}`));
