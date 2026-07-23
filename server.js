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

function diaDeHoyArgentina() {
  const dia = new Intl.DateTimeFormat("es-AR", { weekday: "long", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  return dia.charAt(0).toUpperCase() + dia.slice(1);
}

function fechaDeHoyISOArgentina() {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date()); // en-CA da directo formato YYYY-MM-DD
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

const ADMIN_CONFIG_PAGE = [
  '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
  '<title>Chaparrita - Editar configuracion</title>',
  '<style>',
  'body{font-family:sans-serif;max-width:640px;margin:30px auto;padding:0 16px;color:#2b2118;}',
  'h1{font-size:20px}h2{font-size:16px;color:#C0392B;margin-top:28px;border-bottom:1px solid #E9DCC7;padding-bottom:6px}',
  'label{font-weight:bold;font-size:12px;display:block;margin-top:10px}',
  'input[type=text],input[type=number],input[type=password],textarea{font-size:14px;padding:8px;width:100%;box-sizing:border-box;margin-top:4px;border:1px solid #E9DCC7;border-radius:6px}',
  'textarea{min-height:60px}',
  'button{font-size:14px;padding:9px 14px;border:none;border-radius:6px;cursor:pointer;margin-top:8px}',
  '.btn-primary{background:#C0392B;color:#fff}',
  '.btn-secondary{background:#F0EBE3;color:#2b2118}',
  '.btn-danger{background:transparent;color:#C0392B;padding:4px 8px}',
  '.card{background:#F6EEDF;border:1px solid #E9DCC7;border-radius:8px;padding:12px;margin-top:10px}',
  '.row{display:flex;gap:8px}.row>*{flex:1}',
  'a.back{color:#C0392B;text-decoration:none;font-size:13px}',
  '#msg{margin-top:14px;font-weight:bold}',
  '#gate{margin-top:20px}',
  '#formArea{display:none}',
  '.tag{display:inline-flex;align-items:center;gap:6px;background:#F6EEDF;border:1px solid #E9DCC7;border-radius:16px;padding:4px 10px;margin:4px 6px 0 0;font-size:13px}',
  '</style></head><body>',
  '<a class="back" href="/admin">&larr; Volver al panel</a>',
  '<h1>Editar precios, horarios, promos y telefonos</h1>',
  '<div id="gate">',
  '<label>Contrasena de administrador</label>',
  '<input type="password" id="password" />',
  '<button class="btn-primary" id="btnCargar">Cargar configuracion</button>',
  '</div>',
  '<div id="msg"></div>',
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
  'document.getElementById("btnCargar").addEventListener("click", function() {',
  '  var pw = document.getElementById("password").value;',
  '  fetch("/admin/config-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password: pw})})',
  '    .then(function(r){ if (!r.ok) { throw new Error("Contrasena incorrecta"); } return r.json(); })',
  '    .then(function(data){ cfg = data; cfg.__pw = pw; renderForm(); document.getElementById("gate").style.display="none"; document.getElementById("formArea").style.display="block"; document.getElementById("msg").textContent=""; })',
  '    .catch(function(e){ document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").style.color = "#C0392B"; });',
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
  '  area.appendChild(el("div", {class:"row"}, [field("Nombre cajera/o", cajNombre), field("Telefono (con 549...)", cajTel)]));',
  '  area.appendChild(el("div", {class:"row"}, [field("Nombre dueno/a", duenoNombre), field("Telefono (con 549...)", duenoTel)]));',
  '',
  '  var grupoInput = textInput(cfg.grupoReservasWhatsappId);',
  '  area.appendChild(field("ID de WhatsApp del grupo Reservas Chaparrita", grupoInput));',
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
  '  var btnGuardar = el("button", {type:"button", text:"Guardar todos los cambios", class:"btn-primary"});',
  '  btnGuardar.style.marginTop = "24px";',
  '  btnGuardar.style.width = "100%";',
  '  btnGuardar.addEventListener("click", function() {',
  '    var nuevo = JSON.parse(JSON.stringify(cfg));',
  '    delete nuevo.__pw;',
  '    nuevo.horarios = horariosInput.value;',
  '    nuevo.tiendaOnlineUrl = tiendaInput.value;',
  '    nuevo.amenities = {adentro: amAdentro.value, patio: amPatio.value, vereda: amVereda.value};',
  '    nuevo.agotados = agotadosList;',
  '    nuevo["cumplea\u00f1os"].minPersonas = Number(minPersonasInput.value);',
  '    nuevo["cumplea\u00f1os"].paquetes = paquetesList;',
  '    nuevo["cumplea\u00f1os"].basePrecios = {pizza:Number(bpPizza.value), tacos:Number(bpTacos.value), hamburguesas:Number(bpHamb.value), lomitos:Number(bpLomi.value), bebida:Number(bpBebida.value), shot:Number(bpShot.value), torta:Number(bpTorta.value)};',
  '    nuevo["cumplea\u00f1os"].descuentoPresupuestoAMedida = Number(descuentoInput.value) / 100;',
  '    nuevo["cumplea\u00f1os"].se\u00f1aPorcentaje = Number(senaInput.value) / 100;',
  '    nuevo["cumplea\u00f1os"].cuenta = {titular: ctTitular.value, cuit: ctCuit.value, cvu: ctCvu.value, alias: ctAlias.value};',
  '    nuevo.staff = {cajera:{nombre:cajNombre.value, telefono:cajTel.value}, due\u00f1o:{nombre:duenoNombre.value, telefono:duenoTel.value}};',
  '    nuevo.grupoReservasWhatsappId = grupoInput.value;',
  '    nuevo.deliveryConfig = cadetesList;',
  '    nuevo.promosDia = promosDiaData;',
  '    document.getElementById("msg").textContent = "Guardando...";',
  '    document.getElementById("msg").style.color = "#2b2118";',
  '    fetch("/admin/config-save", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password: cfg.__pw, config: nuevo})})',
  '      .then(function(r){ if (!r.ok) { throw new Error("No se pudo guardar"); } return r.json(); })',
  '      .then(function(){ document.getElementById("msg").textContent = "Listo, se guardaron los cambios. El agente ya los usa."; document.getElementById("msg").style.color = "#2e7d32"; window.scrollTo(0,0); })',
  '      .catch(function(e){ document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").style.color = "#C0392B"; });',
  '  });',
  '  area.appendChild(btnGuardar);',
  '}',
  '</' + 'script>',
  '</body></html>'
].join("\n");

// ---- Memoria de conversación por número (en memoria; para producción real
//      conviene pasar esto a una base de datos, ej. Postgres en Railway) ----
const conversations = new Map(); // phone -> [{role, content}]

// ---- Consultas de envío pendientes: cadetePhone (normalizado) -> {customerPhone, direccion, askedAt} ----
const pendingDeliveryQuotes = new Map();

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
        console.log(`Mensaje de cadete ${cadeteQueEscribe.nombre} sin ninguna consulta pendiente asociada — se ignora.`);
      }
      return;
    }

    // Tipos de mensaje que todavía no podemos "entender" (audio, video, sticker, ubicación, documento, etc):
    // respondemos directo, sin pasar por Claude, para garantizar que el cliente SIEMPRE reciba algo.
    if (message.type !== "text" && message.type !== "image") {
      console.log(`Tipo de mensaje no soportado todavía (${message.type}) — respondemos con un mensaje directo.`);
      const avisoPorTipo = {
        audio: "¡Uy, todavía no puedo escuchar audios! ¿Me lo escribís por acá nomás? Así te ayudo al toque 🙌",
        video: "Por ahora no puedo ver videos, pero contame por escrito qué necesitás y te ayudo enseguida 🙌",
        sticker: "¡Jaja me gustó el sticker! ¿En qué te puedo ayudar? Contame por escrito 🙌",
        document: "Por ahora no puedo abrir documentos (salvo comprobantes en foto). ¿Me contás por escrito qué necesitás?",
        location: "¡Recibí tu ubicación! Contame por escrito qué necesitás así seguimos 🙌",
      };
      const aviso = avisoPorTipo[message.type] || "Por ahora no puedo procesar ese tipo de mensaje. ¿Me contás por escrito qué necesitás? 🙌";
      await sendWhatsappText(from, aviso);
      return;
    }

    const contentBlocks = await buildUserContentBlocks(message);
    if (!contentBlocks) return;

    const history = conversations.get(from) || [];
    history.push({ role: "user", content: contentBlocks });

    const menuText = loadMenuText();
    const diaHoy = diaDeHoyArgentina();
    const fechaHoy = fechaDeHoyISOArgentina();
    const promosHoy = (config.promosDia && config.promosDia[diaHoy]) ? config.promosDia[diaHoy].filter((p) => p.activa) : [];
    const replyText = await askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy);
    console.log(`Respuesta de Claude generada (${replyText.length} caracteres):`, replyText.slice(0, 200));

    const { cleanText: sinDatos, datos: datosReserva } = extractReservaDatosMarker(replyText);
    const { cleanText, reservaConfirmada } = extractReservaMarker(sinDatos);
    const { cleanText: cleanText2, direccionEnvio } = extractConsultaEnvioMarker(cleanText);

    history.push({ role: "assistant", content: [{ type: "text", text: cleanText2 }] });
    conversations.set(from, history);

    await sendWhatsappText(from, cleanText2);

    if (reservaConfirmada && config.grupoReservasWhatsappId) {
      await sendWhatsappText(config.grupoReservasWhatsappId, reservaConfirmada);
    }

    if (datosReserva && datosReserva.fecha && datosReserva.hora) {
      const reservas = loadReservas();
      reservas.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        telefono: from,
        nombre: datosReserva.nombre || "",
        fecha: datosReserva.fecha,
        hora: datosReserva.hora,
        personas: datosReserva.personas || null,
        recordatorioEnviado: false,
        creadaEn: new Date().toISOString(),
      });
      saveReservas(reservas);
      console.log(`Reserva guardada para recordatorio: ${datosReserva.nombre} - ${datosReserva.fecha} ${datosReserva.hora}`);
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

    // Si el cliente mandó una imagen (probablemente un comprobante), le reenviamos la imagen al equipo.
    if (message.type === "image" && message.image?.id) {
      const staffPhones = Object.values(config.staff || {})
        .map((s) => soloDigitos(s.telefono))
        .filter((tel) => tel && tel.length >= 10);
      for (const tel of staffPhones) {
        await sendWhatsappImage(
          tel,
          message.image.id,
          `📎 Comprobante recibido de +${from}. Revisá y confirmá el pago cuando puedas — el cliente ya está esperando la confirmación.`
        );
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
async function askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy) {
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
      system: buildSystemPrompt(config, menuText, promosHoy, diaHoy, fechaHoy),
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

app.get("/", (_req, res) => res.send("Chaparrita agente — backend activo ✅"));

// ==================== Panel de administración ====================
app.get("/admin", (_req, res) => {
  res.type("html").send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8"><title>Chaparrita — Panel</title>
      <style>
        body { font-family: sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #2b2118; }
        h1 { font-size: 20px; }
        a.tile { display: block; padding: 18px; margin-top: 14px; border-radius: 10px; background: #F6EEDF; border: 1px solid #E9DCC7; text-decoration: none; color: #2b2118; }
        a.tile b { display: block; color: #C0392B; font-size: 16px; margin-bottom: 4px; }
      </style>
    </head>
    <body>
      <h1>🌮 Panel de Chaparrita</h1>
      <a class="tile" href="/admin/switch"><b>🔌 Prender / apagar el asistente</b>Pausalo cuando un operador quiera atender en persona.</a>
      <a class="tile" href="/admin/menu"><b>📋 Actualizar el menú</b>Subir un PDF nuevo con precios y productos.</a>
      <a class="tile" href="/admin/config"><b>⚙️ Precios, horarios, promos y teléfonos</b>Editar promos de cumpleaños, seña, horarios, productos agotados, promos por día y teléfonos del equipo.</a>
    </body>
    </html>
  `);
});

app.get("/admin/menu", (_req, res) => {
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
        a.back { display: inline-block; margin-bottom: 16px; color: #C0392B; text-decoration: none; font-size: 13px; }
      </style>
    </head>
    <body>
      <a class="back" href="/admin">&larr; Volver al panel</a>
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
      <p><a href="/admin/menu">Volver a subir otro</a> · <a href="/admin">Volver al panel</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error("Error al procesar el PDF del menú:", err);
    res.status(500).send("Hubo un error al procesar el PDF. Probá de nuevo.");
  }
});

// ==================== Switch rápido para prender/apagar el asistente ====================
app.get("/admin/switch", (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<title>Chaparrita - Prender o apagar</title>',
    '<style>',
    'body{font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 20px;color:#2b2118;text-align:center;}',
    'h1{font-size:20px}',
    'input[type=password]{font-size:15px;padding:10px;width:100%;box-sizing:border-box;margin-top:8px;border:1px solid #E9DCC7;border-radius:6px}',
    'button{font-size:15px;padding:12px;width:100%;box-sizing:border-box;margin-top:16px;border:none;border-radius:8px;cursor:pointer}',
    '.btn-primary{background:#C0392B;color:#fff}',
    '#estado{margin-top:26px;display:none}',
    '.pill{display:inline-block;padding:10px 22px;border-radius:999px;font-weight:bold;font-size:16px;margin-bottom:14px}',
    '.on{background:#DFF3E0;color:#2e7d32}',
    '.off{background:#FBE2DF;color:#C0392B}',
    '.btn-toggle{padding:16px;font-size:16px;font-weight:bold}',
    '.btn-off{background:#C0392B;color:#fff}',
    '.btn-on{background:#2e7d32;color:#fff}',
    'a.back{color:#C0392B;text-decoration:none;font-size:13px;display:block;text-align:left;margin-bottom:10px}',
    '#msg{margin-top:14px;font-weight:bold}',
    '</style></head><body>',
    '<a class="back" href="/admin">&larr; Volver al panel</a>',
    '<h1>🔌 Prender / apagar el asistente</h1>',
    '<p style="font-size:13px;color:#6b6258">Mientras está apagado, Chaparrita no responde nada por WhatsApp — queda todo para que lo atienda un operador a mano.</p>',
    '<input type="password" id="password" placeholder="Contraseña de administrador" />',
    '<button class="btn-primary" id="btnVer">Ver estado</button>',
    '<div id="estado">',
    '  <div id="pill" class="pill">...</div>',
    '  <button id="btnToggle" class="btn-toggle"></button>',
    '</div>',
    '<div id="msg"></div>',
    '<script>',
    'var pw = "";',
    'var activo = null;',
    'function pintar() {',
    '  var pill = document.getElementById("pill");',
    '  var btn = document.getElementById("btnToggle");',
    '  if (activo) {',
    '    pill.textContent = "🟢 Asistente ENCENDIDO";',
    '    pill.className = "pill on";',
    '    btn.textContent = "Apagar el asistente";',
    '    btn.className = "btn-toggle btn-off";',
    '  } else {',
    '    pill.textContent = "🔴 Asistente APAGADO";',
    '    pill.className = "pill off";',
    '    btn.textContent = "Prender el asistente";',
    '    btn.className = "btn-toggle btn-on";',
    '  }',
    '}',
    'document.getElementById("btnVer").addEventListener("click", function() {',
    '  pw = document.getElementById("password").value;',
    '  fetch("/admin/switch-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password: pw})})',
    '    .then(function(r){ if (!r.ok) { throw new Error("Contraseña incorrecta"); } return r.json(); })',
    '    .then(function(data){ activo = data.activo; pintar(); document.getElementById("estado").style.display = "block"; document.getElementById("msg").textContent = ""; })',
    '    .catch(function(e){ document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").style.color = "#C0392B"; });',
    '});',
    'document.getElementById("btnToggle").addEventListener("click", function() {',
    '  var nuevoValor = !activo;',
    '  fetch("/admin/switch-save", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password: pw, activo: nuevoValor})})',
    '    .then(function(r){ if (!r.ok) { throw new Error("No se pudo guardar"); } return r.json(); })',
    '    .then(function(){ activo = nuevoValor; pintar(); document.getElementById("msg").textContent = "Listo, se guardó."; document.getElementById("msg").style.color = "#2e7d32"; })',
    '    .catch(function(e){ document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").style.color = "#C0392B"; });',
    '});',
    '</' + 'script>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/switch-data", (req, res) => {
  if (!ADMIN_PASSWORD || req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  const config = loadConfig();
  res.json({ activo: config.asistenteActivo !== false });
});

app.post("/admin/switch-save", (req, res) => {
  if (!ADMIN_PASSWORD || req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  const config = loadConfig();
  config.asistenteActivo = !!req.body.activo;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  console.log(`Asistente ${config.asistenteActivo ? "ENCENDIDO" : "APAGADO"} desde /admin/switch.`);
  res.json({ ok: true, activo: config.asistenteActivo });
});

// ==================== Editor de configuración (precios, promos, teléfonos, horarios) ====================
app.get("/admin/config", (_req, res) => {
  res.type("html").send(ADMIN_CONFIG_PAGE);
});

app.post("/admin/config-data", (req, res) => {
  if (!ADMIN_PASSWORD || req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  res.json(loadConfig());
});

app.post("/admin/config-save", (req, res) => {
  if (!ADMIN_PASSWORD || req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
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

app.listen(PORT, () => console.log(`Chaparrita backend escuchando en el puerto ${PORT}`));
