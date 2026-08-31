require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const AdmZip = require("adm-zip");
const pdfParse = require("pdf-parse");
const { buildSystemPrompt } = require("./systemPrompt");

const app = express();
// Guardamos el body "crudo" (sin parsear) de cada request en req.rawBody — lo necesitamos
// para validar la firma de los webhooks de FUDO, que se calcula sobre el body tal cual
// llegó, antes de que Express lo convierta a objeto JSON.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

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
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  return migrarEquipoSiHaceFalta(config);
}

// ---- Equipo unificado: antes esto estaba repartido en config.staff, avisosReservas,
//      avisosPedidos y deliveryConfig por separado — ahora es una sola lista de personas,
//      cada una con checkboxes de qué permisos/roles tiene. Esta función convierte los
//      datos viejos la primera vez que arranca con esta versión, y no vuelve a tocarlos
//      después (una vez migrado, config.equipo manda).
function migrarEquipoSiHaceFalta(config) {
  if (Array.isArray(config.equipo)) return config; // ya migrado (aunque esté vacío, no se vuelve a migrar)

  const equipo = [];
  const indicePorTelefono = {};

  function obtenerOCrear(nombre, telefono) {
    const tel = soloDigitos(telefono);
    if (!tel) return null;
    if (indicePorTelefono[tel] === undefined) {
      equipo.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        nombre: nombre || "",
        telefono: telefono || "",
        activo: true,
        esDueño: false,
        recibeReservas: false,
        recibePedidos: false,
        confirmaComprobantes: false,
        esCadeteDelivery: false,
        areaCompras: "",
      });
      indicePorTelefono[tel] = equipo.length - 1;
    } else if (nombre && !equipo[indicePorTelefono[tel]].nombre) {
      equipo[indicePorTelefono[tel]].nombre = nombre;
    }
    return equipo[indicePorTelefono[tel]];
  }

  const staff = config.staff || {};
  if (staff.dueño && staff.dueño.telefono) {
    const p = obtenerOCrear(staff.dueño.nombre, staff.dueño.telefono);
    if (p) p.esDueño = true;
  }
  if (staff.cajera && staff.cajera.telefono) {
    const p = obtenerOCrear(staff.cajera.nombre, staff.cajera.telefono);
    if (p) {
      p.confirmaComprobantes = true;
      p.areaCompras = "salon";
    }
  }
  if (staff.cocina && staff.cocina.telefono) {
    const p = obtenerOCrear(staff.cocina.nombre, staff.cocina.telefono);
    if (p) {
      p.recibePedidos = true;
      p.areaCompras = "cocina";
    }
  }
  if (staff.barra && staff.barra.telefono) {
    const p = obtenerOCrear(staff.barra.nombre, staff.barra.telefono);
    if (p) p.areaCompras = "barra";
  }
  (config.avisosReservas || []).forEach((a) => {
    if (!a.telefono) return;
    const p = obtenerOCrear(a.nombre, a.telefono);
    if (p && a.activo) p.recibeReservas = true;
  });
  (config.avisosPedidos || []).forEach((a) => {
    if (!a.telefono) return;
    const p = obtenerOCrear(a.nombre, a.telefono);
    if (p && a.activo) p.recibePedidos = true;
  });
  (config.deliveryConfig || []).forEach((c) => {
    if (!c.telefono) return;
    const p = obtenerOCrear(c.nombre, c.telefono);
    if (p) p.esCadeteDelivery = !!c.activo;
  });

  config.equipo = equipo;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  console.log(`Equipo migrado automáticamente a la lista unificada (${equipo.length} persona(s)).`);
  return config;
}

function equipoActivo(config) {
  return (config.equipo || []).filter((p) => p.activo !== false && p.telefono);
}
function equipoConPermiso(config, campo) {
  return equipoActivo(config).filter((p) => p[campo]);
}
function equipoPorTelefono(config, telefono) {
  const tel = soloDigitos(telefono);
  if (!tel) return null;
  return equipoActivo(config).find((p) => soloDigitos(p.telefono) === tel) || null;
}
function equipoPorAreaCompras(config, area) {
  return equipoActivo(config).find((p) => p.areaCompras === area) || null;
}

// ---- Menú del local (se puede reemplazar subiendo un PDF nuevo desde /admin) ----
// ---- Mapeo de pedidos de FUDO -> cliente (para poder avisarle por WhatsApp cuando
//      cambia el estado del pedido, vía webhook) ----
const FUDO_ORDENES_PATH = path.join(DATA_DIR, "fudoOrdenes.json");
function loadFudoOrdenes() {
  try {
    return JSON.parse(fs.readFileSync(FUDO_ORDENES_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveFudoOrdenes(datos) {
  fs.writeFileSync(FUDO_ORDENES_PATH, JSON.stringify(datos, null, 2), "utf8");
}

// ---- Facturas de proveedores leídas (foto -> datos extraídos). Por ahora se guardan acá
// mientras no tenemos la API de stock/gastos de FUDO — el día que la consigamos, el paso
// final (cargarFacturaEnFudo) se reemplaza por el llamado real, sin tocar el resto del flujo. ----
const FACTURAS_PATH = path.join(DATA_DIR, "facturasProveedores.json");
function loadFacturas() {
  try {
    return JSON.parse(fs.readFileSync(FACTURAS_PATH, "utf8"));
  } catch {
    return [];
  }
}
function saveFacturas(lista) {
  fs.writeFileSync(FACTURAS_PATH, JSON.stringify(lista, null, 2), "utf8");
}

// ---- Adelantos de sueldo a empleados (efectivo o Mercadopago) — para saber en todo
// momento cuánto se le debe descontar a cada uno en el próximo sueldo. ----
const ADELANTOS_PATH = path.join(DATA_DIR, "adelantos.json");
function loadAdelantos() {
  try {
    return JSON.parse(fs.readFileSync(ADELANTOS_PATH, "utf8"));
  } catch {
    return [];
  }
}
function saveAdelantos(lista) {
  fs.writeFileSync(ADELANTOS_PATH, JSON.stringify(lista, null, 2), "utf8");
}

// ---- Sueldos mensuales por empleado. Dos tipos:
//      "normal" — un solo monto, el que figura tal cual en su recibo (sirve también para
//      empleados en negro, cargando el mismo número de referencia que un recibo formal).
//      "mariano" — regla especial confirmada: tiene 4hs declaradas pero trabaja 8 (4 en
//      blanco + 4 en negro), así que se toma el recibo declarado (que ya incluye el premio
//      de feriado del contador si correspondió ese mes) DOS veces, más un tercer monto base
//      fijo por su tarea de encargado de cocina (sin feriados/vacaciones adentro).
//      Total = tipo "normal" -> montoRecibo
//              tipo "mariano" -> (2 × montoRecibo) + montoBase
const SUELDOS_PATH = path.join(DATA_DIR, "sueldos.json");
function loadSueldos() {
  try {
    return JSON.parse(fs.readFileSync(SUELDOS_PATH, "utf8"));
  } catch {
    return [];
  }
}
function saveSueldos(lista) {
  fs.writeFileSync(SUELDOS_PATH, JSON.stringify(lista, null, 2), "utf8");
}

// ---- Lista fija de empleados para sueldos/adelantos (nombre completo + tipo de cálculo).
//      Evita que un mismo empleado quede duplicado por escribir el nombre distinto cada vez
//      (ej: "Mariano" un mes y "Mariano Coceres" otro mes). ----
const EMPLEADOS_PATH = path.join(DATA_DIR, "empleados.json");
function loadEmpleados() {
  try {
    return JSON.parse(fs.readFileSync(EMPLEADOS_PATH, "utf8"));
  } catch {
    return [];
  }
}
function saveEmpleados(lista) {
  fs.writeFileSync(EMPLEADOS_PATH, JSON.stringify(lista, null, 2), "utf8");
}


// Carga automática, UNA sola vez al arrancar el servidor, de los datos que estén en
// seed-payroll.json (empleados/sueldos/adelantos ya auditados fuera de este código) — así
// Tuti no tiene que tipear ni pegar nada a mano, y para auditar alcanza con abrir ese archivo
// JSON directamente, sin buscar nada en medio del código. Es segura de correr en cada
// reinicio: cada dato se agrega SOLO si todavía no existe (por nombre, por mes, o por
// fecha+monto+medio), así nunca duplica nada.
const SEED_PAYROLL_PATH = path.join(__dirname, "seed-payroll.json");
function sembrarDatosPayrollInicial() {
  try {
    if (!fs.existsSync(SEED_PAYROLL_PATH)) return; // no pasa nada si no existe el archivo
    const semilla = JSON.parse(fs.readFileSync(SEED_PAYROLL_PATH, "utf8"));

    const empleados = loadEmpleados();
    let cambioEmpleados = false;
    (semilla.empleados || []).forEach((e) => {
      if (!empleados.some((ex) => ex.nombre.toLowerCase() === e.nombre.toLowerCase())) {
        empleados.push({
          id: "seed-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          nombre: e.nombre,
          tipo: e.tipo,
          cuit: e.cuit || "",
          dni: e.dni || "",
          direccion: e.direccion || "",
          telefono: e.telefono || "",
        });
        cambioEmpleados = true;
      }
    });
    if (cambioEmpleados) saveEmpleados(empleados);

    const sueldos = loadSueldos();
    let cambioSueldos = false;
    (semilla.sueldos || []).forEach((s) => {
      if (!sueldos.some((ex) => ex.empleado === s.empleado && ex.mes === s.mes)) {
        let total, registro;
        if (s.tipo === "mariano") {
          total = 2 * s.montoDeclarado + s.montoBase;
          registro = { montoDeclarado: s.montoDeclarado, montoBase: s.montoBase };
        } else {
          total = s.montoRecibo;
          registro = { montoRecibo: s.montoRecibo };
        }
        sueldos.push({
          id: "seed-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          empleado: s.empleado,
          mes: s.mes,
          tipo: s.tipo,
          ...registro,
          total,
          creadoEn: new Date().toISOString(),
        });
        cambioSueldos = true;
      }
    });
    if (cambioSueldos) saveSueldos(sueldos);

    const adelantos = loadAdelantos();
    let cambioAdelantos = false;
    (semilla.adelantos || []).forEach((a) => {
      const yaExiste = adelantos.some(
        (ex) =>
          ex.empleado === a.empleado &&
          ex.fecha === a.fecha &&
          Math.abs(ex.monto - a.monto) < 0.01 &&
          ex.medioPago === a.medioPago
      );
      if (!yaExiste) {
        adelantos.push({
          id: "seed-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          empleado: a.empleado,
          fecha: a.fecha,
          monto: a.monto,
          medioPago: a.medioPago,
          nota: a._nota || "Cargado desde seed-payroll.json — revisar",
          saldado: false,
          creadoEn: new Date().toISOString(),
        });
        cambioAdelantos = true;
      }
    });
    if (cambioAdelantos) saveAdelantos(adelantos);

    if (cambioEmpleados || cambioSueldos || cambioAdelantos) {
      console.log("Datos iniciales de sueldos/adelantos cargados desde seed-payroll.json.");
    }
  } catch (err) {
    console.error("Error sembrando datos iniciales de payroll:", err);
  }
}
sembrarDatosPayrollInicial();


const MENU_PATH = path.join(DATA_DIR, "menu.txt");
function loadMenuText() {
  try {
    return fs.readFileSync(MENU_PATH, "utf8");
  } catch {
    return "(Todavía no se cargó el menú. Avisale al cliente que un encargado confirma precios y productos.)";
  }
}

// Arma el texto del menú directamente con los precios REALES de FUDO (en vez del PDF
// cargado a mano, que se puede desactualizar). Devuelve null si no se pudo traer el
// catálogo de FUDO por algún motivo — en ese caso el que llama usa el PDF como respaldo.
// Se cachea 30 minutos para no llamar a la API de FUDO en cada mensaje.
let menuFudoCache = null;
let menuFudoCacheEn = 0;

async function construirMenuDesdeFudo() {
  if (menuFudoCache && Date.now() - menuFudoCacheEn < 30 * 60 * 1000) {
    return menuFudoCache;
  }

  const productos = await getFudoProductos();
  if (!productos || productos.length === 0) return menuFudoCache; // si falla, devolvemos lo último que teníamos cacheado (o null)

  let categorias = [];
  try {
    const dataCategorias = await fudoFetch("/product-categories");
    categorias = (dataCategorias && dataCategorias.productCategories) || [];
  } catch {
    categorias = [];
  }
  const nombreCategoria = (id) => {
    const cat = categorias.find((c) => c.id === id);
    return cat ? cat.name : "Otros";
  };

  // Para poder mostrar el NOMBRE de cada opcional (no solo su id), armamos un diccionario
  // rápido de id -> producto con todo el catálogo.
  const productosPorId = {};
  productos.forEach((p) => {
    productosPorId[p.id] = p;
  });

  const textoOpcionales = (producto) => {
    if (!Array.isArray(producto.productGroups) || producto.productGroups.length === 0) return "";
    const grupos = producto.productGroups.map((g) => {
      const opciones = (g.productGroupProducts || [])
        .map((opt) => {
          const prodOpt = productosPorId[opt.productId];
          const nombreOpt = prodOpt ? prodOpt.name : `producto ${opt.productId}`;
          const extra = opt.price ? ` (+$${opt.price})` : "";
          return `${nombreOpt}${extra}`;
        })
        .join(", ");
      const cantidad = g.minQuantity === g.maxQuantity ? `elegir ${g.minQuantity}` : `elegir entre ${g.minQuantity} y ${g.maxQuantity}`;
      return `${cantidad}: ${opciones}`;
    });
    return ` [Opcionales — ${grupos.join(" | ")}]`;
  };

  const porCategoria = {};
  productos.forEach((p) => {
    const cat = nombreCategoria(p.productCategoryId);
    if (!porCategoria[cat]) porCategoria[cat] = [];
    porCategoria[cat].push(p);
  });

  let texto = "";
  Object.keys(porCategoria).forEach((cat) => {
    texto += `\n${cat}\n`;
    porCategoria[cat].forEach((p) => {
      texto += `- ${p.name}: $${p.price}${textoOpcionales(p)}\n`;
    });
  });

  menuFudoCache = texto.trim();
  menuFudoCacheEn = Date.now();
  console.log("Menú en vivo de FUDO actualizado y cacheado (con opcionales).");
  return menuFudoCache;
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

// Minutos que faltan desde AHORA (hora Argentina) hasta la fecha/hora de una reserva.
// Negativo si la reserva ya pasó.
function minutosHastaReserva(fechaISO, horaHHMM) {
  const ahoraArgentinaStr = new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" });
  const ahoraArgentina = new Date(ahoraArgentinaStr);
  const [anio, mes, dia] = fechaISO.split("-").map(Number);
  const [hh, mm] = horaHHMM.split(":").map(Number);
  const momentoReserva = new Date(ahoraArgentina.getFullYear(), 0, 1); // placeholder, se pisa abajo
  momentoReserva.setFullYear(anio, mes - 1, dia);
  momentoReserva.setHours(hh, mm, 0, 0);
  return Math.round((momentoReserva - ahoraArgentina) / (1000 * 60));
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

// Saca la marca interna [[CONSULTAR_RESUMEN_RESERVAS: {"periodo":"dia|semana|mes"}]]
function extractResumenReservasMarker(text) {
  const regex = /\[\[CONSULTAR_RESUMEN_RESERVAS:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, resumenPedido: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    return { cleanText, resumenPedido: JSON.parse(match[1]) };
  } catch {
    console.error("No se pudo parsear CONSULTAR_RESUMEN_RESERVAS:", match[1]);
    return { cleanText, resumenPedido: null };
  }
}

// Determina si una reserva cae dentro del "dia", "semana" (Lun-Dom) o "mes" pedido,
// para filtrar el resumen que solicita Administración/dueño.
function reservaEstaEnPeriodo(fechaReservaISO, periodo, fechaHoyISO) {
  const [ay, am, ad] = fechaHoyISO.split("-").map(Number);
  const [ry, rm, rd] = fechaReservaISO.split("-").map(Number);
  const hoy = new Date(ay, am - 1, ad);
  const reserva = new Date(ry, rm - 1, rd);
  if (periodo === "dia") {
    return reserva.getTime() === hoy.getTime();
  }
  if (periodo === "mes") {
    return ry === ay && rm === am;
  }
  // "semana": de lunes a domingo de la semana actual
  const diaSemanaHoy = hoy.getDay(); // 0=domingo
  const offsetHastaLunes = diaSemanaHoy === 0 ? 6 : diaSemanaHoy - 1;
  const lunes = new Date(hoy);
  lunes.setDate(hoy.getDate() - offsetHastaLunes);
  const domingo = new Date(lunes);
  domingo.setDate(lunes.getDate() + 6);
  return reserva >= lunes && reserva <= domingo;
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

// Saca la marca interna [[BOTONES: {"texto":"...", "opciones":["...", "..."]}]] — hasta 3
// opciones. La usa Claude en la charla libre cuando quiere ofrecer una elección corta y
// cerrada (sí/no, confirmar, elegir entre 2-3 cosas), en vez de que el cliente tenga que
// escribirla a mano.
function extractBotonesMarker(text) {
  const regex = /\[\[BOTONES:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, botones: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    const datos = JSON.parse(match[1]);
    if (!datos.texto || !Array.isArray(datos.opciones) || datos.opciones.length === 0) return { cleanText, botones: null };
    return { cleanText, botones: datos };
  } catch {
    console.error("No se pudo parsear BOTONES:", match[1]);
    return { cleanText, botones: null };
  }
}

// Saca la marca interna
// [[LISTA: {"texto":"...", "textoBoton":"...", "opciones":[{"titulo":"...","desc":"..."}]}]]
// — hasta 10 opciones. La usa Claude cuando hay más de 3 alternativas para elegir (ej: varias
// promos, varios sectores con detalle, etc.) y los botones no alcanzan.
function extractListaMarker(text) {
  const regex = /\[\[LISTA:\s*(\{[\s\S]*?\})\]\]/;
  const match = text.match(regex);
  if (!match) return { cleanText: text, lista: null };
  const cleanText = text.replace(regex, "").trim();
  try {
    const datos = JSON.parse(match[1]);
    if (!datos.texto || !Array.isArray(datos.opciones) || datos.opciones.length === 0) return { cleanText, lista: null };
    return { cleanText, lista: datos };
  } catch {
    console.error("No se pudo parsear LISTA:", match[1]);
    return { cleanText, lista: null };
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

// El historial completo se guarda como un diccionario {fecha: datosDelDia}, para poder
// consultar días anteriores desde /admin/compras (antes solo se guardaba el día actual).
function loadHistorialCompras() {
  let datos;
  try {
    datos = JSON.parse(fs.readFileSync(LISTA_COMPRAS_PATH, "utf8"));
  } catch {
    return {};
  }
  // Migración automática: si el archivo tiene el formato viejo (un solo día suelto,
  // sin diccionario por fecha), lo convertimos la primera vez que se lee.
  if (datos && datos.fecha && !datos[datos.fecha]) {
    const migrado = {};
    migrado[datos.fecha] = datos;
    return migrado;
  }
  return datos || {};
}

function saveHistorialCompras(historial) {
  fs.writeFileSync(LISTA_COMPRAS_PATH, JSON.stringify(historial, null, 2), "utf8");
}

// Devuelve la lista de compras de una fecha puntual, creándola vacía si todavía no existe
// (se usa cuando hace falta escribir/agregar algo ese día).
function loadListaCompras(fechaISO) {
  const historial = loadHistorialCompras();
  if (!historial[fechaISO]) {
    return listaComprasVacia(fechaISO);
  }
  return historial[fechaISO];
}

function saveListaCompras(datosDia) {
  const historial = loadHistorialCompras();
  historial[datosDia.fecha] = datosDia;
  saveHistorialCompras(historial);
}

// Para solo consultar un día (por ejemplo desde el panel), sin crear nada nuevo si no existe.
function peekListaCompras(fechaISO) {
  const historial = loadHistorialCompras();
  return historial[fechaISO] || null;
}

// A qué rol de compras corresponde un teléfono dado (cocina / barra / salon=cajera), o null.
function rolDeComprasSegunTelefono(config, telefono) {
  const persona = equipoPorTelefono(config, telefono);
  return persona && persona.areaCompras ? persona.areaCompras : null;
}

// Arma el texto del mensaje con la lista de compras pendiente (lo que todavía no se compró).
function construirMensajeListaCompras(items, rolesFaltantes) {
  const pendientes = items.filter((i) => !i.comprado);
  const NOMBRES_ROL = { cocina: "Cocina", barra: "Barra", salon: "Salón" };
  if (pendientes.length === 0 && rolesFaltantes.length === 0) {
    return "🛒 No queda nada pendiente en la lista de compras — ¡ya está todo comprado! 🎉";
  }
  const porRol = {};
  pendientes.forEach((item) => {
    const rol = item.origen || "otros";
    if (!porRol[rol]) porRol[rol] = [];
    porRol[rol].push(item.texto);
  });

  let mensaje = "🛒 *Lista de compras pendiente*\n";
  ROLES_COMPRAS.forEach((rol) => {
    if (porRol[rol] && porRol[rol].length > 0) {
      mensaje += `\n*${NOMBRES_ROL[rol]} necesita:*\n`;
      porRol[rol].forEach((texto) => {
        mensaje += `· ${texto}\n`;
      });
    }
  });
  if (porRol.otros && porRol.otros.length > 0) {
    mensaje += `\n*Otros:*\n`;
    porRol.otros.forEach((texto) => {
      mensaje += `· ${texto}\n`;
    });
  }

  if (rolesFaltantes.length > 0) {
    mensaje += `\n⚠️ Todavía no llegó el pedido de: ${rolesFaltantes.map((r) => NOMBRES_ROL[r]).join(", ")}. Les mandé un mensaje pidiéndoselo.`;
  }
  return mensaje;
}

// Llamada aparte a Claude (no es parte de la charla con el dueño) para categorizar el
// pedido de UNA sola persona (cocina, barra o salón) apenas lo manda, sin esperar a que
// el dueño pida el resumen — así la lista se va armando en tiempo real.
const LISTA_COMPRAS_SYSTEM_PROMPT = `Sos un asistente que organiza pedidos de compra para un restaurante bar mexicano en Formosa, Argentina. Te paso el pedido que mandó UNA sola persona del equipo (cocina, barra o salón) para el día. Tu trabajo es organizarlo en ítems, cada uno con su categoría de comercio correspondiente (por ejemplo: Verdulería, Fiambres, Super, Carnicería, Bebidas, Otros — usá las categorías que correspondan según los productos reales, no inventes categorías vacías).

Reglas importantes:
- NUNCA inventes ni agregues productos que no estén en el pedido original.
- Mantené las cantidades y unidades tal como las escribieron, no las inventes ni las cambies.
- Si un mismo ítem aparece repetido varias veces en el mismo pedido, podés unificarlo en una sola línea sumando la cantidad.
- Para cada ítem, marcá "cantidadClara": true si el pedido especifica una cantidad o medida concreta (por ejemplo "5kg", "2 cajones", "1 bolsa", "3 unidades", "una docena"). Marcá "cantidadClara": false si el ítem es solo el nombre del producto sin ninguna cantidad ni medida (por ejemplo "papa", "hielo", "servilletas" sin número).

Respondé ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown, sin \`\`\`), con esta forma exacta:
{"items": [{"texto": "1 bolsa de papa", "categoria": "Verdulería", "cantidadClara": true}, {"texto": "hielo", "categoria": "Otros", "cantidadClara": false}]}`;

async function categorizarPedidoIndividual(textoOriginal) {
  if (!textoOriginal || !textoOriginal.trim()) return [];
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", // tarea simple de clasificación — no hace falta Sonnet acá
        max_tokens: 1000,
        system: LISTA_COMPRAS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: textoOriginal }],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Error de la API de Claude al categorizar pedido de compras:", data);
      return [];
    }
    const textoRespuesta = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    // Extraemos el bloque {...} aunque Claude haya agregado texto de más antes o después,
    // en vez de asumir que la respuesta entera es JSON puro.
    const jsonMatch = textoRespuesta.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("La respuesta de Claude no contenía JSON reconocible al categorizar pedido de compras:", textoRespuesta.slice(0, 300));
      return [];
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.items || [];
  } catch (err) {
    console.error("Error categorizando pedido de compras:", err);
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
    --coral: #FF6B4A;
    --turquesa: #2DD4C4;
    --ocre: #F2B705;
    --jalapeno: #E15A5A;
    --verde-wa: #25D366;
    --verde-wa-oscuro: #075E54;
    --bg: #12100E;
    --bg-elevado: #1C1917;
    --card: #1C1917;
    --card-hover: #242019;
    --borde: #34302A;
    --texto: #F5F0E8;
    --texto-tenue: #A8A296;
    --exito: #3FCB8C;
    --alerta: #F2B705;
    --peligro: #FF6B4A;
    --radio: 12px;
    --radio-chico: 8px;
    --sombra: 0 10px 26px -8px rgba(0,0,0,0.6);
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
    width: 38px; height: 38px; border-radius: 11px; overflow: hidden;
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
  .btn-secondary, .secundario { background: var(--bg-elevado); color: var(--texto); border: 1px solid var(--borde); }
  .btn-secondary:hover, .secundario:hover { border-color: var(--turquesa); }
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

  '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Chaparrita - Editar configuracion</title>',
  `<style>${ADMIN_BASE_CSS}
    html { scroll-behavior: smooth; }
    .config-layout { display: flex; gap: 22px; max-width: 980px; margin: 0 auto; padding: 22px 18px 60px; align-items: flex-start; }
    .config-sidebar { width: 230px; flex-shrink: 0; position: sticky; top: 18px; background: var(--card); border: 1px solid var(--borde); border-radius: var(--radio); padding: 14px 10px; max-height: calc(100vh - 36px); overflow-y: auto; }
    .config-sidebar .titulo-menu { font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--texto-tenue); padding: 0 8px; margin-bottom: 6px; }
    .config-sidebar a { display: block; padding: 7px 8px; border-radius: 8px; color: var(--texto-tenue); text-decoration: none; font-size: 12.5px; margin-bottom: 1px; line-height: 1.3; }
    .config-sidebar a:hover { background: var(--card-hover); color: var(--texto); }
    .config-main { flex: 1; min-width: 0; }
    #formArea { display: none; }
    @media (max-width: 860px) {
      .config-layout { display: block; padding: 16px 14px 60px; }
      .config-sidebar { position: static; width: 100%; max-height: none; margin-bottom: 16px; overflow-y: visible; }
    }
  </style>`,
  '</head><body>',
  '<div class="config-layout">',
  '<nav class="config-sidebar">',
  '<div class="titulo-menu">Ir a la sección</div>',
  '<a href="#sec-marca">Panel / Marca</a>',
  '<a href="#sec-horarios">Horarios y tienda online</a>',
  '<a href="#sec-amenities">Amenities por sector</a>',
  '<a href="#sec-mesas">Mesas y disponibilidad</a>',
  '<a href="#sec-agotados">Productos agotados</a>',
  '<a href="#sec-cumple-promos">Promos de cumpleaños</a>',
  '<a href="#sec-precios-base">Presupuesto a medida</a>',
  '<a href="#sec-cuenta-sena">Cuenta para la seña</a>',
  '<a href="#sec-equipo">Equipo</a>',
  '<a href="#sec-oferta-cumple">Oferta cumpleaños próximo</a>',
  '<a href="#sec-cumple-cliente">Cumpleaños de clientes</a>',
  '<a href="#sec-aviso-cumple-diario">Aviso diario de cumpleaños</a>',
  '<a href="#sec-tacos-libres">Tacos libres</a>',
  '<a href="#sec-promos-dia">Promos por día</a>',
  '<a href="#sec-conocimiento">Base de conocimiento</a>',
  '<a href="#sec-fudo">Integración con FUDO</a>',
  '</nav>',
  '<main class="config-main">',
  '<a class="volver" href="/admin">← Volver al panel</a>',
  '<h1>Editar precios, horarios, promos y teléfonos</h1>',
  '<button class="btn-secondary" id="btnReset">Restaurar valores del repositorio (GitHub)</button>',
  '<p class="sub">Usalo solo si los cambios que hacés acá no se guardan al reiniciar el servidor. Pisa TODO lo que hayas cambiado en este panel con lo que esté subido en GitHub.</p>',
  '<div id="msg">Cargando...</div>',
  '<div id="formArea"></div>',
  '</main>',
  '</div>',
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
  '  area.appendChild(el("h2", {text:"Panel / Marca", id:"sec-marca"}));',
  '  area.appendChild(el("p", {text:"El logo y la frase que se ven arriba de todo en el panel principal.", style:"font-size:12px;color:var(--texto-tenue);margin:2px 0 12px 0;"}));',
  '  var marca = cfg.panelMarca || {};',
  '  var logoPreview = el("div", {style:"width:64px;height:64px;border-radius:16px;overflow:hidden;background:var(--bg-elevado);border:1px solid var(--borde);display:flex;align-items:center;justify-content:center;font-size:30px;margin-bottom:10px;"});',
  '  if (marca.logoBase64) {',
  '    var imgPreview = el("img", {});',
  '    imgPreview.src = marca.logoBase64;',
  '    imgPreview.style.width = "100%"; imgPreview.style.height = "100%"; imgPreview.style.objectFit = "cover";',
  '    logoPreview.appendChild(imgPreview);',
  '  } else {',
  '    logoPreview.textContent = "🌮";',
  '  }',
  '  area.appendChild(logoPreview);',
  '  var logoFileInput = el("input", {type:"file", accept:"image/*"});',
  '  var btnSubirLogo = el("button", {type:"button", text:"Subir logo nuevo", class:"btn-secondary"});',
  '  btnSubirLogo.style.marginLeft = "8px";',
  '  var logoMsg = el("span", {style:"font-size:12px;margin-left:10px;color:var(--texto-tenue);"});',
  '  btnSubirLogo.addEventListener("click", function() {',
  '    if (!logoFileInput.files || !logoFileInput.files[0]) { logoMsg.textContent = "Elegí un archivo primero."; return; }',
  '    var fd = new FormData();',
  '    fd.append("logoImagen", logoFileInput.files[0]);',
  '    logoMsg.textContent = "Subiendo...";',
  '    fetch("/admin/upload-logo", {method:"POST", body: fd})',
  '      .then(function(r){ if (!r.ok) { throw new Error("No se pudo subir"); } return r.json(); })',
  '      .then(function(data){ logoMsg.textContent = "¡Listo!"; cfg.panelMarca = cfg.panelMarca || {}; return fetch("/admin/config-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})}); })',
  '      .then(function(r){ return r.json(); })',
  '      .then(function(data){ cfg = data; renderForm(); })',
  '      .catch(function(e){ logoMsg.textContent = "Error: " + e.message; });',
  '  });',
  '  area.appendChild(el("div", {}, [logoFileInput, btnSubirLogo, logoMsg]));',
  '  var tituloHeroInput = textInput(marca.tituloHero || "Todo Chaparrita, en un solo lugar");',
  '  area.appendChild(field("Título grande del panel", tituloHeroInput));',
  '  var subtituloHeroInput = taInput(marca.subtituloHero || "Clientes, reservas, pedidos, compras y la configuración del agente — organizado por función, para encontrar todo rápido.");',
  '  area.appendChild(field("Frase debajo del título", subtituloHeroInput));',
  '',
  '  area.appendChild(el("h2", {text:"Horarios y tienda online", id:"sec-horarios"}));',
  '  var horariosInput = taInput(cfg.horarios);',
  '  area.appendChild(field("Horarios de atencion", horariosInput));',
  '  var tiendaInput = textInput(cfg.tiendaOnlineUrl);',
  '  area.appendChild(field("Link tienda online", tiendaInput));',
  '',
  '  area.appendChild(el("h2", {text:"Amenities por sector", id:"sec-amenities"}));',
  '  var amAdentro = textInput(cfg.amenities.adentro);',
  '  var amPatio = textInput(cfg.amenities.patio);',
  '  var amVereda = textInput(cfg.amenities.vereda);',
  '  area.appendChild(field("Adentro", amAdentro));',
  '  area.appendChild(field("Patio interno", amPatio));',
  '  area.appendChild(field("Vereda", amVereda));',
  '',
  '  area.appendChild(el("h2", {text:"Mesas por sector y disponibilidad", id:"sec-mesas"}));',
  '  area.appendChild(el("p", {text:"El agente calcula solo cu\u00e1ntas mesas quedan libres para cada horario, sin que nadie tenga que marcarlo a mano.", style:"font-size:12px;color:var(--texto-tenue);margin:2px 0 8px 0;"}));',
  '  var mesasCfg = cfg.mesasPorSector || {adentro:0, patio:0, vereda:0};',
  '  var mesasAdentro = numInput(mesasCfg.adentro);',
  '  var mesasPatio = numInput(mesasCfg.patio);',
  '  var mesasVereda = numInput(mesasCfg.vereda);',
  '  area.appendChild(el("div", {class:"row"}, [field("Mesas adentro", mesasAdentro), field("Mesas patio", mesasPatio), field("Mesas vereda", mesasVereda)]));',
  '  var duracionMesaInput = numInput(cfg.duracionMesaMinutos || 90);',
  '  area.appendChild(field("Duraci\u00f3n promedio de una mesa ocupada (minutos)", duracionMesaInput));',
  '',
  '  area.appendChild(el("h2", {text:"Productos agotados hoy", id:"sec-agotados"}));',
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
  '  area.appendChild(el("h2", {text:"Cumpleanos - promos todo incluido", id:"sec-cumple-promos"}));',
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
  '  area.appendChild(el("h2", {text:"Precios base para presupuesto a medida (menos del minimo)", id:"sec-precios-base"}));',
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
  '  area.appendChild(el("h2", {text:"Cuenta para la sena", id:"sec-cuenta-sena"}));',
  '  var ct = cfg["cumplea\u00f1os"].cuenta;',
  '  var ctTitular = textInput(ct.titular), ctCuit = textInput(ct.cuit), ctCvu = textInput(ct.cvu), ctAlias = textInput(ct.alias);',
  '  area.appendChild(field("Titular", ctTitular));',
  '  area.appendChild(el("div", {class:"row"}, [field("CUIT/CUIL", ctCuit), field("Alias", ctAlias)]));',
  '  area.appendChild(field("CVU", ctCvu));',
  '',
  '  area.appendChild(el("h2", {text:"Equipo", id:"sec-equipo"}));',
  '  area.appendChild(el("p", {text:"Una sola lista para todo el equipo. Cada persona puede tener varios permisos a la vez (tildá los que correspondan). Cargá el tel\u00e9fono con c\u00f3digo de pa\u00eds y 9 (ej: 549370XXXXXXX).", style:"font-size:12px;color:var(--texto-tenue);margin:2px 0 8px 0;"}));',
  '  var equipoBox = el("div", {id:"equipoBox"});',
  '  var equipoList = JSON.parse(JSON.stringify(cfg.equipo || []));',
  '  var AREAS_COMPRAS = [["","Ninguna"],["cocina","Cocina"],["barra","Barra"],["salon","Sal\u00f3n"]];',
  '  function checkboxConLabel(persona, campo, textoLabel) {',
  '    var chk = el("input", {type:"checkbox"}); chk.checked = !!persona[campo]; chk.onchange = function(){ persona[campo] = chk.checked; };',
  '    var lbl = el("label", {text:" " + textoLabel}); lbl.style.display = "inline"; lbl.style.fontWeight = "normal";',
  '    return el("div", {style:"margin-top:6px;"}, [chk, lbl]);',
  '  }',
  '  function pintarEquipo() {',
  '    equipoBox.innerHTML = "";',
  '    equipoList.forEach(function(persona, idx) {',
  '      var nombreI = textInput(persona.nombre); nombreI.oninput = function(){ persona.nombre = nombreI.value; };',
  '      var telI = textInput(persona.telefono); telI.oninput = function(){ persona.telefono = telI.value; };',
  '      var selectArea = el("select", {});',
  '      AREAS_COMPRAS.forEach(function(opt){',
  '        var option = el("option", {text: opt[1]}); option.value = opt[0]; if (persona.areaCompras === opt[0]) option.selected = true;',
  '        selectArea.appendChild(option);',
  '      });',
  '      selectArea.onchange = function(){ persona.areaCompras = selectArea.value; };',
  '      var btnDel = el("button", {type:"button", text:"Eliminar de la lista", class:"btn-danger"});',
  '      btnDel.addEventListener("click", function(){ equipoList.splice(idx,1); pintarEquipo(); });',
  '      var card = el("div", {class:"card"}, [',
  '        el("div", {class:"row"}, [field("Nombre", nombreI), field("Tel\u00e9fono", telI)]),',
  '        checkboxConLabel(persona, "activo", "Activo (en general)"),',
  '        checkboxConLabel(persona, "esDueño", "\ud83d\udc51 Es el due\u00f1o (saludo especial + asistente de compras)"),',
  '        checkboxConLabel(persona, "recibeReservas", "\ud83d\udcc5 Recibe confirmaci\u00f3n de reservas"),',
  '        checkboxConLabel(persona, "recibePedidos", "\ud83c\udf7d\ufe0f Recibe pedidos confirmados (cocina)"),',
  '        checkboxConLabel(persona, "confirmaComprobantes", "\ud83d\udcb3 Confirma comprobantes de pago"),',
  '        checkboxConLabel(persona, "esCadeteDelivery", "\ud83d\udef5 Es cadete de delivery (se le consulta el env\u00edo)"),',
  '        checkboxConLabel(persona, "cargaFacturas", "\ud83e\uddfe Puede cargar facturas de proveedores (foto \u2192 stock y gastos en FUDO)"),',
  '        field("\u00c1rea de compras diaria", selectArea),',
  '        btnDel',
  '      ]);',
  '      equipoBox.appendChild(card);',
  '    });',
  '  }',
  '  pintarEquipo();',
  '  area.appendChild(equipoBox);',
  '  var btnAddPersona = el("button", {type:"button", text:"+ Agregar persona", class:"btn-secondary"});',
  '  btnAddPersona.addEventListener("click", function(){ equipoList.push({id: Date.now() + "-" + Math.random().toString(36).slice(2,8), nombre:"Nueva persona", telefono:"", activo:true, esDueño:false, recibeReservas:false, recibePedidos:false, confirmaComprobantes:false, esCadeteDelivery:false, cargaFacturas:false, areaCompras:""}); pintarEquipo(); });',
  '  area.appendChild(btnAddPersona);',
  '',
  '  var grupoInput = textInput(cfg.grupoReservasWhatsappId);',
  '  area.appendChild(field("ID de WhatsApp del grupo Reservas Chaparrita (viejo, no funciona con la API actual)", grupoInput));',
  '',
  '  area.appendChild(el("h2", {text:"Oferta proactiva antes del cumpleanos", id:"sec-oferta-cumple"}));',
  '  area.appendChild(el("p", {text:"Le manda un WhatsApp al cliente antes de su cumple ofreciendole reservar (con los beneficios de abajo) o las promos grupales.", style:"font-size:12px;color:#6b6258;margin:2px 0 8px 0;"}));',
  '  var ofertaCumple = cfg["ofertaCumplea\u00f1osProximo"] || {activo:true, diasAntes:7};',
  '  var ofertaCumpleActivo = el("input", {type:"checkbox"}); ofertaCumpleActivo.checked = ofertaCumple.activo !== false;',
  '  var lblOfertaActivo = el("label", {text:" Activo"}); lblOfertaActivo.style.display="inline"; lblOfertaActivo.style.fontWeight="normal";',
  '  area.appendChild(el("div", {}, [ofertaCumpleActivo, lblOfertaActivo]));',
  '  var ofertaCumpleDias = numInput(ofertaCumple.diasAntes);',
  '  area.appendChild(field("Dias de anticipacion", ofertaCumpleDias));',
  '',
  '  area.appendChild(el("h2", {text:"Cumpleanos de clientes (mimo personal)", id:"sec-cumple-cliente"}));',
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
  '  area.appendChild(el("h2", {text:"Aviso diario de cumpleanos", id:"sec-aviso-cumple-diario"}));',
  '  area.appendChild(el("p", {text:"Te avisa por WhatsApp quien cumple hoy y quien cumple en los proximos 7 dias. Si dejas el telefono vacio, se le manda al dueno.", style:"font-size:12px;color:#6b6258;margin:2px 0 8px 0;"}));',
  '  var avisoCumple = cfg.avisoCumpleañosDiario || {activo:true, telefono:"", hora:"09:00"};',
  '  var avisoCumpleActivo = el("input", {type:"checkbox"}); avisoCumpleActivo.checked = avisoCumple.activo !== false;',
  '  var lblAvisoActivo = el("label", {text:" Activo"}); lblAvisoActivo.style.display="inline"; lblAvisoActivo.style.fontWeight="normal";',
  '  area.appendChild(el("div", {}, [avisoCumpleActivo, lblAvisoActivo]));',
  '  var avisoCumpleTel = textInput(avisoCumple.telefono);',
  '  var avisoCumpleHora = textInput(avisoCumple.hora || "09:00");',
  '  area.appendChild(el("div", {class:"row"}, [field("Telefono que recibe el aviso (vacio = dueno)", avisoCumpleTel), field("Hora del aviso (HH:MM)", avisoCumpleHora)]));',
  '',
  '  area.appendChild(el("h2", {text:"Tacos libres para todo el publico", id:"sec-tacos-libres"}));',
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
  '  area.appendChild(el("h2", {text:"Promociones por dia de la semana", id:"sec-promos-dia"}));',
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
  '  area.appendChild(el("h2", {text:"Base de conocimiento", id:"sec-conocimiento"}));',
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
  '  area.appendChild(el("h2", {text:"Integraci\u00f3n con FUDO", id:"sec-fudo"}));',
  '  area.appendChild(el("p", {text:"IDs de los medios de pago en FUDO (los ves en Fudo, secci\u00f3n Finanzas \u2192 Medios de pago), para que el pedido se cargue con el medio de pago correcto.", style:"font-size:12px;color:var(--texto-tenue);margin:2px 0 8px 0;"}));',
  '  var fudoPagos = cfg.fudoMediosPago || {efectivo:"", transferencia:"", linkDePago:""};',
  '  var fudoEfectivoInput = numInput(fudoPagos.efectivo);',
  '  var fudoTransferenciaInput = numInput(fudoPagos.transferencia);',
  '  var fudoLinkInput = numInput(fudoPagos.linkDePago);',
  '  area.appendChild(el("div", {class:"row"}, [field("ID de Efectivo", fudoEfectivoInput), field("ID de Transferencia", fudoTransferenciaInput), field("ID de Link de pago", fudoLinkInput)]));',
  '',
  '  var btnGuardar = el("button", {type:"button", text:"Guardar todos los cambios", class:"btn-primary"});',
  '  btnGuardar.style.marginTop = "24px";',
  '  btnGuardar.style.width = "100%";',
  '  btnGuardar.addEventListener("click", function() {',
  '    var nuevo = JSON.parse(JSON.stringify(cfg));',
  '    nuevo.panelMarca = nuevo.panelMarca || {};',
  '    nuevo.panelMarca.tituloHero = tituloHeroInput.value;',
  '    nuevo.panelMarca.subtituloHero = subtituloHeroInput.value;',
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
  '    nuevo.equipo = equipoList;',
  '    nuevo.grupoReservasWhatsappId = grupoInput.value;',
  '    nuevo.tacosLibresPublico = {dias: DIAS_KEY.filter(function(d){ return tlpDiasChecks[d].checked; }), precioPersona: Number(tlpPrecioInput.value)};',
  '    nuevo["ofertaCumplea\u00f1osProximo"] = {activo: ofertaCumpleActivo.checked, diasAntes: Number(ofertaCumpleDias.value)};',
  '    nuevo["cumplea\u00f1osCliente"] = {activo: cumpleCliActivo.checked, descuentoPorcentaje: Number(cumpleCliDesc.value), shotsTequilaSiFestejaEnLocal: cumpleCliShots.checked};',
  '    nuevo.avisoCumpleañosDiario = {activo: avisoCumpleActivo.checked, telefono: avisoCumpleTel.value, hora: avisoCumpleHora.value};',
  '    nuevo.promosDia = promosDiaData;',
  '    nuevo.baseConocimiento = conocimientoList;',
  '    nuevo.fudoMediosPago = {efectivo: fudoEfectivoInput.value, transferencia: fudoTransferenciaInput.value, linkDePago: fudoLinkInput.value};',
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
  '</body></html>'
].join("\n");

// ---- Memoria de conversación por número (en memoria; para producción real
//      conviene pasar esto a una base de datos, ej. Postgres en Railway) ----
const conversations = new Map(); // phone -> [{role, content}]

// ---- Consultas de envío pendientes: cadetePhone (normalizado) -> {customerPhone, direccion, askedAt} ----
const pendingDeliveryQuotes = new Map();

// ---- Comprobantes de pago pendientes de confirmación: staffPhone (normalizado) -> {customerPhone, askedAt} ----
const pendingComprobantes = new Map();

// ---- Cantidades de compras pendientes de aclarar: telefonoDelRol (normalizado) ->
//      {ids: [...ids de ítems sin cantidad clara], rol} ----
const pendingCantidadCompras = new Map();

// ---- Pedidos esperando confirmación de que ya se cargaron en el sistema (FUDO u otro):
//      telefonoDeQuienDebeConfirmar (normalizado) -> [{id, resumen, clientePhone, creadaEn}] ----
const pendingComandas = new Map();

// ---- Evita procesar el mismo pedido confirmado más de una vez (por ejemplo si el
//      cliente escribe "sí" o "confirmo" varias veces seguidas) — telefono -> {resumen, procesadoEn} ----
const ultimoPedidoConfirmadoPorCliente = new Map();

// ---- Igual que con los pedidos: evita mandar el aviso de "reserva confirmada" al staff
//      más de una vez para la misma reserva (identificada por teléfono + fecha + hora) ----
const ultimaReservaAvisadaPorCliente = new Map();
const VENTANA_DEDUP_RESERVA_MS = 15 * 60 * 1000; // 15 minutos
const VENTANA_DEDUP_PEDIDO_MS = 15 * 60 * 1000; // 15 minutos

// Saca espacios de más, tildes/mayúsculas y signos, para comparar solo el contenido real
// y no fallar por diferencias mínimas de formato entre una confirmación y otra.
function normalizarParaComparar(texto) {
  return (texto || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // saca tildes
    .replace(/[.,;:$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Igual que normalizarParaComparar, pero además ordena los ítems alfabéticamente antes de
// comparar — así, si Claude lista los mismos productos en distinto orden entre una
// confirmación y otra, igual los reconocemos como el mismo pedido.
function normalizarItemsParaComparar(itemsTexto) {
  return (itemsTexto || "")
    .split(",") // separamos por coma ANTES de normalizar, porque normalizarParaComparar saca las comas
    .map((parte) => normalizarParaComparar(parte))
    .filter(Boolean)
    .sort()
    .join(",");
}

function soloDigitos(numero) {
  let digitos = (numero || "").replace(/[^\d]/g, "");
  // BUGFIX: los números de celular argentinos llegan del webhook de WhatsApp con un "9"
  // extra después del código de país (54) — ej: 5493705263752 — pero si se cargó el
  // teléfono a mano en /admin sin ese 9 (como se marca normalmente en Argentina, ej:
  // 543705263752), antes quedaban como dos números "distintos" y nunca matcheaban. Por
  // eso cocina/barra/salón a veces se trataban como un cliente nuevo en vez de reconocerse
  // como staff. Acá canonicalizamos SIEMPRE sin ese 9, así cualquier comparación de
  // teléfonos (llegue como llegue el número) matchea correctamente.
  if (digitos.startsWith("549") && digitos.length >= 12) {
    digitos = "54" + digitos.slice(3);
  }
  return digitos;
}

const {
  ANTHROPIC_API_KEY,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  ADMIN_PASSWORD,
  FUDO_CLIENT_ID,
  FUDO_CLIENT_SECRET,
  FUDO_API_KEY,
  FUDO_API_SECRET,
  ES_STAGING,
  SUELDOS_PASSWORD,
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
  const marcaLogin = loadConfig().panelMarca || {};
  const logoLoginHtml = marcaLogin.logoBase64
    ? `<img src="${marcaLogin.logoBase64}" style="width:100%;height:100%;object-fit:cover;" alt="Logo">`
    : "🌮";
  res.type("html").send([
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Chaparrita - Ingresar</title>',
    `<style>${ADMIN_BASE_CSS}
      .login-shell { max-width: 380px; margin: 100px auto; text-align: center; padding: 0 20px; }
      .login-icono { width: 64px; height: 64px; border-radius: 18px; margin: 0 auto 18px; overflow: hidden; background: linear-gradient(135deg, var(--verde-wa-oscuro), var(--verde-wa)); display: flex; align-items: center; justify-content: center; font-size: 30px; box-shadow: var(--sombra); }
      .login-shell input[type=password] { text-align: center; font-size: 16px; padding: 13px; }
      .login-shell button { width: 100%; padding: 13px; font-size: 14.5px; }
    </style>`,
    '</head><body>',
    '<div class="login-shell">',
    `<div class="login-icono">${logoLoginHtml}</div>`,
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

// ==================== Segunda contraseña, solo para /admin/sueldos ====================
// Datos de sueldos son más sensibles que el resto del panel, así que además de la
// contraseña general de /admin, pide una segunda y propia para entrar acá.
const SUELDOS_SESSIONS = new Map();
const SUELDOS_SESSION_COOKIE = "chap_sueldos_sesion";
const SUELDOS_SESSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4hs — más corta que la general, a propósito

function tieneSesionSueldosValida(req) {
  const cookies = parseCookies(req);
  const token = cookies[SUELDOS_SESSION_COOKIE];
  if (!token) return false;
  const expira = SUELDOS_SESSIONS.get(token);
  if (!expira || expira < Date.now()) {
    SUELDOS_SESSIONS.delete(token);
    return false;
  }
  return true;
}

function crearSesionSueldos(res) {
  const token = crypto.randomBytes(24).toString("hex");
  SUELDOS_SESSIONS.set(token, Date.now() + SUELDOS_SESSION_DURATION_MS);
  res.setHeader(
    "Set-Cookie",
    `${SUELDOS_SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SUELDOS_SESSION_DURATION_MS / 1000)}; SameSite=Lax`
  );
}

// Middleware para la página HTML de /admin/sueldos: pide la sesión general de admin
// (requireAdminPage ya se aplica antes) Y, encima, esta segunda sesión propia.
function requireSueldosPage(req, res, next) {
  if (tieneSesionSueldosValida(req)) return next();
  return res.redirect("/admin/sueldos-login");
}

function requireSueldosApi(req, res, next) {
  if (tieneSesionSueldosValida(req)) return next();
  return res.status(401).json({ error: "Sesión de sueldos vencida, iniciá sesión de nuevo." });
}

app.get("/admin/sueldos-login", requireAdminPage, (_req, res) => {
  res.type("html").send([
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Chaparrita - Sueldos</title>',
    `<style>${ADMIN_BASE_CSS}
      .login-shell { max-width: 380px; margin: 100px auto; text-align: center; padding: 0 20px; }
      .login-icono { width: 64px; height: 64px; border-radius: 18px; margin: 0 auto 18px; display: flex; align-items: center; justify-content: center; font-size: 30px; background: linear-gradient(135deg, var(--verde-wa-oscuro), var(--verde-wa)); box-shadow: var(--sombra); }
      .login-shell input[type=password] { text-align: center; font-size: 16px; padding: 13px; }
      .login-shell button { width: 100%; padding: 13px; font-size: 14.5px; }
    </style>`,
    '</head><body>',
    '<div class="login-shell">',
    '<div class="login-icono">🔒</div>',
    '<h1>Sueldos</h1>',
    '<p class="sub">Esta sección tiene una contraseña aparte de la del panel general.</p>',
    '<input type="password" id="password" placeholder="Contraseña de sueldos" autofocus />',
    '<button class="btn-primary" id="btnEntrar">Entrar</button>',
    '<div id="msg"></div>',
    '</div>',
    '<script>',
    'function intentarEntrar() {',
    '  var pw = document.getElementById("password").value;',
    '  fetch("/admin/sueldos-login-check", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({password: pw})})',
    '    .then(function(r){ if (!r.ok) { throw new Error("Contraseña incorrecta"); } return r.json(); })',
    '    .then(function(){ window.location.href = "/admin/sueldos"; })',
    '    .catch(function(e){ document.getElementById("msg").textContent = e.message; document.getElementById("msg").className = "msg-error"; });',
    '}',
    'document.getElementById("btnEntrar").addEventListener("click", intentarEntrar);',
    'document.getElementById("password").addEventListener("keydown", function(e){ if (e.key === "Enter") intentarEntrar(); });',
    '</' + 'script>',
    '</body></html>'
  ].join("\n"));
});

app.post("/admin/sueldos-login-check", requireAdminApi, (req, res) => {
  if (!SUELDOS_PASSWORD || req.body.password !== SUELDOS_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  crearSesionSueldos(res);
  res.json({ ok: true });
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

    // Si tocó un botón o una opción de lista, lo convertimos a un mensaje de texto normal
    // ACÁ MISMO, antes de que el resto del código lo vea — así todos los flujos que ya
    // esperan message.type === "text" (facturas, comandas, compras, reservas, etc.) siguen
    // funcionando sin cambios, sin importar si la respuesta vino tocando un botón o
    // escribiendo. El "id" del botón queda en message.interactive.* por si algún flujo
    // nuevo lo necesita más preciso que el texto del título.
    if (message.type === "interactive") {
      const reply = message.interactive?.button_reply || message.interactive?.list_reply;
      if (reply) {
        message.type = "text";
        message.text = { body: reply.title };
        console.log(`(Era un botón/lista — id: "${reply.id}", convertido a texto: "${reply.title}")`);
      }
    }

    const config = loadConfig();
    if (config.asistenteActivo === false) {
      console.log("El asistente está apagado (asistenteActivo=false) — no se responde, queda para que lo atienda un operador.");
      return;
    }

    // ¿Este mensaje viene de un cadete que tenemos cargado? Si es así, no lo procesamos
    // con Claude — puede ser la respuesta a una consulta de envío pendiente.
    const cadetes = equipoConPermiso(config, "esCadeteDelivery");
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
    const staffQueEscribe = equipoConPermiso(config, "confirmaComprobantes")
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

    // ¿Este mensaje viene de alguien con permiso para cargar facturas (dueño/cajera), y
    // es una respuesta corta a una factura que ya le mostramos para confirmar? Si dice
    // que sí, la "cargamos" (por ahora, localmente — ver cargarFacturaEnFudo). Si no,
    // le pedimos que aclare qué corregir y volvemos a intentar con lo que nos diga.
    const facturaPendiente = pendingFacturas.get(soloDigitos(from));
    if (facturaPendiente && message.type === "text") {
      const textoRespuestaFactura = message.text.body.trim();
      const interpretacion = interpretarConfirmacionFactura(textoRespuestaFactura);
      if (interpretacion.confirma && interpretacion.faltaAclararEfectivo) {
        agregarMensajeInbox(from, "cliente", textoRespuestaFactura);
        await sendWhatsappText(from, 'Decime "efectivo caja" o "efectivo reserva" para saber si entra al arqueo o no 🙏');
        console.log(`Factura de ${from}: dijo efectivo sin aclarar caja/reserva, se le pidió que aclare.`);
        return;
      }
      if (interpretacion.confirma && interpretacion.medioPago) {
        pendingFacturas.delete(soloDigitos(from));
        const resultadoCarga = await cargarFacturaEnFudo(
          facturaPendiente.datos,
          interpretacion.medioPago,
          interpretacion.useInCashCount
        );
        const facturas = loadFacturas();
        facturas.push({
          id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          datos: facturaPendiente.datos,
          medioPago: interpretacion.medioPago,
          useInCashCount: interpretacion.useInCashCount,
          cargadoPor: from,
          cargadaEnFudo: resultadoCarga.ok,
          gastoIdFudo: resultadoCarga.gastoId || null,
          stockAplicado: false,
          creadaEn: new Date().toISOString(),
        });
        saveFacturas(facturas);
        agregarMensajeInbox(from, "cliente", textoRespuestaFactura);
        const avisoFinal = resultadoCarga.ok
          ? "¡Listo, la cargué en FUDO! 🧾✅ (el stock lo actualizamos después a mano desde el panel, si corresponde)"
          : `¡Anotado! Por ahora la guardé en nuestro registro, pero no la pude cargar sola en FUDO (${resultadoCarga.motivo}) — hace falta cargarla a mano 🙏`;
        await sendWhatsappText(from, avisoFinal);
        console.log(`Factura confirmada y ${resultadoCarga.ok ? "cargada en FUDO" : "guardada localmente (falló la carga: " + resultadoCarga.motivo + ")"} — enviada por ${from}.`);
      } else if (interpretacion.confirma) {
        // Confirmó pero no mencionó ningún medio de pago reconocible.
        agregarMensajeInbox(from, "cliente", textoRespuestaFactura);
        await sendWhatsappText(from, 'Contame con qué se pagó: "efectivo caja", "efectivo reserva", "mercadopago" o "cuenta corriente" 🙏');
        console.log(`Factura de ${from}: confirmó pero sin medio de pago reconocible, se le pidió que aclare.`);
      } else {
        pendingFacturas.delete(soloDigitos(from));
        agregarMensajeInbox(from, "cliente", textoRespuestaFactura);
        await sendWhatsappText(from, "Dale, mandame la foto de nuevo (o una más clara) así la vuelvo a leer 🙏");
        console.log(`Factura rechazada/corrección pedida por ${from}: "${textoRespuestaFactura}"`);
      }
      return;
    }

    // ¿Y este mensaje es una foto o PDF de alguien con permiso para cargar facturas? La
    // leemos con IA y le mostramos el resumen para que confirme antes de cargar nada.
    const personaFactura = equipoPorTelefono(config, from);
    if (personaFactura && personaFactura.cargaFacturas && (message.type === "image" || message.type === "document")) {
      const mediaId = message.type === "image" ? message.image?.id : message.document?.id;
      if (mediaId) {
        await sendWhatsappText(from, "Dale, dejame leer la factura... 🧾⏳");
        const { base64, mimeType } = await downloadWhatsappMedia(mediaId);
        const datosFactura = await leerFacturaConClaude(base64, mimeType);
        if (datosFactura && Array.isArray(datosFactura.items) && datosFactura.items.length > 0) {
          const resumenFactura = construirResumenFactura(datosFactura);
          await sendWhatsappText(from, resumenFactura);
          agregarMensajeInbox(from, "chaparrita", resumenFactura);
          await sendWhatsappList(from, "¿Cómo se pagó?", "Elegir medio de pago", [
            {
              titulo: "Medio de pago",
              filas: [
                { id: "factura_efectivo_caja", titulo: "Efectivo caja", desc: "Sale de la caja física de Chaparrita" },
                { id: "factura_efectivo_reserva", titulo: "Efectivo reserva", desc: "Sale de tu reserva personal" },
                { id: "factura_mercadopago", titulo: "Mercadopago", desc: "" },
                { id: "factura_cuenta_corriente", titulo: "Cuenta corriente", desc: "Queda a fiado con el proveedor" },
              ],
            },
          ]);
          pendingFacturas.set(soloDigitos(from), { datos: datosFactura, creadaEn: Date.now() });
        } else {
          await sendWhatsappText(from, "No pude leer bien esa factura 😕 ¿Podés mandarla de nuevo, más clara o mejor iluminada?");
        }
        return;
      }
    }

    // ¿Este mensaje viene de alguien que tiene un pedido pendiente de confirmar? Si es así,
    // tomamos su respuesta como esa confirmación (no como si fuera un cliente nuevo). El
    // trato es distinto según el tipo: a cocina se le pregunta si recibió la comanda
    // impresa (sí/no); al cajero/operador se le pide el número de pedido + link de FUDO,
    // que se le reenvía tal cual al cliente como confirmación de seguimiento.
    // Importante: si el mensaje es largo o tiene varios renglones, probablemente NO sea
    // una confirmación corta sino, por ejemplo, la lista de compras de cocina/barra/salón
    // — en ese caso lo dejamos pasar de largo para que lo procese esa otra parte del código,
    // en vez de "comerse" el mensaje acá.
    const telQuienResponde = soloDigitos(from);
    const pareceConfirmacionCorta = message.type === "text" && message.text.body.trim().length <= 60 && (message.text.body.match(/\n/g) || []).length <= 1;
    if (pareceConfirmacionCorta && pendingComandas.has(telQuienResponde) && pendingComandas.get(telQuienResponde).length > 0) {
      // pendingComandas hoy contiene dos tipos de control: confirmación de reserva agendada,
      // y confirmación de cocina de que le llegó bien la comanda impresa (el viejo caso
      // "cajero" con número de pedido + link de FUDO se sacó, quedó obsoleto al integrar
      // el pedido automático con FUDO).
      const cola = pendingComandas.get(telQuienResponde);
      const confirmado = cola.shift();
      if (cola.length === 0) {
        pendingComandas.delete(telQuienResponde);
      } else {
        pendingComandas.set(telQuienResponde, cola);
      }

      const textoRespuesta = message.text.body;
      const personaQueConfirma = equipoPorTelefono(config, from);
      agregarMensajeInbox(from, "cliente", textoRespuesta, personaQueConfirma ? personaQueConfirma.nombre : "");
      console.log(`Comanda ${confirmado.id} (tipo ${confirmado.tipo}) respondida por ${from}: "${textoRespuesta}"`);

      const avisoRestante = cola.length > 0 ? ` Todavía te queda${cola.length === 1 ? "" : "n"} ${cola.length} pedido${cola.length === 1 ? "" : "s"} más por confirmar.` : "";

      if (confirmado.tipo === "comanda_cocina") {
        const dijoQueNoLlego = /\bno\b/i.test(textoRespuesta) && !/\bsi\b|\bsí\b/i.test(textoRespuesta);
        if (dijoQueNoLlego) {
          await sendWhatsappText(from, `Anotado, gracias por avisar 🙏 Revisá la impresora — si hace falta, pedile el pedido de nuevo a quien lo cargó.${avisoRestante}`);
        } else {
          await sendWhatsappText(from, `¡Buenísimo, gracias por confirmar! 👨‍🍳${avisoRestante}`);
        }
      } else {
        // Control puramente interno: el cliente ya recibió su confirmación normal del bot
        // cuando se armó la reserva, acá no le mandamos nada más.
        await sendWhatsappText(from, `¡Buenísimo, gracias por confirmar que quedó agendada! 🙌${avisoRestante}`);
      }
      return;
    }

    // ¿Este mensaje viene de cocina, barra o salón (cajera)? Si es así, y no era sobre un
    // comprobante (ya se manejó arriba), lo tratamos como pedido de compras — no pasa por
    // Claude, y sus ítems se categorizan y se suman a la lista al instante.
    const rolCompras = rolDeComprasSegunTelefono(config, from);
    if (rolCompras && message.type === "text") {
      const fechaHoyCompras = fechaDeHoyISOArgentina();
      const listaCompras = loadListaCompras(fechaHoyCompras);
      const telRolActual = soloDigitos(from);

      // Si le habíamos preguntado cantidades de algún ítem, este mensaje es la aclaración:
      // sacamos los ítems viejos (sin cantidad) y los reemplazamos por lo que conteste ahora.
      const aclaracionPendiente = pendingCantidadCompras.get(telRolActual);
      if (aclaracionPendiente) {
        pendingCantidadCompras.delete(telRolActual);
        listaCompras.items = listaCompras.items.filter((item) => !aclaracionPendiente.ids.includes(item.id));
      }

      listaCompras.envios[rolCompras] = { recibido: true, textoOriginal: message.text.body };

      const itemsNuevos = await categorizarPedidoIndividual(message.text.body);
      const idsSinCantidad = [];
      itemsNuevos.forEach((item) => {
        const nuevoId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        listaCompras.items.push({
          id: nuevoId,
          texto: item.texto,
          categoria: item.categoria || "Otros",
          comprado: false,
          origen: rolCompras,
        });
        if (item.cantidadClara === false) idsSinCantidad.push(nuevoId);
      });
      saveListaCompras(listaCompras);

      const personaCompras = equipoPorAreaCompras(config, rolCompras);
      agregarMensajeInbox(from, "cliente", message.text.body, personaCompras ? personaCompras.nombre : "");
      console.log(`Pedido de compras recibido de ${rolCompras} (${from}) — ${itemsNuevos.length} ítem(s) sumados a la lista (${idsSinCantidad.length} sin cantidad clara).`);

      if (idsSinCantidad.length > 0 && !aclaracionPendiente) {
        // Solo repreguntamos una vez por tanda, para no generar un ida y vuelta infinito
        // si la persona vuelve a contestar sin cantidad.
        const textosSinCantidad = itemsNuevos.filter((i) => i.cantidadClara === false).map((i) => i.texto);
        pendingCantidadCompras.set(telRolActual, { ids: idsSinCantidad, rol: rolCompras });
        await sendWhatsappText(
          from,
          `¡Recibido! 📝 Ya anoté la mayoría, pero no me quedó clara la cantidad de: ${textosSinCantidad.join(", ")}. ¿Me decís cuánto necesitás de cada uno? 🙏`
        );
      } else {
        const avisoRecibido = itemsNuevos.length > 0
          ? "¡Recibido! 📝 Ya anoté tu pedido de compras para hoy, gracias 🙌"
          : "¡Recibido! 📝 Igual no pude identificar ítems concretos en tu mensaje — si hace falta, mandalo de nuevo con el detalle de lo que necesitás 🙌";
        await sendWhatsappText(from, avisoRecibido);
      }
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

    // Preferimos el menú con precios REALES de FUDO (para que nunca se desincronice con
    // lo que después se carga en el pedido); si por algún motivo no se puede traer,
    // usamos el PDF cargado a mano como respaldo.
    const menuFudo = await construirMenuDesdeFudo();
    const menuText = menuFudo || loadMenuText();
    const diaHoy = diaDeHoyArgentina();
    const fechaHoy = fechaDeHoyISOArgentina();
    const horaActual = horaActualArgentina();
    const promosHoy = (config.promosDia && config.promosDia[diaHoy]) ? config.promosDia[diaHoy].filter((p) => p.activa) : [];
    const clientes = loadClientes();
    const perfilCliente = buscarCliente(clientes, from) || null;
    const esDueño = equipoConPermiso(config, "esDueño").some((p) => soloDigitos(p.telefono) === soloDigitos(from));
    // Cualquiera con "Recibe confirmación de reservas" puede pedir el resumen de reservas
    // (además del dueño, que ya tiene todo lo demás).
    const esAdminReservas = esDueño || equipoConPermiso(config, "recibeReservas").some((p) => soloDigitos(p.telefono) === soloDigitos(from));
    let replyText = await askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño, esAdminReservas);
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
      replyText = await askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño, esAdminReservas);
      console.log(`Respuesta de Claude tras consultar disponibilidad (${replyText.length} caracteres):`, replyText.slice(0, 200));
    }

    // Si Claude quiere ver las reservas que ya tiene cargadas este cliente (para
    // confirmarle si están hechas, o para poder modificarlas/cancelarlas), se las
    // pasamos al instante, en el mismo ida y vuelta que la disponibilidad de mesas.
    const { cleanText: sinConsultaReservas, quiereConsultarReservas } = extractConsultarReservasMarker(replyText);
    if (quiereConsultarReservas) {
      const reservasCliente = loadReservas()
        .filter((r) => soloDigitos(r.telefono) === soloDigitos(from))
        .map((r) => {
          const minutosRestantes = minutosHastaReserva(r.fecha, r.hora);
          return {
            id: r.id,
            fecha: r.fecha,
            hora: r.hora,
            personas: r.personas,
            sector: r.sector,
            promocion: r.promocion || "",
            puedeCambiarPersonasSectorOFechaHora: minutosRestantes >= 120,
            puedeCambiarPromoOMenu: minutosRestantes >= 1440,
            puedeCancelar: minutosRestantes >= 120,
          };
        });
      console.log(`Cliente ${from} consultó sus reservas — se encontraron ${reservasCliente.length}.`);

      if (sinConsultaReservas) {
        history.push({ role: "assistant", content: [{ type: "text", text: sinConsultaReservas }] });
      }
      history.push({
        role: "user",
        content: [{
          type: "text",
          text: `[[DATOS_MIS_RESERVAS: ${JSON.stringify(reservasCliente)}]] (Esto es información interna del sistema, no un mensaje real del cliente — es la lista real de sus reservas cargadas, con el "id" de cada una para poder modificarla o cancelarla si lo pide. Los campos "puedeCambiarPersonasSectorOFechaHora", "puedeCambiarPromoOMenu" y "puedeCancelar" ya tienen calculado si todavía está en horario permitido para cada tipo de cambio (true/false) — confiá en estos valores tal cual, no calcules vos el tiempo restante. Si la lista está vacía, es que no tiene ninguna reserva cargada. Usalo para responder de forma natural.)`,
        }],
      });
      replyText = await askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño, esAdminReservas);
      console.log(`Respuesta de Claude tras consultar reservas del cliente (${replyText.length} caracteres):`, replyText.slice(0, 200));
    }

    // Si el dueño pidió el resumen (o el estado) de la lista de compras del día, la
    // consolidamos (si hace falta), le avisamos a quien todavía no mandó su pedido, y le
    // devolvemos el detalle real — nunca inventado — para que Claude arme la respuesta.
    const { cleanText: sinConsultaCompras, quiereListaCompras } = extractConsultarListaComprasMarker(replyText);
    if (quiereListaCompras) {
      const fechaHoyCompras = fechaDeHoyISOArgentina();
      const listaCompras = loadListaCompras(fechaHoyCompras);
      // Los ítems ya se van sumando en tiempo real apenas cada rol manda su pedido
      // (ver el bloque de arriba), así que acá solo leemos lo que ya está armado.

      const rolesFaltantes = ROLES_COMPRAS.filter((r) => !listaCompras.envios[r].recibido);
      for (const rol of rolesFaltantes) {
        const staffDelRol = equipoPorAreaCompras(config, rol);
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
      replyText = await askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño, esAdminReservas);
      console.log(`Respuesta de Claude tras consultar lista de compras (${replyText.length} caracteres):`, replyText.slice(0, 200));
    }

    // Si Administración/el dueño pidió un resumen de reservas (del día, la semana o el
    // mes), se lo armamos con los datos reales y se lo mandamos como mensaje aparte,
    // prolijo, además de la respuesta conversacional.
    const { cleanText: sinResumenReservas, resumenPedido } = extractResumenReservasMarker(replyText);
    if (resumenPedido && esAdminReservas) {
      const periodo = ["dia", "semana", "mes"].includes(resumenPedido.periodo) ? resumenPedido.periodo : "dia";
      const fechaHoyResumen = fechaDeHoyISOArgentina();
      const reservasDelPeriodo = loadReservas()
        .filter((r) => reservaEstaEnPeriodo(r.fecha, periodo, fechaHoyResumen))
        .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));

      const NOMBRE_PERIODO = { dia: "de hoy", semana: "de esta semana", mes: "de este mes" };
      let mensajeResumen;
      if (reservasDelPeriodo.length === 0) {
        mensajeResumen = `📅 No hay reservas cargadas ${NOMBRE_PERIODO[periodo]}.`;
      } else {
        mensajeResumen = `📅 *Reservas ${NOMBRE_PERIODO[periodo]}* (${reservasDelPeriodo.length})\n\n`;
        reservasDelPeriodo.forEach((r) => {
          mensajeResumen += `• ${r.fecha} ${r.hora}hs — ${r.nombre || "(sin nombre)"} (${r.personas || "?"} pers., ${r.sector || "sector a confirmar"})${r.promocion ? ` — ${r.promocion}` : ""}\n`;
        });
      }

      await sendWhatsappText(from, mensajeResumen);
      agregarMensajeInbox(from, "chaparrita", mensajeResumen);
      console.log(`Resumen de reservas (${periodo}) enviado a ${from}: ${reservasDelPeriodo.length} reserva(s).`);

      if (sinResumenReservas) {
        history.push({ role: "assistant", content: [{ type: "text", text: sinResumenReservas }] });
      }
      history.push({
        role: "user",
        content: [{ type: "text", text: `[[RESUMEN_RESERVAS_ENVIADO]] (Información interna: el resumen ya se mandó como mensaje aparte con el formato prolijo. Solo dale una respuesta corta y natural de cierre, no repitas la lista.)` }],
      });
      replyText = await askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño, esAdminReservas);
      console.log(`Respuesta de Claude tras enviar resumen de reservas (${replyText.length} caracteres):`, replyText.slice(0, 200));
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
    const { cleanText: sinMarcado, marcarComprado } = extractMarcarCompradoMarker(sinCancelacion);
    const { cleanText: sinBotones, botones } = extractBotonesMarker(sinMarcado);
    const { cleanText: cleanText2, lista } = extractListaMarker(sinBotones);

    history.push({ role: "assistant", content: [{ type: "text", text: cleanText2 }] });
    conversations.set(from, history);

    await sendWhatsappText(from, cleanText2);
    agregarMensajeInbox(from, "chaparrita", cleanText2);

    // Si Claude pidió botones o una lista en su respuesta, se los mandamos justo después del
    // mensaje de texto normal — el cliente los ve como una segunda "burbuja" con las opciones
    // tocables. Si toca una, el webhook ya la convierte en texto normal antes de procesarla,
    // así que el resto de la conversación sigue exactamente igual que si la hubiese escrito.
    if (botones) {
      await sendWhatsappButtons(
        from,
        botones.texto,
        botones.opciones.slice(0, 3).map((op, idx) => ({ id: `libre_${idx}`, titulo: op }))
      );
    } else if (lista) {
      await sendWhatsappList(from, lista.texto, lista.textoBoton || "Elegir", [
        {
          titulo: "Opciones",
          filas: lista.opciones.slice(0, 10).map((op, idx) => ({ id: `libre_${idx}`, titulo: op.titulo, desc: op.desc || "" })),
        },
      ]);
    }

    if (reservaConfirmada && config.grupoReservasWhatsappId) {
      await sendWhatsappText(config.grupoReservasWhatsappId, reservaConfirmada);
    }

    // Aviso individual al staff (alternativa que sí funciona con Cloud API, que no
    // soporta mandar mensajes a grupos de WhatsApp reales).
    if (reservaConfirmada) {
      // Identificamos la reserva por teléfono + fecha + hora (no por el texto completo,
      // que puede variar levemente entre una respuesta de Claude y otra) — si ya avisamos
      // de esta misma reserva hace poco, no lo repetimos (por ejemplo si el cliente
      // confirma varias veces seguidas). Preferimos los datos estructurados de
      // RESERVA_DATOS si vinieron en este mismo turno, pero si Claude no los reenvía (por
      // ejemplo en una reconfirmación donde solo repite el cierre), sacamos fecha y hora
      // directo del texto del resumen como respaldo — así el filtro nunca se queda sin
      // identificador para comparar.
      const fechaTextoMatch = reservaConfirmada.match(/Fecha:\s*(.+)/);
      const horaTextoMatch = reservaConfirmada.match(/Horario de llegada:\s*(.+)/);
      const fechaHoraReserva = datosReserva
        ? `${datosReserva.fecha}|${datosReserva.hora}`
        : (fechaTextoMatch && horaTextoMatch ? `${fechaTextoMatch[1].trim()}|${horaTextoMatch[1].trim()}` : null);
      const registroReservaAnterior = ultimaReservaAvisadaPorCliente.get(soloDigitos(from));
      const esReservaYaAvisada =
        fechaHoraReserva &&
        registroReservaAnterior &&
        registroReservaAnterior.fechaHora === fechaHoraReserva &&
        Date.now() - registroReservaAnterior.avisadoEn < VENTANA_DEDUP_RESERVA_MS;

      if (esReservaYaAvisada) {
        console.log(`Aviso de reserva ya enviado antes para ${from} (${fechaHoraReserva}) — se ignora, no se repite.`);
      } else {
        if (fechaHoraReserva) {
          ultimaReservaAvisadaPorCliente.set(soloDigitos(from), { fechaHora: fechaHoraReserva, avisadoEn: Date.now() });
        }
        const avisosActivos = equipoConPermiso(config, "recibeReservas");
        const idComandaReserva = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        for (const aviso of avisosActivos) {
          const telAviso = soloDigitos(aviso.telefono);
          await sendWhatsappText(telAviso, reservaConfirmada);
          await sendWhatsappButtons(telAviso, "¿Me confirmás que ya quedó agendada?", [
            { id: "reserva_confirmada", titulo: "Sí, confirmado ✅" },
          ]);
          const cola = pendingComandas.get(telAviso) || [];
          cola.push({ id: idComandaReserva, tipo: "reserva", resumen: reservaConfirmada, clientePhone: from, creadaEn: Date.now() });
          pendingComandas.set(telAviso, cola);
        }
        if (avisosActivos.length > 0) {
          console.log(`Aviso de reserva confirmada enviado a ${avisosActivos.length} persona(s) del equipo, pidiendo confirmación de agenda.`);
        }
      }
    }

    if (pedidoConfirmado) {
      // Si es (aproximadamente) el mismo pedido que ya procesamos hace poco para este
      // mismo cliente (por ejemplo, escribió "sí" o "confirmo" varias veces seguidas),
      // no lo volvemos a cargar ni a avisarle a nadie de nuevo. Comparamos solo los
      // ÍTEMS normalizados y ordenados alfabéticamente (no el texto completo del resumen,
      // ni el orden en que Claude los haya listado), para no fallar por diferencias
      // mínimas de formato entre una confirmación y otra, sin bloquear un pedido
      // genuinamente distinto que llegue poco después de otro.
      const itemsDeEstePedido = (pedidoConfirmado.match(/Ítems:\s*(.+)/i) || [])[1] || pedidoConfirmado;
      const itemsNormalizados = normalizarItemsParaComparar(itemsDeEstePedido);
      const registroAnterior = ultimoPedidoConfirmadoPorCliente.get(soloDigitos(from));
      const msDesdeUltimoPedido = registroAnterior ? Date.now() - registroAnterior.procesadoEn : Infinity;
      const esPedidoDuplicado =
        registroAnterior &&
        registroAnterior.itemsNormalizados === itemsNormalizados &&
        msDesdeUltimoPedido < VENTANA_DEDUP_PEDIDO_MS;

      if (esPedidoDuplicado) {
        console.log(`Pedido duplicado detectado para ${from} (hace ${Math.round(msDesdeUltimoPedido / 1000)}s) — se ignora, no se vuelve a cargar.`);
      } else {
        ultimoPedidoConfirmadoPorCliente.set(soloDigitos(from), { itemsNormalizados, procesadoEn: Date.now() });

      const avisosPedido = equipoConPermiso(config, "recibePedidos");

      // Intentamos crear el pedido automáticamente en FUDO primero. Si no se puede (por
      // cualquier motivo: catálogo no matcheado, error de red, etc.), seguimos con el
      // flujo manual de siempre — el pedido nunca se pierde.
      const itemsMatchFudo = pedidoConfirmado.match(/Ítems:\s*(.+)/);
      const entregaMatchFudo = pedidoConfirmado.match(/Entrega:\s*(Retiro en el local|Delivery a (.+))/i);
      const esDeliveryFudo = !!(entregaMatchFudo && /delivery/i.test(entregaMatchFudo[1]));
      const direccionFudo = esDeliveryFudo && entregaMatchFudo[2] ? entregaMatchFudo[2].trim() : "";

      // Mapeamos la forma de pago en texto libre al ID numérico que usa FUDO internamente.
      const formaPagoMatchFudo = pedidoConfirmado.match(/Forma de pago:\s*(.+)/i);
      const totalMatchFudo = pedidoConfirmado.match(/Total aproximado:\s*\$?\s*([\d.,]+)/i);
      const mediosPagoFudo = config.fudoMediosPago || {};
      let medioPagoIdFudo = null;
      if (formaPagoMatchFudo) {
        const textoForma = formaPagoMatchFudo[1].toLowerCase();
        if (textoForma.includes("efectivo")) medioPagoIdFudo = mediosPagoFudo.efectivo;
        else if (textoForma.includes("transfer")) medioPagoIdFudo = mediosPagoFudo.transferencia;
        else if (textoForma.includes("link")) medioPagoIdFudo = mediosPagoFudo.linkDePago;
      }
      const totalAproxFudo = totalMatchFudo ? totalMatchFudo[1].replace(/\./g, "").replace(",", ".") : null;

      let resultadoFudo = { ok: false };
      if (itemsMatchFudo) {
        resultadoFudo = await crearPedidoEnFudo({
          itemsTexto: itemsMatchFudo[1],
          nombreCliente: (perfilCliente && perfilCliente.nombre) || "",
          telefonoCliente: from,
          tipo: esDeliveryFudo ? "delivery" : "pickup",
          direccion: direccionFudo,
          medioPagoId: medioPagoIdFudo,
          totalAprox: totalAproxFudo,
        });
      }

      for (const aviso of avisosPedido) {
        const telAviso = soloDigitos(aviso.telefono);
        const esCocina = aviso.areaCompras === "cocina";
        if (esCocina) {
          // A cocina le llega el pedido normal, y le pedimos que confirme que le llegó
          // bien la comanda impresa — es un control real (si dice que no, puede ser que
          // falló la impresora), distinto del viejo pedido de número+link que ya no hace
          // falta (ese se sacó al integrar el pedido automático con FUDO).
          await sendWhatsappText(telAviso, pedidoConfirmado);
          await sendWhatsappButtons(telAviso, "¿Te llegó bien la comanda impresa?", [
            { id: "comanda_recibida", titulo: "Sí, recibida ✅" },
            { id: "comanda_no_recibida", titulo: "No, revisar 🖨️" },
          ]);
          const colaCocina = pendingComandas.get(telAviso) || [];
          colaCocina.push({
            id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
            tipo: "comanda_cocina",
            resumen: pedidoConfirmado,
            clientePhone: from,
            creadaEn: Date.now(),
          });
          pendingComandas.set(telAviso, colaCocina);
        } else if (resultadoFudo.ok) {
          // Ya se cargó solo en FUDO — le avisamos, pero no hace falta pedirle nada más.
          await sendWhatsappText(telAviso, `✅ Este pedido ya se cargó solo en FUDO:\n\n${pedidoConfirmado}`);
        } else {
          // El auto-cargado a FUDO falló — se lo pasamos igual para que lo carguen a mano,
          // pero ya no hace falta pedirle que tipee el número de pedido/link de vuelta acá
          // (con la integración a FUDO ese paso quedó obsoleto).
          await sendWhatsappText(telAviso, `⚠️ Este pedido no se pudo cargar solo en FUDO, hace falta cargarlo a mano:\n\n${pedidoConfirmado}`);
        }
      }

      if (resultadoFudo.ok) {
        await sendWhatsappText(from, `¡Tu pedido ya está cargado en el sistema! 📦 Ya lo tenemos en preparación.`);
        const ordenesFudo = loadFudoOrdenes();
        ordenesFudo[resultadoFudo.fudoOrderId] = {
          telefono: from,
          nombre: (perfilCliente && perfilCliente.nombre) || "",
          creadoEn: new Date().toISOString(),
        };
        saveFudoOrdenes(ordenesFudo);
      }

      if (avisosPedido.length > 0) {
        console.log(`Pedido confirmado enviado a ${avisosPedido.length} persona(s) del equipo (FUDO: ${resultadoFudo.ok ? "creado automáticamente" : "falló, flujo manual"}).`);
      } else {
        console.log("Hubo un pedido confirmado pero nadie del equipo tiene marcado \"Recibe pedidos\".");
      }
      } // cierre del "if (!esPedidoDuplicado)"
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

        // Si fue delivery, guardamos la dirección para poder ofrecerla de nuevo la próxima
        // vez ("¿te la mandamos a tu dirección de siempre?"), sin tener que preguntarla de cero.
        const direccionMatch = pedidoConfirmado.match(/Entrega:\s*Delivery a (.+)/i);
        if (direccionMatch) {
          cliente.ultimaDireccion = direccionMatch[1].trim();
        }
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
      // Si ya existe una reserva para este mismo cliente en la misma fecha y hora, la
      // actualizamos en vez de crear una nueva — evita duplicados si el cliente confirma
      // más de una vez (por ejemplo, dice "sí" dos veces seguidas).
      const existente = reservas.find(
        (r) => soloDigitos(r.telefono) === soloDigitos(from) && r.fecha === datosReserva.fecha && r.hora === datosReserva.hora
      );
      if (existente) {
        existente.nombre = datosReserva.nombre || existente.nombre;
        existente.sector = (datosReserva.sector || existente.sector || "").toLowerCase();
        existente.personas = datosReserva.personas || existente.personas;
        if (datosReserva.promocion) existente.promocion = datosReserva.promocion;
        saveReservas(reservas);
        console.log(`Reserva existente actualizada (no duplicada): ${existente.nombre} - ${existente.fecha} ${existente.hora}`);
      } else {
        reservas.push({
          id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          telefono: from,
          nombre: datosReserva.nombre || "",
          fecha: datosReserva.fecha,
          hora: datosReserva.hora,
          sector: (datosReserva.sector || "").toLowerCase(),
          personas: datosReserva.personas || null,
          promocion: datosReserva.promocion || "",
          recordatorioEnviado: false,
          creadaEn: new Date().toISOString(),
        });
        saveReservas(reservas);
        console.log(`Reserva guardada para recordatorio: ${datosReserva.nombre} - ${datosReserva.fecha} ${datosReserva.hora} (sector: ${datosReserva.sector || "sin especificar"})`);
      }
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
    // verificamos que el teléfono coincida antes de aplicar cualquier cambio, y respetamos
    // las ventanas horarias: 2hs antes para personas/sector/fecha/hora, 24hs para promo/menú).
    if (actualizacion && actualizacion.id) {
      const reservasParaEditar = loadReservas();
      const reservaAEditar = reservasParaEditar.find((r) => r.id === actualizacion.id && soloDigitos(r.telefono) === soloDigitos(from));
      if (reservaAEditar) {
        const minutosRestantes = minutosHastaReserva(reservaAEditar.fecha, reservaAEditar.hora);
        const pideCambioPersonasSectorOFechaHora = actualizacion.fecha || actualizacion.hora || actualizacion.personas || actualizacion.sector;
        const pideCambioPromo = !!actualizacion.promocion;

        if (pideCambioPersonasSectorOFechaHora && minutosRestantes < 120) {
          console.log(`Reserva ${reservaAEditar.id}: se rechazó el cambio de personas/sector/fecha/hora — solo faltan ${minutosRestantes} min (mínimo 120).`);
        } else {
          const cambioFechaUHora = (actualizacion.fecha && actualizacion.fecha !== reservaAEditar.fecha) || (actualizacion.hora && actualizacion.hora !== reservaAEditar.hora);
          if (actualizacion.fecha) reservaAEditar.fecha = actualizacion.fecha;
          if (actualizacion.hora) reservaAEditar.hora = actualizacion.hora;
          if (actualizacion.personas) reservaAEditar.personas = Number(actualizacion.personas);
          if (actualizacion.sector) reservaAEditar.sector = actualizacion.sector.toLowerCase();
          if (cambioFechaUHora) reservaAEditar.recordatorioEnviado = false; // para que el recordatorio salga en el nuevo horario
        }

        if (pideCambioPromo) {
          if (minutosRestantes < 1440) {
            console.log(`Reserva ${reservaAEditar.id}: se rechazó el cambio de promo/menú — solo faltan ${minutosRestantes} min (mínimo 1440).`);
          } else {
            reservaAEditar.promocion = actualizacion.promocion;
          }
        }

        saveReservas(reservasParaEditar);
        console.log(`Reserva ${reservaAEditar.id} procesada (cambios pedidos: ${JSON.stringify(actualizacion)}).`);
      } else {
        console.log(`El cliente ${from} pidió actualizar la reserva ${actualizacion.id}, pero no se encontró o no le pertenece.`);
      }
    }

    // Si el cliente pidió cancelar una reserva ya cargada (misma verificación de seguridad,
    // más la ventana de 2hs antes).
    if (cancelacion && cancelacion.id) {
      const reservasParaCancelar = loadReservas();
      const reservaACancelar = reservasParaCancelar.find((r) => r.id === cancelacion.id && soloDigitos(r.telefono) === soloDigitos(from));
      if (reservaACancelar) {
        const minutosRestantes = minutosHastaReserva(reservaACancelar.fecha, reservaACancelar.hora);
        if (minutosRestantes < 120) {
          console.log(`Reserva ${cancelacion.id}: se rechazó la cancelación — solo faltan ${minutosRestantes} min (mínimo 120).`);
        } else {
          saveReservas(reservasParaCancelar.filter((r) => r.id !== cancelacion.id));
          console.log(`Reserva ${cancelacion.id} cancelada por el cliente ${from}.`);
        }
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
      const staffPhones = equipoConPermiso(config, "confirmaComprobantes")
        .map((s) => soloDigitos(s.telefono))
        .filter((tel) => tel && tel.length >= 10);
      const captionAviso = `📎 Comprobante recibido de +${from}. Revisá y confirmá el pago cuando puedas — el cliente ya está esperando la confirmación.`;
      for (const tel of staffPhones) {
        if (message.type === "image") {
          await sendWhatsappImage(tel, message.image.id, captionAviso);
        } else {
          await sendWhatsappDocument(tel, message.document.id, captionAviso, message.document.filename || "comprobante.pdf");
        }
        // Las imágenes/documentos no admiten botones en el mismo mensaje (limitación de
        // WhatsApp), así que los botones van en un mensaje aparte, justo después. Si el
        // motivo del rechazo no encaja en un botón, el staff igual puede escribirlo como
        // texto libre — el flujo de arriba lo sigue aceptando igual que antes.
        await sendWhatsappButtons(tel, "¿Confirmás el pago? (o escribime el motivo si hay algún problema)", [
          { id: "comprobante_confirmado", titulo: "Sí, confirmado ✅" },
          { id: "comprobante_rechazado", titulo: "No, hay problema" },
        ]);
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
  if (!meta.url) {
    // Causa más común: el WHATSAPP_TOKEN venció (los temporales de Meta duran 24hs) o no
    // tiene permiso sobre este número — hay que generar uno nuevo y actualizar la variable.
    console.error("No se pudo obtener la URL del archivo de WhatsApp. Respuesta de Meta:", JSON.stringify(meta));
    throw new Error("WhatsApp no devolvió la URL del archivo — revisar si WHATSAPP_TOKEN venció o es inválido");
  }
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { base64: buffer.toString("base64"), mimeType: meta.mime_type };
}

// ==================== Llamada a la API de Claude ====================
async function askClaude(history, config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño, esAdminReservas) {
  const promptPartes = buildSystemPrompt(config, menuText, promosHoy, diaHoy, fechaHoy, horaActual, perfilCliente, esDueño, esAdminReservas);
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
      // El bloque "estatico" es idéntico en TODOS los mensajes de TODAS las conversaciones
      // (mismo menú, mismas reglas) — con cache_control, Anthropic lo cachea y lo cobra mucho
      // más barato a partir del segundo uso (dura 5 minutos, se renueva con cada uso). Solo el
      // bloque "dinamico" (hora actual, perfil del cliente) se manda fresco cada vez.
      system: [
        { type: "text", text: promptPartes.estatico, cache_control: { type: "ephemeral" } },
        { type: "text", text: promptPartes.dinamico },
      ],
      messages: history,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Error de la API de Claude:", data);
    return "Uy, tuvimos un problemita técnico. En un rato te contesto, disculpá.";
  }
  if (data.usage) {
    console.log(
      `Uso de tokens — entrada: ${data.usage.input_tokens || 0}, caché creado: ${data.usage.cache_creation_input_tokens || 0}, caché leído (barato): ${
        data.usage.cache_read_input_tokens || 0
      }, salida: ${data.usage.output_tokens || 0}`
    );
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
      .trim();
    const jsonMatchCV = textoRespuesta.match(/\{[\s\S]*\}/);
    if (!jsonMatchCV) {
      console.error("La respuesta de Claude no contenía JSON reconocible al evaluar CV:", textoRespuesta.slice(0, 300));
      return { puntaje: null, resumenExperiencia: "", resumenEducacion: "", disponibilidad: "", comentario: "No se pudo evaluar automáticamente, revisar el CV a mano." };
    }
    return JSON.parse(jsonMatchCV[0]);
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
  // Solo en staging (ES_STAGING=true): le agregamos un aviso arriba de TODOS los mensajes,
  // para nunca confundir si te está contestando el bot de prueba o el real.
  const bodyFinal = ES_STAGING === "true" ? `🧪 [PRUEBA — STAGING]\n${body}` : body;
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
        text: { body: bodyFinal },
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

// Manda hasta 3 botones de respuesta rápida (WhatsApp no permite más de 3 en este formato —
// para más opciones usar sendWhatsappList). Cada botón: {id, titulo} — "titulo" hasta 20
// caracteres, si no WhatsApp lo rechaza. Cuando el cliente toca uno, llega al webhook como
// message.type "interactive" — el código ya lo convierte a texto normal antes de procesar,
// así que el resto del bot no necesita saber que vino de un botón.
async function sendWhatsappButtons(to, bodyText, botones) {
  const destino = normalizarParaEnvioAR(to);
  const bodyTextFinal = ES_STAGING === "true" ? `🧪 [PRUEBA] ${bodyText}` : bodyText;
  const botonesRecortados = botones.slice(0, 3).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: (b.titulo || "").slice(0, 20) },
  }));
  console.log(`Enviando botones a ${destino}: ${botonesRecortados.map((b) => b.reply.title).join(" | ")}`);
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
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyTextFinal },
          action: { buttons: botonesRecortados },
        },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("ERROR al enviar botones por WhatsApp:", JSON.stringify(data));
      return false;
    }
    return true;
  } catch (err) {
    console.error("ERROR de red al enviar botones por WhatsApp:", err.message);
    return false;
  }
}

// Manda una lista desplegable (hasta 10 opciones, más flexible que los botones cuando hay
// más de 3 alternativas). "secciones" es un array de {titulo, filas: [{id, titulo, desc}]}.
async function sendWhatsappList(to, bodyText, textoBoton, secciones) {
  const destino = normalizarParaEnvioAR(to);
  const bodyTextFinal = ES_STAGING === "true" ? `🧪 [PRUEBA] ${bodyText}` : bodyText;
  const seccionesFormateadas = secciones.map((s) => ({
    title: (s.titulo || "").slice(0, 24),
    rows: s.filas.slice(0, 10).map((f) => ({
      id: f.id,
      title: (f.titulo || "").slice(0, 24),
      description: (f.desc || "").slice(0, 72),
    })),
  }));
  console.log(`Enviando lista a ${destino}: ${seccionesFormateadas.map((s) => s.rows.length).join("+")} opción(es)`);
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
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyTextFinal },
          action: { button: (textoBoton || "Elegir").slice(0, 20), sections: seccionesFormateadas },
        },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("ERROR al enviar lista por WhatsApp:", JSON.stringify(data));
      return false;
    }
    return true;
  } catch (err) {
    console.error("ERROR de red al enviar lista por WhatsApp:", err.message);
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

// A diferencia de sendWhatsappDocument (que reenvía un archivo que YA llegó por WhatsApp),
// esta función sube un archivo NUEVO generado por nosotros (ej: un backup) y lo manda —
// primero hay que subirlo a los servidores de Meta, y recién ahí se puede adjuntar a un
// mensaje.
async function subirYEnviarDocumentoWhatsapp(to, buffer, filename, mimetype, caption) {
  const destino = normalizarParaEnvioAR(to);
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([buffer], { type: mimetype }), filename);
    const subida = await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      body: form,
    });
    const datosSubida = await subida.json();
    if (!subida.ok || !datosSubida.id) {
      console.error("ERROR al subir archivo a WhatsApp:", JSON.stringify(datosSubida));
      return false;
    }
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
        document: { id: datosSubida.id, caption, filename },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("ERROR al enviar documento nuevo por WhatsApp:", JSON.stringify(data));
      return false;
    }
    console.log(`Documento "${filename}" subido y enviado a ${destino} OK.`);
    return true;
  } catch (err) {
    console.error("ERROR de red subiendo/enviando documento por WhatsApp:", err.message);
    return false;
  }
}

app.get("/", (_req, res) => res.send("Chaparrita agente — backend activo ✅"));

// ==================== Panel de administración ====================
app.get("/admin", requireAdminPage, (_req, res) => {
  const config = loadConfig();
  const marca = config.panelMarca || {};
  const tituloHero = marca.tituloHero || "Todo Chaparrita, en un solo lugar";
  const subtituloHero = marca.subtituloHero || "Clientes, reservas, pedidos, compras y la configuración del agente — organizado por función, para encontrar todo rápido.";
  const logoHtml = marca.logoBase64
    ? `<img src="${marca.logoBase64}" style="width:100%;height:100%;object-fit:cover;" alt="Logo">`
    : "🌮";

  const CATS = [
    {
      nombre: "Clientes", emoji: "👥", acento: "#2DD4C4",
      items: [
        { href: "/admin/clientes", icono: "👥", titulo: "Clientes conocidos", desc: "Nombres, cumpleaños e historial de pedidos que fue guardando el agente." },
        { href: "/admin/inactivos", icono: "📉", titulo: "Clientes inactivos", desc: "Detecta clientes que dejaron de pedir y te avisa por WhatsApp." },
      ],
    },
    {
      nombre: "Administración del agente", emoji: "🤖", acento: "#E84393",
      items: [
        { href: "/admin/switch", icono: "🔌", titulo: "Prender / apagar el asistente", desc: "Pausalo cuando un operador quiera atender en persona." },
        { href: "/admin/inbox", icono: "💬", titulo: "Atender manualmente", desc: "Vé las conversaciones y respondé vos mismo, sin usar el celular." },
      ],
    },
    {
      nombre: "Administración del negocio", emoji: "🏪", acento: "#FF6B4A",
      items: [
        { href: "/admin/reservas", icono: "📅", titulo: "Reservas", desc: "Vé las reservas del día, editalas o reenviá la confirmación." },
        { href: "/admin/listaespera", icono: "⏳", titulo: "Lista de espera de mesas", desc: "Clientes esperando lugar cuando el sector está lleno." },
        { href: "/admin/compras", icono: "🛒", titulo: "Lista de compras", desc: "Historial por día — tildá lo que ya compraste, agregá o editá ítems." },
        { href: "/admin/facturas", icono: "🧾", titulo: "Facturas de proveedores", desc: "Facturas leídas por foto, pendientes de cargar en FUDO." },
        { href: "/admin/adelantos", icono: "💵", titulo: "Adelantos de sueldo", desc: "Registrá adelantos en efectivo o Mercadopago y mirá cuánto le debés a cada empleado." },
        { href: "/admin/sueldos", icono: "🧾", titulo: "Sueldos mensuales", desc: "Cargá el sueldo de cada mes (con la regla especial de Mariano) y mirá el neto a pagar tras descontar adelantos." },
        { href: "/admin/fudo-stock", icono: "📦", titulo: "Stock, ingredientes y proveedores (FUDO)", desc: "Trae los datos reales de FUDO y permite corregirlos ahí mismo." },
        { href: "/admin/postulantes", icono: "📋", titulo: "Postulantes / CVs", desc: "Gente que dejó su CV, con puntaje automático." },
      ],
    },
    {
      nombre: "Configuración general", emoji: "⚙️", acento: "#F2B705",
      items: [
        { href: "/admin/menu", icono: "📄", titulo: "Actualizar el menú", desc: "Subir un PDF nuevo con precios y productos." },
        { href: "/admin/config", icono: "⚙️", titulo: "Configuración", desc: "Precios, horarios, promos, equipo y teléfonos." },
      ],
    },
  ];

  const seccionesHtml = CATS.map((cat) => `
        <div class="chap-seccion">
          <div class="chap-eyebrow"><span class="dot" style="background:${cat.acento}"></span>${cat.emoji} ${cat.nombre}</div>
          <div class="chap-grid">
            ${cat.items.map((it) => `
            <a class="chap-card" href="${it.href}" style="--acento:${cat.acento}">
              <div class="chap-card-top">
                <div class="chap-icono">${it.icono}</div>
                <b>${it.titulo}</b>
              </div>
              <p>${it.desc}</p>
              <span class="chap-cta" style="color:${cat.acento}">Abrir →</span>
            </a>`).join("")}
          </div>
        </div>`).join("");

  res.type("html").send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Chaparrita — Panel</title>
      <style>${ADMIN_BASE_CSS}
        .marca .icono { background: linear-gradient(135deg, #FF6B4A, #F2B705); }

        .chap-hero { margin: 6px 0 36px; }
        .chap-hero h1 {
          font-size: 30px; font-weight: 800; letter-spacing: -0.6px; margin: 0 0 8px;
          background: linear-gradient(120deg, #2DD4C4, #F2B705 55%, #FF6B4A);
          -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
        }
        .chap-hero p { color: var(--texto-tenue); font-size: 14px; margin: 0; max-width: 520px; line-height: 1.5; }

        .chap-seccion { margin-top: 36px; }
        .chap-seccion:first-of-type { margin-top: 4px; }
        .chap-eyebrow {
          display: flex; align-items: center; gap: 9px; font-size: 11.5px; font-weight: 700;
          text-transform: uppercase; letter-spacing: 1px; color: var(--texto-tenue); margin-bottom: 14px;
        }
        .chap-eyebrow .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

        .chap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; }
        @media (max-width: 560px) {
          .chap-grid { grid-template-columns: 1fr; }
        }
        .chap-card {
          background: var(--card); border: 1px solid var(--borde); border-radius: 16px;
          padding: 20px; display: flex; flex-direction: column; gap: 12px;
          text-decoration: none; color: var(--texto); transition: all .18s ease; position: relative;
        }
        .chap-card:hover { transform: translateY(-3px); box-shadow: var(--sombra); border-color: var(--acento); background: var(--card-hover); }
        .chap-card:focus-visible { outline: 2px solid var(--acento); outline-offset: 2px; }
        .chap-card-top { display: flex; align-items: center; gap: 12px; }
        .chap-icono {
          width: 44px; height: 44px; border-radius: 12px; flex-shrink: 0;
          background: var(--bg-elevado); border: 1px solid var(--borde);
          display: flex; align-items: center; justify-content: center; font-size: 20px;
        }
        .chap-card b { font-size: 15px; font-weight: 700; line-height: 1.3; }
        .chap-card p { font-size: 12.6px; color: var(--texto-tenue); line-height: 1.5; margin: 0; flex: 1; }
        .chap-cta { font-size: 12.5px; font-weight: 700; }
      </style>
    </head>
    <body>
      <div class="contenedor-ancho">
        <div class="topbar">
          <div class="marca">
            <div class="icono">${logoHtml}</div>
            <div><b>Chaparrita</b><span>Panel de administración</span></div>
          </div>
          <a class="logout" href="/admin/logout">Cerrar sesión ⏻</a>
        </div>

        <div class="chap-hero">
          <h1>${tituloHero}</h1>
          <p>${subtituloHero}</p>
          <button id="btnBackupAhora" class="secundario" style="margin-top:12px">📦 Hacer backup ahora</button>
          <span id="msgBackup" style="margin-left:8px;font-size:13px"></span>
        </div>
        <script>
          document.getElementById("btnBackupAhora").addEventListener("click", function(){
            var btn = this; var msg = document.getElementById("msgBackup");
            btn.disabled = true; btn.textContent = "Mandando...";
            fetch("/admin/backup-ahora", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})
              .then(function(r){ return r.json(); })
              .then(function(data){
                btn.disabled = false; btn.textContent = "📦 Hacer backup ahora";
                if (data.error) { msg.textContent = "❌ " + data.error; return; }
                msg.textContent = "✅ Backup enviado por WhatsApp.";
              })
              .catch(function(e){ btn.disabled = false; btn.textContent = "📦 Hacer backup ahora"; msg.textContent = "❌ " + e.message; });
          });
        </script>

        ${seccionesHtml}
      </div>
    </body>
    </html>
  `);
});

app.get("/admin/menu", requireAdminPage, (_req, res) => {
  res.type("html").send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Chaparrita — Actualizar menú</title>
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
      <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${ADMIN_BASE_CSS}</style></head>
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

app.post("/admin/upload-logo", requireAdminApi, upload.single("logoImagen"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ninguna imagen." });
    }
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "El archivo tiene que ser una imagen (PNG, JPG, etc.)." });
    }
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    const config = loadConfig();
    config.panelMarca = config.panelMarca || {};
    config.panelMarca.logoBase64 = base64;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
    console.log(`Logo del panel actualizado desde /admin/config (${Math.round(req.file.buffer.length / 1024)} KB).`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al subir el logo:", err);
    res.status(500).json({ error: "No se pudo guardar la imagen." });
  }
});

// ==================== Switch rápido para prender/apagar el asistente ====================
app.get("/admin/clientes", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
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
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
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
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
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
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
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

// ==================== Panel de lista de compras (ver historial, tildar, agregar y editar) ====================
app.get("/admin/compras", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Chaparrita - Lista de compras</title>',
    `<style>${ADMIN_BASE_CSS}
      .filtro-fecha-row { display: flex; gap: 8px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
      .filtro-fecha-row input[type=date] { margin-top: 0; width: auto; }
      .filtro-fecha-row button { margin-top: 0; }
      .rol-bloque { margin-top: 16px; }
      .rol-titulo { font-weight: 700; font-size: 14px; color: var(--turquesa); display: flex; align-items: center; gap: 8px; }
      .rol-item { display: flex; align-items: center; gap: 10px; padding: 9px 6px; border-bottom: 1px solid var(--borde); }
      .rol-item:last-child { border-bottom: none; }
      .rol-item input[type=checkbox] { width: 18px; height: 18px; flex-shrink: 0; accent-color: var(--verde-wa); }
      .rol-item input[type=text] { margin-top: 0; flex: 1; font-size: 13.5px; }
      .rol-item.comprado input[type=text] { text-decoration: line-through; color: var(--texto-tenue); }
      .rol-item button { margin-top: 0; padding: 5px 9px; font-size: 11.5px; background: transparent; color: var(--coral); border: 1px solid var(--coral); border-radius: 6px; cursor: pointer; flex-shrink: 0; }
      .rol-item button:hover { background: rgba(232,103,74,0.1); }
      .agregar-item-row { display: flex; gap: 8px; margin-top: 10px; }
      .agregar-item-row input[type=text] { margin-top: 0; flex: 1 1 auto; min-width: 0; width: auto; }
      .agregar-item-row select { margin-top: 0; flex: 0 0 auto; width: auto; max-width: 130px; }
      .agregar-item-row button { margin-top: 0; white-space: nowrap; flex: 0 0 auto; }
      @media (max-width: 480px) {
        .agregar-item-row { flex-wrap: wrap; }
        .agregar-item-row input[type=text] { flex: 1 1 100%; }
        .agregar-item-row select { flex: 1 1 auto; max-width: none; }
        .agregar-item-row button { flex: 1 1 auto; }
      }
      .estado-envios { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    </style>`,
    '</head><body>',
    '<div class="contenedor">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>🛒 Lista de compras</h1>',
    '<p class="sub">Se sincroniza con lo que van mandando por WhatsApp cocina, barra y salón. Podés tildar, agregar o editar ítems acá y se refleja también si preguntan por WhatsApp.</p>',
    '<div class="filtro-fecha-row">',
    '  <input type="date" id="filtroFecha" />',
    '  <button class="btn-secondary" id="btnHoy">Hoy</button>',
    '</div>',
    '<div class="estado-envios" id="estadoEnvios"></div>',
    '<div id="msg">Cargando...</div>',
    '<div class="card" id="agregarCard">',
    '  <label>Agregar ítem manualmente</label>',
    '  <div class="agregar-item-row">',
    '    <input type="text" id="nuevoItemTexto" placeholder="Ej: 2 bolsas de hielo" />',
    '    <select id="nuevoItemOrigen">',
    '      <option value="cocina">Cocina</option>',
    '      <option value="barra">Barra</option>',
    '      <option value="salon">Salón</option>',
    '      <option value="otros">Otros</option>',
    '    </select>',
    '    <button class="btn-primary" id="btnAgregarItem">Agregar</button>',
    '  </div>',
    '</div>',
    '<div id="lista"></div>',
    '<script>',
    'var datosDia = null;',
    'var fechaActual = "";',
    'var NOMBRES_ROL = {cocina:"🍳 Cocina", barra:"🍹 Barra", salon:"🛎️ Salón", otros:"📦 Otros"};',
    'function hoyISO() {',
    '  var d = new Date();',
    '  var tz = new Date(d.toLocaleString("en-US", {timeZone:"America/Argentina/Buenos_Aires"}));',
    '  var y = tz.getFullYear(); var m = String(tz.getMonth()+1).padStart(2,"0"); var day = String(tz.getDate()).padStart(2,"0");',
    '  return y + "-" + m + "-" + day;',
    '}',
    'document.getElementById("filtroFecha").value = hoyISO();',
    'function cargar() {',
    '  fechaActual = document.getElementById("filtroFecha").value || hoyISO();',
    '  fetch("/admin/compras-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({fecha: fechaActual})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      datosDia = data.datosDia;',
    '      document.getElementById("msg").textContent = "";',
    '      pintarEstadoEnvios();',
    '      pintar();',
    '    })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msg").textContent = "Error: " + e.message; document.getElementById("msg").className = "msg-error"; } });',
    '}',
    'cargar();',
    'document.getElementById("btnHoy").addEventListener("click", function(){ document.getElementById("filtroFecha").value = hoyISO(); cargar(); });',
    'document.getElementById("filtroFecha").addEventListener("change", cargar);',
    'function pintarEstadoEnvios() {',
    '  var cont = document.getElementById("estadoEnvios");',
    '  cont.innerHTML = "";',
    '  if (!datosDia) return;',
    '  ["cocina","barra","salon"].forEach(function(rol) {',
    '    var recibido = datosDia.envios && datosDia.envios[rol] && datosDia.envios[rol].recibido;',
    '    var span = document.createElement("span");',
    '    span.className = "badge " + (recibido ? "badge-alto" : "badge-pendiente");',
    '    span.textContent = NOMBRES_ROL[rol] + (recibido ? " ✓ recibido" : " · sin enviar");',
    '    cont.appendChild(span);',
    '  });',
    '}',
    'function pintar() {',
    '  var cont = document.getElementById("lista");',
    '  cont.innerHTML = "";',
    '  if (!datosDia || !datosDia.items || datosDia.items.length === 0) {',
    '    cont.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icono\\">🛒</div>No hay ítems cargados para esta fecha.</div>";',
    '    return;',
    '  }',
    '  var porRol = {};',
    '  datosDia.items.forEach(function(item) {',
    '    var rol = item.origen || "otros";',
    '    if (!porRol[rol]) porRol[rol] = [];',
    '    porRol[rol].push(item);',
    '  });',
    '  ["cocina","barra","salon","otros"].forEach(function(rol) {',
    '    if (!porRol[rol] || porRol[rol].length === 0) return;',
    '    var bloque = document.createElement("div");',
    '    bloque.className = "rol-bloque";',
    '    var titulo = document.createElement("div");',
    '    titulo.className = "rol-titulo";',
    '    titulo.textContent = NOMBRES_ROL[rol];',
    '    bloque.appendChild(titulo);',
    '    porRol[rol].forEach(function(item) {',
    '      var fila = document.createElement("div");',
    '      fila.className = "rol-item" + (item.comprado ? " comprado" : "");',
    '      var chk = document.createElement("input");',
    '      chk.type = "checkbox";',
    '      chk.checked = !!item.comprado;',
    '      chk.addEventListener("change", function(){ marcarComprado(item.id, chk.checked); });',
    '      var texto = document.createElement("input");',
    '      texto.type = "text";',
    '      texto.value = item.texto;',
    '      texto.addEventListener("change", function(){ editarTexto(item.id, texto.value); });',
    '      var btnDel = document.createElement("button");',
    '      btnDel.textContent = "Eliminar";',
    '      btnDel.addEventListener("click", function(){ eliminarItem(item.id); });',
    '      fila.appendChild(chk); fila.appendChild(texto); fila.appendChild(btnDel);',
    '      bloque.appendChild(fila);',
    '    });',
    '    cont.appendChild(bloque);',
    '  });',
    '}',
    'function marcarComprado(id, comprado) {',
    '  fetch("/admin/compras-marcar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({fecha: fechaActual, id: id, comprado: comprado})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(){ cargar(); });',
    '}',
    'function editarTexto(id, texto) {',
    '  fetch("/admin/compras-editar-texto", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({fecha: fechaActual, id: id, texto: texto})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(){ cargar(); });',
    '}',
    'function eliminarItem(id) {',
    '  fetch("/admin/compras-eliminar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({fecha: fechaActual, id: id})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(){ cargar(); });',
    '}',
    'document.getElementById("btnAgregarItem").addEventListener("click", function() {',
    '  var texto = document.getElementById("nuevoItemTexto").value.trim();',
    '  var origen = document.getElementById("nuevoItemOrigen").value;',
    '  if (!texto) return;',
    '  fetch("/admin/compras-agregar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({fecha: fechaActual, texto: texto, origen: origen})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(){ document.getElementById("nuevoItemTexto").value = ""; cargar(); });',
    '});',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/compras-data", requireAdminApi, (req, res) => {
  const fecha = req.body.fecha || fechaDeHoyISOArgentina();
  res.json({ fecha, datosDia: peekListaCompras(fecha) });
});

app.post("/admin/compras-marcar", requireAdminApi, (req, res) => {
  try {
    const listaCompras = loadListaCompras(req.body.fecha);
    const item = listaCompras.items.find((i) => i.id === req.body.id);
    if (!item) return res.status(404).json({ error: "Ítem no encontrado" });
    item.comprado = !!req.body.comprado;
    saveListaCompras(listaCompras);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al marcar ítem de compras:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

app.post("/admin/compras-editar-texto", requireAdminApi, (req, res) => {
  try {
    const listaCompras = loadListaCompras(req.body.fecha);
    const item = listaCompras.items.find((i) => i.id === req.body.id);
    if (!item) return res.status(404).json({ error: "Ítem no encontrado" });
    item.texto = req.body.texto;
    saveListaCompras(listaCompras);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al editar ítem de compras:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

app.post("/admin/compras-eliminar", requireAdminApi, (req, res) => {
  try {
    const listaCompras = loadListaCompras(req.body.fecha);
    listaCompras.items = listaCompras.items.filter((i) => i.id !== req.body.id);
    saveListaCompras(listaCompras);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al eliminar ítem de compras:", err);
    res.status(500).json({ error: "No se pudo eliminar" });
  }
});

app.post("/admin/compras-agregar", requireAdminApi, (req, res) => {
  try {
    const texto = (req.body.texto || "").trim();
    if (!texto) return res.status(400).json({ error: "Falta el texto del ítem" });
    const listaCompras = loadListaCompras(req.body.fecha);
    listaCompras.items.push({
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      texto,
      categoria: "Otros",
      comprado: false,
      origen: req.body.origen || "otros",
    });
    saveListaCompras(listaCompras);
    console.log(`Ítem de compras agregado manualmente desde /admin/compras: "${texto}".`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al agregar ítem de compras:", err);
    res.status(500).json({ error: "No se pudo agregar" });
  }
});

// ==================== Panel de facturas de proveedores (mientras no hay API de FUDO) ====================
// Lista de empleados — dos endpoints separados a propósito:
// - "empleados-nombres": solo nombre + tipo, sin datos personales. Alcanza con la
//   contraseña general — lo usa /admin/adelantos para su desplegable.
// - "empleados-data": ficha completa (CUIT, DNI, dirección, teléfono). Datos personales
//   sensibles, así que pide las DOS contraseñas — solo se usa dentro de /admin/sueldos.
app.post("/admin/empleados-nombres", requireAdminApi, (_req, res) => {
  res.json(loadEmpleados().map((e) => ({ id: e.id, nombre: e.nombre, tipo: e.tipo })));
});

app.post("/admin/empleados-data", requireAdminApi, requireSueldosApi, (_req, res) => {
  res.json(loadEmpleados());
});

app.post("/admin/empleados-agregar", requireAdminApi, requireSueldosApi, (req, res) => {
  try {
    const { nombre, tipo, cuit, dni, direccion, telefono } = req.body;
    if (!nombre || !["normal", "mariano"].includes(tipo)) {
      return res.status(400).json({ error: "Falta el nombre o el tipo no es válido" });
    }
    const lista = loadEmpleados();
    if (lista.some((e) => e.nombre.toLowerCase() === String(nombre).trim().toLowerCase())) {
      return res.status(400).json({ error: "Ya existe un empleado con ese nombre" });
    }
    lista.push({
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      nombre: String(nombre).trim(),
      tipo,
      cuit: cuit ? String(cuit).trim() : "",
      dni: dni ? String(dni).trim() : "",
      direccion: direccion ? String(direccion).trim() : "",
      telefono: telefono ? normalizarTelefonoArgentino(telefono) : "",
    });
    saveEmpleados(lista);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error agregando empleado:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

// Carga varios empleados de una sola vez. Formato, una línea por empleado:
// nombre|tipo|cuit|dni|direccion|telefono  (cuit/dni/direccion/telefono son opcionales,
// dejar vacío entre las barras si no se sabe todavía — ej: "Ruben Alejandro Núñez|normal|20-32587454-7|||")
app.post("/admin/empleados-importar-masivo", requireAdminApi, requireSueldosApi, (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || !texto.trim()) {
      return res.status(400).json({ error: "Falta el texto a importar" });
    }
    const lineas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
    const lista = loadEmpleados();
    let agregados = 0;
    const errores = [];
    lineas.forEach((linea, idx) => {
      const partes = linea.split("|").map((p) => p.trim());
      const [nombre, tipo, cuit, dni, direccion, telefono] = partes;
      if (!nombre || !["normal", "mariano"].includes(tipo)) {
        errores.push(`Línea ${idx + 1}: "${linea}" — falta el nombre o el tipo no es válido`);
        return;
      }
      if (lista.some((e) => e.nombre.toLowerCase() === nombre.toLowerCase())) {
        errores.push(`Línea ${idx + 1}: "${nombre}" — ya existe, se omitió`);
        return;
      }
      lista.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "-" + idx,
        nombre,
        tipo,
        cuit: cuit || "",
        dni: dni || "",
        direccion: direccion || "",
        telefono: telefono ? normalizarTelefonoArgentino(telefono) : "",
      });
      agregados++;
    });
    saveEmpleados(lista);
    res.json({ ok: true, agregados, errores });
  } catch (err) {
    console.error("Error importando empleados en masa:", err);
    res.status(500).json({ error: "No se pudo importar" });
  }
});

app.post("/admin/empleados-editar", requireAdminApi, requireSueldosApi, (req, res) => {
  try {
    const { id, nombre, tipo, cuit, dni, direccion, telefono } = req.body;
    if (!id || !nombre || !["normal", "mariano"].includes(tipo)) {
      return res.status(400).json({ error: "Falta el id, el nombre, o el tipo no es válido" });
    }
    const lista = loadEmpleados();
    const empleado = lista.find((e) => e.id === id);
    if (!empleado) return res.status(404).json({ error: "Empleado no encontrado" });
    if (lista.some((e) => e.id !== id && e.nombre.toLowerCase() === String(nombre).trim().toLowerCase())) {
      return res.status(400).json({ error: "Ya existe otro empleado con ese nombre" });
    }
    empleado.nombre = String(nombre).trim();
    empleado.tipo = tipo;
    empleado.cuit = cuit ? String(cuit).trim() : "";
    empleado.dni = dni ? String(dni).trim() : "";
    empleado.direccion = direccion ? String(direccion).trim() : "";
    empleado.telefono = telefono ? normalizarTelefonoArgentino(telefono) : "";
    saveEmpleados(lista);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error editando empleado:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

app.post("/admin/empleados-borrar", requireAdminApi, requireSueldosApi, (req, res) => {
  try {
    const { id } = req.body;
    saveEmpleados(loadEmpleados().filter((e) => e.id !== id));
    res.json({ ok: true });
  } catch (err) {
    console.error("Error borrando empleado:", err);
    res.status(500).json({ error: "No se pudo borrar" });
  }
});

app.get("/admin/sueldos", requireAdminPage, requireSueldosPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Chaparrita - Sueldos mensuales</title>',
    `<style>${ADMIN_BASE_CSS}
      .form-sueldo { display: grid; gap: 10px; max-width: 420px; margin-bottom: 28px; }
      .form-sueldo label { font-size: 12.5px; color: var(--texto-tenue); }
      .empleado-card { margin-bottom: 18px; }
      .empleado-card h3 { margin: 0 0 4px; font-size: 16px; }
      .linea { font-size: 13.5px; margin: 2px 0; }
      .neto { font-weight: 700; font-size: 16px; margin-top: 6px; color: var(--verde-wa); }
      .filtro-mes { margin-bottom: 18px; }
      .filtro-mes select { width: auto; margin-top: 0; }
      #camposMariano { display: none; }
    </style>`,
    '</head><body>',
    '<div class="contenedor" style="max-width:820px">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>🧾 Sueldos mensuales</h1>',
    '<p class="sub">Cargá el sueldo de cada mes tal como figura en el recibo. Para Mariano, la app aplica su regla especial de cálculo automáticamente.</p>',

    '<h2>Empleados</h2>',
    '<p class="sub" style="margin-top:-6px">Dados de alta una sola vez acá, para no duplicar a nadie por escribir el nombre distinto cada mes.</p>',
    '<div id="listaEmpleadosBox" style="margin-bottom:14px"></div>',
    '<div class="form-sueldo" style="max-width:420px;margin-bottom:24px">',
    '<div><label>Nombre completo</label><input id="nEmpleado" type="text" placeholder="Nombre y apellido"></div>',
    '<div><label>Tipo</label><select id="nTipo"><option value="normal">Normal</option><option value="mariano">Mariano (regla especial)</option></select></div>',
    '<div><label>CUIT</label><input id="nCuit" type="text" placeholder="20-12345678-9"></div>',
    '<div><label>DNI</label><input id="nDni" type="text" placeholder="12345678"></div>',
    '<div><label>Dirección</label><input id="nDireccion" type="text" placeholder="Calle, número, barrio"></div>',
    '<div><label>Teléfono</label><input id="nTelefono" type="text" placeholder="+54 9 370 5263752"></div>',
    '<button id="btnAddEmpleado">Guardar empleado</button>',
    '<button id="btnCancelarEdicion" class="secundario" style="display:none">Cancelar edición</button>',
    '<div id="msgEmpleado" style="font-size:13px"></div>',
    '</div>',

    '<h2>Importar varios empleados de una vez</h2>',
    '<p class="sub" style="margin-top:-6px">Una línea por empleado: <code>nombre|tipo|cuit|dni|dirección|teléfono</code> (los últimos cuatro son opcionales, dejalos vacíos si todavía no los sabés). Ya te dejamos cargados los que juntamos — revisalos y apretá "Importar todo" (si falta algún dato, lo completás después con "Editar").</p>',
    '<div class="form-sueldo" style="max-width:640px">',
    `<textarea id="miTextoEmpleados" rows="8">Medina Milagros Natalia|normal|27-44876369-8|44876369||
Gonzalez Lourdes Sofia|normal|27-44344239-7|44344239|Pringles 2015|
Coceres Mariano Nicolás|mariano|20-42186281-9|42186281||
Romero Fiorela Katherina|normal|27-44647321-8|44647321|B° Simón Bolívar Mz 09 Cs 32|
Ruben Alejandro Núñez|normal|20-32587454-7|||
Valentina Marieth Gonzalez|normal||||</textarea>`,
    '<button id="btnImportarEmpleados">Importar todo</button>',
    '<div id="msgImportarEmpleados" style="font-size:13px;white-space:pre-wrap"></div>',
    '</div>',

    '<h2>Cargar sueldo del mes</h2>',
    '<div class="form-sueldo">',
    '<div><label>Empleado</label><select id="fEmpleado"><option value="">Elegí un empleado...</option></select></div>',
    '<div><label>Mes</label><input id="fMes" type="month"></div>',
    '<div><label>Tipo</label><select id="fTipo"><option value="normal">Normal (un solo recibo)</option><option value="mariano">Mariano (regla especial)</option></select></div>',
    '<div id="campoNormal"><label>Monto del recibo (tal como figura)</label><input id="fMontoRecibo" type="number" step="any" placeholder="$"></div>',
    '<div id="camposMariano">',
    '<label>Monto del recibo de 4hs declarado (con feriado incluido si corresponde)</label><input id="fMontoDeclarado" type="number" step="any" placeholder="$">',
    '<label>Monto base sin especiales (tarea de encargado)</label><input id="fMontoBase" type="number" step="any" placeholder="$">',
    '</div>',
    '<div id="totalPreview" style="font-weight:600"></div>',
    '<button id="btnAgregar">Cargar sueldo</button>',
    '<div id="msgForm" style="font-size:13px"></div>',
    '</div>',

    '<h2>Importar varios sueldos de una vez</h2>',
    '<p class="sub" style="margin-top:-6px">Una línea por mes. Normal: <code>mes|normal|montoRecibo</code>. Mariano: <code>mes|mariano|montoDeclarado|montoBase</code>. Ejemplo: <code>2026-06|normal|508290.47</code></p>',
    '<div class="form-sueldo" style="max-width:520px">',
    '<div><label>Empleado</label><select id="miEmpleadoSueldo"><option value="">Elegí un empleado...</option></select></div>',
    '<div><label>Pegar líneas</label><textarea id="miTextoSueldo" rows="6" placeholder="2026-06|normal|508290.47\n2026-07|normal|799018.52"></textarea></div>',
    '<button id="btnImportarSueldos">Importar todo</button>',
    '<div id="msgImportarSueldos" style="font-size:13px;white-space:pre-wrap"></div>',
    '</div>',

    '<h2>Estado de cuenta del empleado</h2>',
    '<p class="sub" style="margin-top:-6px">Sueldo y adelantos en orden de fecha, con el saldo corrido — no importa "de qué mes" es cada adelanto, simplemente descuenta el saldo disponible en ese momento.</p>',
    '<div class="form-sueldo" style="max-width:420px">',
    '<div><label>Empleado</label><select id="rEmpleado"><option value="">Elegí un empleado...</option></select></div>',
    '<button id="btnGenerarResumen">Ver estado de cuenta</button>',
    '</div>',
    '<div id="cuentaCorrienteBox" style="display:none;margin-top:14px"></div>',
    '<textarea id="rResultado" rows="14" style="display:none;font-family:monospace;font-size:12.5px;margin-top:10px" readonly></textarea>',
    '<button id="btnCopiarResumen" style="display:none" class="secundario">Copiar texto (para mandar por WhatsApp)</button>',
    '<div id="msgResumen" style="font-size:13px"></div>',

    '<script>',
    'var SUELDOS = []; var ADELANTOS = []; var EMPLEADOS = [];',
    'function hoyMes(){ var d=new Date(); return d.toISOString().slice(0,7); }',
    'document.getElementById("fMes").value = hoyMes();',
    '',
    'function nombreMes(mesISO){',
    '  var partes = mesISO.split("-"); var meses = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];',
    '  return meses[parseInt(partes[1],10)-1] + " " + partes[0];',
    '}',
    '',
    'function cargarEmpleados(){',
    '  return fetch("/admin/empleados-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(data){',
    '      EMPLEADOS = data;',
    '      pintarListaEmpleados();',
    '      pintarSelectEmpleado();',
    '    });',
    '}',
    'var editandoId = null;',
    'function pintarListaEmpleados(){',
    '  var box = document.getElementById("listaEmpleadosBox");',
    '  box.innerHTML = "";',
    '  EMPLEADOS.slice().sort(function(a,b){ return a.nombre.localeCompare(b.nombre); }).forEach(function(e){',
    '    var div = document.createElement("div");',
    '    div.className = "card"; div.style.padding = "10px 14px"; div.style.marginBottom = "8px";',
    '    div.innerHTML = "<b>" + e.nombre + "</b> <span style=\\"color:var(--texto-tenue);font-size:12.5px\\">(" + (e.tipo === "mariano" ? "regla especial" : "normal") + ")</span>" +',
    '      "<div style=\\"font-size:12.5px;color:var(--texto-tenue);margin-top:3px\\">" +',
    '      (e.cuit ? "CUIT: " + e.cuit + " · " : "") + (e.dni ? "DNI: " + e.dni + " · " : "") + (e.telefono ? "Tel: " + e.telefono : "") +',
    '      (e.direccion ? "<br>" + e.direccion : "") + "</div>";',
    '    var btnEditar = document.createElement("button"); btnEditar.textContent = "Editar"; btnEditar.className = "secundario"; btnEditar.style.fontSize = "12px";',
    '    btnEditar.addEventListener("click", function(){ cargarEnFormulario(e); });',
    '    var btnDel = document.createElement("button");',
    '    btnDel.textContent = "✕ Sacar"; btnDel.className = "btn-danger"; btnDel.style.fontSize = "12px"; btnDel.style.marginLeft = "6px";',
    '    btnDel.addEventListener("click", function(){',
    '      if (!confirm("¿Sacar a " + e.nombre + " de la lista de empleados? (no borra los sueldos/adelantos ya cargados)")) return;',
    '      fetch("/admin/empleados-borrar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({id: e.id})})',
    '        .then(function(r){ return r.json(); }).then(cargarEmpleados);',
    '    });',
    '    div.appendChild(btnEditar); div.appendChild(btnDel);',
    '    box.appendChild(div);',
    '  });',
    '}',
    'function cargarEnFormulario(e){',
    '  editandoId = e.id;',
    '  document.getElementById("nEmpleado").value = e.nombre;',
    '  document.getElementById("nTipo").value = e.tipo;',
    '  document.getElementById("nCuit").value = e.cuit || "";',
    '  document.getElementById("nDni").value = e.dni || "";',
    '  document.getElementById("nDireccion").value = e.direccion || "";',
    '  document.getElementById("nTelefono").value = e.telefono || "";',
    '  document.getElementById("btnAddEmpleado").textContent = "Guardar cambios";',
    '  document.getElementById("btnCancelarEdicion").style.display = "inline-block";',
    '  document.getElementById("nEmpleado").scrollIntoView({behavior:"smooth", block:"center"});',
    '}',
    'function limpiarFormularioEmpleado(){',
    '  editandoId = null;',
    '  document.getElementById("nEmpleado").value = "";',
    '  document.getElementById("nCuit").value = "";',
    '  document.getElementById("nDni").value = "";',
    '  document.getElementById("nDireccion").value = "";',
    '  document.getElementById("nTelefono").value = "";',
    '  document.getElementById("nTipo").value = "normal";',
    '  document.getElementById("btnAddEmpleado").textContent = "Guardar empleado";',
    '  document.getElementById("btnCancelarEdicion").style.display = "none";',
    '}',
    'document.getElementById("btnCancelarEdicion").addEventListener("click", limpiarFormularioEmpleado);',
    'document.getElementById("btnImportarEmpleados").addEventListener("click", function(){',
    '  var texto = document.getElementById("miTextoEmpleados").value;',
    '  var msg = document.getElementById("msgImportarEmpleados");',
    '  if (!texto.trim()) { msg.textContent = "No hay nada para importar."; return; }',
    '  fetch("/admin/empleados-importar-masivo", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({texto: texto})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(data){',
    '      if (data.error) { msg.textContent = "Error: " + data.error; return; }',
    '      var m = "✅ Se importaron " + data.agregados + " empleado(s).";',
    '      if (data.errores && data.errores.length > 0) { m += "\\n⚠️ " + data.errores.join("\\n"); }',
    '      msg.textContent = m;',
    '      cargarEmpleados();',
    '    })',
    '    .catch(function(e){ msg.textContent = "Error: " + e.message; });',
    '});',
    'function pintarSelectEmpleado(){',
    '  ["fEmpleado", "miEmpleadoSueldo", "rEmpleado"].forEach(function(idSelect){',
    '    var select = document.getElementById(idSelect);',
    '    var valorActual = select.value;',
    '    select.innerHTML = "<option value=\\"\\">Elegí un empleado...</option>";',
    '    EMPLEADOS.slice().sort(function(a,b){ return a.nombre.localeCompare(b.nombre); }).forEach(function(e){',
    '      var opt = document.createElement("option"); opt.value = e.nombre; opt.dataset.tipo = e.tipo; opt.textContent = e.nombre;',
    '      select.appendChild(opt);',
    '    });',
    '    select.value = valorActual;',
    '  });',
    '}',
    'document.getElementById("btnAddEmpleado").addEventListener("click", function(){',
    '  var nombre = document.getElementById("nEmpleado").value.trim();',
    '  var tipo = document.getElementById("nTipo").value;',
    '  var cuit = document.getElementById("nCuit").value.trim();',
    '  var dni = document.getElementById("nDni").value.trim();',
    '  var direccion = document.getElementById("nDireccion").value.trim();',
    '  var telefono = document.getElementById("nTelefono").value.trim();',
    '  var msg = document.getElementById("msgEmpleado");',
    '  if (!nombre) { msg.textContent = "Falta el nombre."; return; }',
    '  var body = { nombre: nombre, tipo: tipo, cuit: cuit, dni: dni, direccion: direccion, telefono: telefono };',
    '  var url = "/admin/empleados-agregar";',
    '  if (editandoId) { body.id = editandoId; url = "/admin/empleados-editar"; }',
    '  fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(data){',
    '      if (data.error) { msg.textContent = data.error; return; }',
    '      msg.textContent = "";',
    '      limpiarFormularioEmpleado();',
    '      cargarEmpleados();',
    '    });',
    '});',
    '// Al elegir un empleado ya cargado, auto-selecciona su tipo (Mariano vs normal).',
    'document.getElementById("fEmpleado").addEventListener("change", function(){',
    '  var opt = this.options[this.selectedIndex];',
    '  if (opt && opt.dataset.tipo) {',
    '    document.getElementById("fTipo").value = opt.dataset.tipo;',
    '    document.getElementById("fTipo").dispatchEvent(new Event("change"));',
    '  }',
    '});',
    '',
    'document.getElementById("fTipo").addEventListener("change", function(){',
    '  var esMariano = this.value === "mariano";',
    '  document.getElementById("campoNormal").style.display = esMariano ? "none" : "block";',
    '  document.getElementById("camposMariano").style.display = esMariano ? "block" : "none";',
    '  actualizarPreview();',
    '});',
    'function calcularTotal(tipo, montoRecibo, montoDeclarado, montoBase){',
    '  if (tipo === "mariano") return (2 * (montoDeclarado||0)) + (montoBase||0);',
    '  return montoRecibo||0;',
    '}',
    'function actualizarPreview(){',
    '  var tipo = document.getElementById("fTipo").value;',
    '  var total;',
    '  if (tipo === "mariano") {',
    '    total = calcularTotal(tipo, 0, parseFloat(document.getElementById("fMontoDeclarado").value)||0, parseFloat(document.getElementById("fMontoBase").value)||0);',
    '  } else {',
    '    total = calcularTotal(tipo, parseFloat(document.getElementById("fMontoRecibo").value)||0, 0, 0);',
    '  }',
    '  document.getElementById("totalPreview").textContent = "Total del mes: $" + total.toLocaleString("es-AR");',
    '}',
    '["fMontoRecibo","fMontoDeclarado","fMontoBase"].forEach(function(id){ document.getElementById(id).addEventListener("input", actualizarPreview); });',
    '',
    'function pintarCuentaCorriente(){',
    '  var empleado = document.getElementById("rEmpleado").value;',
    '  var box = document.getElementById("cuentaCorrienteBox");',
    '  if (!empleado) { box.style.display = "none"; return; }',
    '  var sueldosEmp = SUELDOS.filter(function(s){ return s.empleado === empleado; });',
    '  var adelantosEmp = ADELANTOS.filter(function(a){ return a.empleado === empleado; });',
    '  var movimientos = [];',
    '  sueldosEmp.forEach(function(s){ movimientos.push({ fecha: s.mes + "-01", concepto: "Sueldo " + nombreMes(s.mes), monto: s.total }); });',
    '  adelantosEmp.forEach(function(a){',
    '    var medio = a.medioPago === "efectivo" ? "Efectivo" : "Mercadopago";',
    '    var concepto = "Adelanto (" + medio + ")" + (a.nota ? " — " + a.nota : "");',
    '    movimientos.push({ fecha: a.fecha, concepto: concepto, monto: -a.monto, id: a.id, esAdelanto: true });',
    '  });',
    '  movimientos.sort(function(a,b){ return a.fecha.localeCompare(b.fecha); });',
    '  var saldo = 0;',
    '  movimientos.forEach(function(m){ saldo += m.monto; m.saldo = saldo; });',
    '  box.innerHTML = "";',
    '  if (movimientos.length === 0) { box.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icono\\">🧾</div>Todavía no hay sueldos ni adelantos cargados para " + empleado + ".</div>"; box.style.display = "block"; return; }',
    '  var tabla = document.createElement("table");',
    '  tabla.className = "tabla-adelantos";',
    '  tabla.innerHTML = "<thead><tr><th>Fecha</th><th>Concepto</th><th>Monto</th><th>Saldo</th><th></th></tr></thead>";',
    '  var tbody = document.createElement("tbody");',
    '  movimientos.forEach(function(m){',
    '    var tr = document.createElement("tr");',
    '    var signo = m.monto >= 0 ? "+" : "-";',
    '    var color = m.monto >= 0 ? "var(--verde-wa)" : "var(--coral)";',
    '    var tdBtn = "";',
    '    if (m.esAdelanto) tdBtn = "<button class=\\"btn-danger\\" data-id=\\"" + m.id + "\\" style=\\"font-size:11px\\">✕</button>";',
    '    tr.innerHTML = "<td>" + m.fecha.split("-").reverse().join("/") + "</td><td>" + m.concepto + "</td>" +',
    '      "<td style=\\"color:" + color + "\\">" + signo + "$" + Math.abs(m.monto).toLocaleString("es-AR") + "</td>" +',
    '      "<td><b>$" + m.saldo.toLocaleString("es-AR") + "</b></td><td>" + tdBtn + "</td>";',
    '    tbody.appendChild(tr);',
    '  });',
    '  tabla.appendChild(tbody);',
    '  box.appendChild(tabla);',
    '  var saldoFinal = movimientos[movimientos.length - 1].saldo;',
    '  var resumenFinal = document.createElement("div");',
    '  resumenFinal.className = "neto"; resumenFinal.style.marginTop = "10px";',
    '  resumenFinal.textContent = (saldoFinal >= 0 ? "Saldo a favor del empleado: $" : "Saldo a favor de Chaparrita: $") + Math.abs(saldoFinal).toLocaleString("es-AR");',
    '  box.appendChild(resumenFinal);',
    '  box.style.display = "block";',
    '  box.querySelectorAll(".btn-danger").forEach(function(btn){',
    '    btn.addEventListener("click", function(){',
    '      if (!confirm("¿Borrar este adelanto?")) return;',
    '      fetch("/admin/adelantos-borrar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({id: btn.dataset.id})})',
    '        .then(function(r){ return r.json(); })',
    '        .then(function(){ cargarTodo(); });',
    '    });',
    '  });',
    '}',
    '',
    'function cargarTodo(){',
    '  Promise.all([',
    '    fetch("/admin/sueldos-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})}).then(function(r){ return r.json(); }),',
    '    fetch("/admin/adelantos-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})}).then(function(r){ return r.json(); }),',
    '    cargarEmpleados()',
    '  ]).then(function(res){',
    '    SUELDOS = res[0]; ADELANTOS = res[1];',
    '    pintarCuentaCorriente();',
    '  }).catch(function(e){ document.getElementById("cuentaCorrienteBox").textContent = "Error: " + e.message; });',
    '}',
    'document.getElementById("rEmpleado").addEventListener("change", pintarCuentaCorriente);',
    'document.getElementById("btnAgregar").addEventListener("click", function(){',
    '  var empleado = document.getElementById("fEmpleado").value.trim();',
    '  var mes = document.getElementById("fMes").value;',
    '  var tipo = document.getElementById("fTipo").value;',
    '  var msg = document.getElementById("msgForm");',
    '  if (!empleado || !mes) { msg.textContent = "Completá empleado y mes."; return; }',
    '  var body = { empleado: empleado, mes: mes, tipo: tipo };',
    '  if (tipo === "mariano") {',
    '    body.montoDeclarado = parseFloat(document.getElementById("fMontoDeclarado").value);',
    '    body.montoBase = parseFloat(document.getElementById("fMontoBase").value);',
    '    if (!body.montoDeclarado || !body.montoBase) { msg.textContent = "Completá los dos montos de Mariano."; return; }',
    '  } else {',
    '    body.montoRecibo = parseFloat(document.getElementById("fMontoRecibo").value);',
    '    if (!body.montoRecibo) { msg.textContent = "Completá el monto del recibo."; return; }',
    '  }',
    '  fetch("/admin/sueldos-agregar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(data){',
    '      if (data.error) { msg.textContent = "Error: " + data.error; return; }',
    '      msg.textContent = "✅ Cargado.";',
    '      cargarTodo();',
    '      setTimeout(function(){ msg.textContent = ""; }, 2000);',
    '    })',
    '    .catch(function(e){ msg.textContent = "Error: " + e.message; });',
    '});',
    '',
    'document.getElementById("btnImportarSueldos").addEventListener("click", function(){',
    '  var empleado = document.getElementById("miEmpleadoSueldo").value;',
    '  var texto = document.getElementById("miTextoSueldo").value;',
    '  var msg = document.getElementById("msgImportarSueldos");',
    '  if (!empleado || !texto.trim()) { msg.textContent = "Elegí el empleado y pegá al menos una línea."; return; }',
    '  fetch("/admin/sueldos-importar-masivo", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({empleado: empleado, texto: texto})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(data){',
    '      if (data.error) { msg.textContent = "Error: " + data.error; return; }',
    '      var m = "✅ Se importaron " + data.agregados + " mes(es).";',
    '      if (data.errores && data.errores.length > 0) { m += "\\n⚠️ Líneas con problema:\\n" + data.errores.join("\\n"); }',
    '      msg.textContent = m;',
    '      document.getElementById("miTextoSueldo").value = "";',
    '      cargarTodo();',
    '    })',
    '    .catch(function(e){ msg.textContent = "Error: " + e.message; });',
    '});',
    '',
    'document.getElementById("btnGenerarResumen").addEventListener("click", function(){',
    '  var empleado = document.getElementById("rEmpleado").value;',
    '  var msg = document.getElementById("msgResumen");',
    '  if (!empleado) { msg.textContent = "Elegí un empleado."; return; }',
    '  pintarCuentaCorriente();',
    '  fetch("/admin/resumen-empleado", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({empleado: empleado})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(data){',
    '      if (data.error) { msg.textContent = "Error: " + data.error; return; }',
    '      var area = document.getElementById("rResultado");',
    '      area.value = data.texto;',
    '      area.style.display = "block";',
    '      document.getElementById("btnCopiarResumen").style.display = "inline-block";',
    '      msg.textContent = "";',
    '    })',
    '    .catch(function(e){ msg.textContent = "Error: " + e.message; });',
    '});',
    'document.getElementById("btnCopiarResumen").addEventListener("click", function(){',
    '  var area = document.getElementById("rResultado");',
    '  area.select();',
    '  navigator.clipboard.writeText(area.value).then(function(){',
    '    document.getElementById("msgResumen").textContent = "✅ Copiado — ya lo podés pegar en WhatsApp.";',
    '  }).catch(function(){',
    '    document.getElementById("msgResumen").textContent = "No se pudo copiar solo, seleccioná el texto a mano.";',
    '  });',
    '});',
    '',
    'cargarTodo();',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/sueldos-data", requireAdminApi, requireSueldosApi, (_req, res) => {
  res.json(loadSueldos());
});

app.post("/admin/sueldos-agregar", requireAdminApi, requireSueldosApi, (req, res) => {
  try {
    const { empleado, mes, tipo, montoRecibo, montoDeclarado, montoBase } = req.body;
    if (!empleado || !mes || !["normal", "mariano"].includes(tipo)) {
      return res.status(400).json({ error: "Faltan datos o el tipo no es válido" });
    }
    let total, registro;
    if (tipo === "mariano") {
      if (!montoDeclarado || !montoBase) return res.status(400).json({ error: "Faltan los montos de Mariano" });
      total = 2 * Number(montoDeclarado) + Number(montoBase);
      registro = { montoDeclarado: Number(montoDeclarado), montoBase: Number(montoBase) };
    } else {
      if (!montoRecibo) return res.status(400).json({ error: "Falta el monto del recibo" });
      total = Number(montoRecibo);
      registro = { montoRecibo: Number(montoRecibo) };
    }
    const lista = loadSueldos();
    lista.push({
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      empleado: String(empleado).trim(),
      mes,
      tipo,
      ...registro,
      total,
      creadoEn: new Date().toISOString(),
    });
    saveSueldos(lista);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error agregando sueldo:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

// Carga varios sueldos de una sola vez. Formato, una línea por mes:
// tipo normal:  mes|normal|montoRecibo
// tipo mariano: mes|mariano|montoDeclarado|montoBase
// Ejemplo: 2026-06|normal|508290.47
app.post("/admin/sueldos-importar-masivo", requireAdminApi, requireSueldosApi, (req, res) => {
  try {
    const { empleado, texto } = req.body;
    if (!empleado || !texto || !texto.trim()) {
      return res.status(400).json({ error: "Falta el empleado o el texto a importar" });
    }
    const lineas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
    const lista = loadSueldos();
    let agregados = 0;
    const errores = [];
    lineas.forEach((linea, idx) => {
      const partes = linea.split("|").map((p) => p.trim());
      const [mes, tipo, a, b] = partes;
      if (!mes || !["normal", "mariano"].includes(tipo)) {
        errores.push(`Línea ${idx + 1}: "${linea}" — no se pudo interpretar`);
        return;
      }
      let total, registro;
      if (tipo === "mariano") {
        const montoDeclarado = Number(a);
        const montoBase = Number(b);
        if (!montoDeclarado || !montoBase) {
          errores.push(`Línea ${idx + 1}: "${linea}" — faltan los dos montos de Mariano`);
          return;
        }
        total = 2 * montoDeclarado + montoBase;
        registro = { montoDeclarado, montoBase };
      } else {
        const montoRecibo = Number(a);
        if (!montoRecibo) {
          errores.push(`Línea ${idx + 1}: "${linea}" — falta el monto del recibo`);
          return;
        }
        total = montoRecibo;
        registro = { montoRecibo };
      }
      lista.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "-" + idx,
        empleado: String(empleado).trim(),
        mes,
        tipo,
        ...registro,
        total,
        creadoEn: new Date().toISOString(),
      });
      agregados++;
    });
    saveSueldos(lista);
    res.json({ ok: true, agregados, errores });
  } catch (err) {
    console.error("Error importando sueldos en masa:", err);
    res.status(500).json({ error: "No se pudo importar" });
  }
});

app.post("/admin/sueldos-borrar", requireAdminApi, requireSueldosApi, (req, res) => {
  try {
    const { id } = req.body;
    const lista = loadSueldos().filter((s) => s.id !== id);
    saveSueldos(lista);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error borrando sueldo:", err);
    res.status(500).json({ error: "No se pudo borrar" });
  }
});

// Arma el "estado de cuenta" completo de un empleado, en orden cronológico: cada sueldo
// SUMA saldo a favor del empleado, cada adelanto RESTA — con el saldo corrido después de
// cada movimiento. Es la misma lógica que una cartola de banco: no importa "de qué mes" es
// cada adelanto, simplemente va descontando el saldo disponible en el momento en que se dio,
// venga de donde venga (sueldo del mes anterior, aguinaldo, etc.).
function construirCuentaCorrienteEmpleado(empleado, sueldos, adelantos) {
  const nombreMes = (mesISO) => {
    const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    const [y, m] = mesISO.split("-");
    return `${meses[parseInt(m, 10) - 1]} ${y}`;
  };
  const movimientos = [];
  sueldos
    .filter((s) => s.empleado === empleado)
    .forEach((s) => {
      movimientos.push({ fecha: `${s.mes}-01`, concepto: `Sueldo ${nombreMes(s.mes)}`, monto: s.total });
    });
  adelantos
    .filter((a) => a.empleado === empleado)
    .forEach((a) => {
      const medio = a.medioPago === "efectivo" ? "Efectivo" : "Mercadopago";
      let concepto = `Adelanto (${medio})`;
      if (a.nota) concepto += ` — ${a.nota}`;
      movimientos.push({ fecha: a.fecha, concepto, monto: -a.monto });
    });
  movimientos.sort((a, b) => a.fecha.localeCompare(b.fecha));
  let saldo = 0;
  return movimientos.map((m) => {
    saldo += m.monto;
    return { ...m, saldo };
  });
}

app.post("/admin/resumen-empleado", requireAdminApi, requireSueldosApi, (req, res) => {
  try {
    const { empleado } = req.body;
    if (!empleado) {
      return res.status(400).json({ error: "Falta el empleado" });
    }
    const cuenta = construirCuentaCorrienteEmpleado(empleado, loadSueldos(), loadAdelantos());
    const fmt = (n) => Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let texto = `📋 *ESTADO DE CUENTA — SUELDO Y ADELANTOS*\n${empleado}\n\n`;
    if (cuenta.length === 0) {
      texto += `(todavía no hay sueldos ni adelantos cargados)`;
    } else {
      cuenta.forEach((m) => {
        const [y, mm, d] = m.fecha.split("-");
        const signo = m.monto >= 0 ? "+" : "-";
        texto += `${d}/${mm}/${y} — ${m.concepto}: ${signo}$${fmt(Math.abs(m.monto))} → saldo: $${fmt(m.saldo)}\n`;
      });
      const saldoFinal = cuenta[cuenta.length - 1].saldo;
      texto += `\n✅ *SALDO ACTUAL*\n`;
      texto += saldoFinal >= 0 ? `A favor del empleado: $${fmt(saldoFinal)}` : `A favor de Chaparrita: $${fmt(Math.abs(saldoFinal))}`;
    }

    res.json({ ok: true, texto, cuenta });
  } catch (err) {
    console.error("Error armando estado de cuenta de empleado:", err);
    res.status(500).json({ error: err.message });
  }
});


app.get("/admin/adelantos", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Chaparrita - Adelantos de sueldo</title>',
    `<style>${ADMIN_BASE_CSS}
      .form-adelanto { display: grid; gap: 10px; max-width: 420px; margin-bottom: 28px; }
      .form-adelanto label { font-size: 12.5px; color: var(--texto-tenue); }
      .empleado-card { margin-bottom: 18px; }
      .empleado-card h3 { margin: 0 0 4px; font-size: 16px; }
      .saldo-linea { font-size: 13.5px; margin: 2px 0; }
      .saldo-total { font-weight: 700; font-size: 15px; margin-top: 6px; }
      table.tabla-adelantos { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }
      table.tabla-adelantos th { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--borde); color: var(--texto-tenue); font-weight: 600; }
      table.tabla-adelantos td { padding: 5px 6px; border-bottom: 1px solid var(--borde); }
      .saldado { opacity: 0.5; text-decoration: line-through; }
      .filtro-mes { margin-bottom: 18px; }
      .filtro-mes select { width: auto; margin-top: 0; }
    </style>`,
    '</head><body>',
    '<div class="contenedor" style="max-width:820px">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>💵 Adelantos de sueldo</h1>',
    '<p class="sub">Cargá cada adelanto (efectivo o Mercadopago) apenas lo hagas. Acá abajo vas a ver siempre cuánto le tenés que descontar a cada empleado en el próximo sueldo.</p>',

    '<h2>Cargar un adelanto</h2>',
    '<div class="form-adelanto">',
    '<div><label>Empleado</label><select id="fEmpleado"><option value="">Elegí un empleado...</option></select></div>',
    '<div><label>Fecha</label><input id="fFecha" type="date"></div>',
    '<div><label>Monto</label><input id="fMonto" type="number" step="any" placeholder="$"></div>',
    '<div><label>Medio</label><select id="fMedio"><option value="efectivo">Efectivo</option><option value="mercadopago">Mercadopago</option></select></div>',
    '<div><label>Nota (opcional)</label><input id="fNota" type="text" placeholder="ej: adelanto de quincena"></div>',
    '<button id="btnAgregar">Cargar adelanto</button>',
    '<div id="msgForm" style="font-size:13px"></div>',
    '</div>',

    '<h2>Importar varios adelantos de una vez</h2>',
    '<p class="sub" style="margin-top:-6px">Una línea por adelanto, formato: <code>fecha|monto|medio|nota</code> (medio: efectivo o mercadopago; nota es opcional). Ejemplo: <code>2026-06-05|61961.11|mercadopago|</code></p>',
    '<div class="form-adelanto" style="max-width:520px">',
    '<div><label>Empleado</label><select id="miEmpleado"><option value="">Elegí un empleado...</option></select></div>',
    '<div><label>Pegar líneas</label><textarea id="miTexto" rows="8" placeholder="2026-06-05|61961.11|mercadopago|\n2026-07-18|50000|efectivo|"></textarea></div>',
    '<button id="btnImportarMasivo">Importar todo</button>',
    '<div id="msgImportarMasivo" style="font-size:13px;white-space:pre-wrap"></div>',
    '</div>',

    '<h2>Detectar adelantos automáticamente</h2>',
    '<p class="sub" style="margin-top:-6px">Pegá una conversación de WhatsApp exportada, o subí capturas de transferencias — Claude te propone los adelantos que encuentre, y vos elegís cuáles guardar. No se guarda nada solo.</p>',
    '<div class="form-adelanto" style="max-width:520px">',
    '<div><label>Empleado al que corresponden estos adelantos</label><select id="dEmpleado"><option value="">Elegí un empleado...</option></select></div>',
    '<div><label>Subir el .zip o .txt que exportó WhatsApp (Menú del chat → Más → Exportar chat)</label><input id="dArchivo" type="file" accept=".zip,.txt"></div>',
    '<div style="text-align:center;color:var(--texto-tenue);font-size:12px">— o —</div>',
    '<div><label>Pegar el texto directamente</label><textarea id="dTexto" rows="5" placeholder="Pegá acá los mensajes relevantes"></textarea></div>',
    '<button id="btnDetectarChat" class="secundario">Analizar chat</button>',
    '<div><label>O subir capturas de transferencias (opcional, podés elegir varias)</label><input id="dCapturas" type="file" accept="image/*" multiple></div>',
    '<button id="btnDetectarCapturas" class="secundario">Analizar capturas</button>',
    '<div id="msgDetectar" style="font-size:13px"></div>',
    '</div>',
    '<div id="candidatosBox" style="display:none;margin-bottom:28px">',
    '<table class="tabla-adelantos"><thead><tr><th></th><th>Fecha</th><th>Monto</th><th>Medio</th><th>Nota / origen</th></tr></thead><tbody id="tbodyCandidatos"></tbody></table>',
    '<button id="btnGuardarCandidatos">Guardar seleccionados</button>',
    '</div>',

    '<h2>Adelantos por empleado</h2>',
    '<p class="sub" style="margin-top:-6px">Listado simple, ordenado por fecha. Para ver el saldo real (sueldo menos adelantos) entrá a <a href="/admin/sueldos">/admin/sueldos</a> — esa pantalla tiene una segunda contraseña porque cruza datos de sueldo.</p>',
    '<div class="filtro-mes">Empleado: <select id="filtroEmpleadoResumen"><option value="">Elegí un empleado...</option></select></div>',
    '<div id="resumen">Elegí un empleado para ver sus adelantos.</div>',

    '<script>',
    'var TODOS = []; var EMPLEADOS = [];',
    'function hoyISO(){ var d=new Date(); return d.toISOString().slice(0,10); }',
    'document.getElementById("fFecha").value = hoyISO();',
    '',
    'function mesDe(fechaISO){ return (fechaISO||"").slice(0,7); }', // "YYYY-MM"
    'function nombreMes(mesISO){',
    '  var partes = mesISO.split("-"); var meses = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];',
    '  return meses[parseInt(partes[1],10)-1] + " " + partes[0];',
    '}',
    '',
    'function pintarFiltroEmpleadoResumen(){',
    '  var select = document.getElementById("filtroEmpleadoResumen");',
    '  var valorActual = select.value;',
    '  select.innerHTML = "<option value=\\"\\">Elegí un empleado...</option>";',
    '  EMPLEADOS.slice().sort(function(a,b){ return a.nombre.localeCompare(b.nombre); }).forEach(function(e){',
    '    var opt = document.createElement("option"); opt.value = e.nombre; opt.textContent = e.nombre;',
    '    select.appendChild(opt);',
    '  });',
    '  select.value = valorActual;',
    '}',
    '',
    'function pintarSelectEmpleado(){',
    '  ["fEmpleado", "dEmpleado", "miEmpleado"].forEach(function(idSelect){',
    '    var select = document.getElementById(idSelect);',
    '    var valorActual = select.value;',
    '    select.innerHTML = "<option value=\\"\\">Elegí un empleado...</option>";',
    '    EMPLEADOS.slice().sort(function(a,b){ return a.nombre.localeCompare(b.nombre); }).forEach(function(e){',
    '      var opt = document.createElement("option"); opt.value = e.nombre; opt.textContent = e.nombre;',
    '      select.appendChild(opt);',
    '    });',
    '    select.value = valorActual;',
    '  });',
    '}',
    '',
    'function pintarResumen(){',
    '  var empleadoElegido = document.getElementById("filtroEmpleadoResumen").value;',
    '  var cont = document.getElementById("resumen");',
    '  cont.innerHTML = "";',
    '  if (!empleadoElegido) { cont.textContent = "Elegí un empleado para ver sus adelantos."; return; }',
    '  var lista = TODOS.filter(function(a){ return a.empleado === empleadoElegido; }).slice().sort(function(a,b){ return a.fecha.localeCompare(b.fecha); });',
    '  if (lista.length === 0) { cont.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icono\\">💵</div>" + empleadoElegido + " todavía no tiene adelantos cargados.</div>"; return; }',
    '  var totalGeneral = lista.reduce(function(s,a){ return s + Number(a.monto); }, 0);',
    '  var div = document.createElement("div");',
    '  div.className = "card empleado-card";',
    '  var html = "<h3>" + empleadoElegido + "</h3>" +',
    '    "<div class=\\"saldo-total\\">Total adelantado (histórico): $" + totalGeneral.toLocaleString("es-AR") + "</div>";',
    '  html += "<table class=\\"tabla-adelantos\\"><thead><tr><th>Fecha</th><th>Monto</th><th>Medio</th><th>Nota</th><th></th></tr></thead><tbody>" +',
    '    lista.map(function(a){',
    '      return "<tr><td>" + a.fecha.split("-").reverse().join("/") + "</td><td>$" + Number(a.monto).toLocaleString("es-AR") + "</td><td>" + (a.medioPago === "efectivo" ? "Efectivo" : "Mercadopago") + "</td><td>" + (a.nota || "") + "</td><td><button class=\\"btn-danger btn-borrar\\" data-id=\\"" + a.id + "\\">✕</button></td></tr>";',
    '    }).join("") + "</tbody></table>";',
    '  div.innerHTML = html;',
    '  cont.appendChild(div);',
    '  cont.querySelectorAll(".btn-borrar").forEach(function(btn){',
    '    btn.addEventListener("click", function(){',
    '      if (!confirm("¿Borrar este adelanto?")) return;',
    '      fetch("/admin/adelantos-borrar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({id: btn.dataset.id})})',
    '        .then(function(r){ return r.json(); })',
    '        .then(function(){ cargarTodo(); });',
    '    });',
    '  });',
    '}',
    '',
    'function cargarTodo(){',
    '  Promise.all([',
    '    fetch("/admin/adelantos-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})}).then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); }),',
    '    fetch("/admin/empleados-nombres", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})}).then(function(r){ return r.json(); })',
    '  ]).then(function(res){',
    '      TODOS = res[0]; EMPLEADOS = res[1];',
    '      pintarFiltroEmpleadoResumen();',
    '      pintarSelectEmpleado();',
    '      pintarResumen();',
    '    })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("resumen").textContent = "Error: " + e.message; } });',
    '}',
    'document.getElementById("filtroEmpleadoResumen").addEventListener("change", pintarResumen);',
    'document.getElementById("btnAgregar").addEventListener("click", function(){',
    '  var empleado = document.getElementById("fEmpleado").value.trim();',
    '  var fecha = document.getElementById("fFecha").value;',
    '  var monto = parseFloat(document.getElementById("fMonto").value);',
    '  var medioPago = document.getElementById("fMedio").value;',
    '  var nota = document.getElementById("fNota").value.trim();',
    '  var msg = document.getElementById("msgForm");',
    '  if (!empleado || !fecha || !monto) { msg.textContent = "Completá empleado, fecha y monto."; return; }',
    '  fetch("/admin/adelantos-agregar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({empleado: empleado, fecha: fecha, monto: monto, medioPago: medioPago, nota: nota})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(){',
    '      msg.textContent = "✅ Cargado.";',
    '      document.getElementById("fMonto").value = "";',
    '      document.getElementById("fNota").value = "";',
    '      cargarTodo();',
    '      setTimeout(function(){ msg.textContent = ""; }, 2000);',
    '    })',
    '    .catch(function(e){ msg.textContent = "Error: " + e.message; });',
    '});',
    '',
    'document.getElementById("btnImportarMasivo").addEventListener("click", function(){',
    '  var empleado = document.getElementById("miEmpleado").value;',
    '  var texto = document.getElementById("miTexto").value;',
    '  var msg = document.getElementById("msgImportarMasivo");',
    '  if (!empleado || !texto.trim()) { msg.textContent = "Elegí el empleado y pegá al menos una línea."; return; }',
    '  fetch("/admin/adelantos-importar-masivo", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({empleado: empleado, texto: texto})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(data){',
    '      if (data.error) { msg.textContent = "Error: " + data.error; return; }',
    '      var m = "✅ Se importaron " + data.agregados + " adelanto(s).";',
    '      if (data.errores && data.errores.length > 0) { m += "\\n⚠️ Líneas con problema:\\n" + data.errores.join("\\n"); }',
    '      msg.textContent = m;',
    '      document.getElementById("miTexto").value = "";',
    '      cargarTodo();',
    '    })',
    '    .catch(function(e){ msg.textContent = "Error: " + e.message; });',
    '});',
    '',
    '// ---- Detección automática (chat / capturas) ----',
    'function pintarCandidatos(candidatos){',
    '  var tbody = document.getElementById("tbodyCandidatos");',
    '  tbody.innerHTML = "";',
    '  if (candidatos.length === 0) {',
    '    document.getElementById("msgDetectar").textContent = "No se encontró ningún adelanto reconocible.";',
    '    document.getElementById("candidatosBox").style.display = "none";',
    '    return;',
    '  }',
    '  candidatos.forEach(function(c){',
    '    var tr = document.createElement("tr");',
    '    var tdCheck = document.createElement("td");',
    '    var chk = document.createElement("input"); chk.type = "checkbox"; chk.checked = true; chk.style.marginTop = "0";',
    '    tdCheck.appendChild(chk);',
    '    var tdFecha = document.createElement("td");',
    '    var inpFecha = document.createElement("input"); inpFecha.type = "date"; inpFecha.value = c.fecha || hoyISO(); inpFecha.style.marginTop = "0"; inpFecha.style.padding = "4px";',
    '    tdFecha.appendChild(inpFecha);',
    '    var tdMonto = document.createElement("td");',
    '    var inpMonto = document.createElement("input"); inpMonto.type = "number"; inpMonto.value = c.monto || ""; inpMonto.style.marginTop = "0"; inpMonto.style.width = "90px"; inpMonto.style.padding = "4px";',
    '    tdMonto.appendChild(inpMonto);',
    '    var tdMedio = document.createElement("td");',
    '    var selMedio = document.createElement("select"); selMedio.style.marginTop = "0"; selMedio.style.padding = "4px";',
    '    ["efectivo","mercadopago"].forEach(function(m){ var opt = document.createElement("option"); opt.value = m; opt.textContent = m === "efectivo" ? "Efectivo" : "Mercadopago"; if ((c.medioPago||"").indexOf(m) === 0 || (m === "mercadopago" && (c.medioPago||"").indexOf("mercado") === 0)) opt.selected = true; selMedio.appendChild(opt); });',
    '    tdMedio.appendChild(selMedio);',
    '    var tdNota = document.createElement("td");',
    '    tdNota.style.fontSize = "11.5px"; tdNota.style.color = "var(--texto-tenue)";',
    '    tdNota.textContent = c.nota || c.advertencia || (c.destinatario ? ("Para: " + c.destinatario) : "");',
    '    tr.appendChild(tdCheck); tr.appendChild(tdFecha); tr.appendChild(tdMonto); tr.appendChild(tdMedio); tr.appendChild(tdNota);',
    '    tr._candidato = { chk: chk, fecha: inpFecha, monto: inpMonto, medio: selMedio, nota: c.nota || c.advertencia || "" };',
    '    tbody.appendChild(tr);',
    '  });',
    '  document.getElementById("candidatosBox").style.display = "block";',
    '  document.getElementById("candidatosBox").scrollIntoView({behavior:"smooth", block:"center"});',
    '}',
    'document.getElementById("btnDetectarChat").addEventListener("click", function(){',
    '  var texto = document.getElementById("dTexto").value;',
    '  var archivo = document.getElementById("dArchivo").files[0];',
    '  var msg = document.getElementById("msgDetectar");',
    '  if (!texto.trim() && !archivo) { msg.textContent = "Pegá el texto, o subí el .zip/.txt exportado."; return; }',
    '  msg.textContent = "Analizando con Claude...";',
    '  var opciones;',
    '  if (archivo) {',
    '    var fd = new FormData();',
    '    fd.append("archivoChat", archivo);',
    '    if (texto.trim()) fd.append("texto", texto);',
    '    opciones = { method: "POST", body: fd };',
    '  } else {',
    '    opciones = { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({texto: texto}) };',
    '  }',
    '  fetch("/admin/adelantos-detectar-chat", opciones)',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(data){',
    '      if (data.error) { msg.textContent = "Error: " + data.error; return; }',
    '      msg.textContent = data.candidatos.length + " candidato(s) encontrado(s). Revisá y confirmá abajo.";',
    '      pintarCandidatos(data.candidatos);',
    '    })',
    '    .catch(function(e){ msg.textContent = "Error: " + e.message; });',
    '});',
    'document.getElementById("btnDetectarCapturas").addEventListener("click", function(){',
    '  var input = document.getElementById("dCapturas");',
    '  var msg = document.getElementById("msgDetectar");',
    '  if (!input.files || input.files.length === 0) { msg.textContent = "Elegí al menos una captura primero."; return; }',
    '  var fd = new FormData();',
    '  for (var i = 0; i < input.files.length; i++) fd.append("capturas", input.files[i]);',
    '  msg.textContent = "Leyendo capturas con Claude...";',
    '  fetch("/admin/adelantos-detectar-captura", {method:"POST", body: fd})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(data){',
    '      if (data.error) { msg.textContent = "Error: " + data.error; return; }',
    '      msg.textContent = data.candidatos.length + " captura(s) leída(s). Revisá y confirmá abajo.";',
    '      pintarCandidatos(data.candidatos);',
    '    })',
    '    .catch(function(e){ msg.textContent = "Error: " + e.message; });',
    '});',
    'document.getElementById("btnGuardarCandidatos").addEventListener("click", function(){',
    '  var empleado = document.getElementById("dEmpleado").value;',
    '  var msg = document.getElementById("msgDetectar");',
    '  if (!empleado) { msg.textContent = "Elegí a qué empleado corresponden estos adelantos, arriba."; return; }',
    '  var items = [];',
    '  document.querySelectorAll("#tbodyCandidatos tr").forEach(function(tr){',
    '    var c = tr._candidato;',
    '    if (!c.chk.checked) return;',
    '    items.push({ empleado: empleado, fecha: c.fecha.value, monto: parseFloat(c.monto.value), medioPago: c.medio.value, nota: c.nota });',
    '  });',
    '  if (items.length === 0) { msg.textContent = "No dejaste ningún candidato tildado."; return; }',
    '  fetch("/admin/adelantos-detectar-guardar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({items: items})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(data){',
    '      if (data.error) { msg.textContent = "Error: " + data.error; return; }',
    '      msg.textContent = "✅ Se guardaron " + data.agregados + " adelanto(s).";',
    '      document.getElementById("candidatosBox").style.display = "none";',
    '      document.getElementById("dTexto").value = "";',
    '      document.getElementById("dCapturas").value = "";',
    '      cargarTodo();',
    '    })',
    '    .catch(function(e){ msg.textContent = "Error: " + e.message; });',
    '});',
    '',
    'cargarTodo();',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/adelantos-data", requireAdminApi, (_req, res) => {
  res.json(loadAdelantos());
});

app.post("/admin/adelantos-agregar", requireAdminApi, (req, res) => {
  try {
    const { empleado, fecha, monto, medioPago, nota } = req.body;
    if (!empleado || !fecha || !monto || !["efectivo", "mercadopago"].includes(medioPago)) {
      return res.status(400).json({ error: "Faltan datos o el medio de pago no es válido" });
    }
    const lista = loadAdelantos();
    lista.push({
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      empleado: String(empleado).trim(),
      fecha,
      monto: Number(monto),
      medioPago,
      nota: nota ? String(nota).trim() : "",
      saldado: false,
      creadoEn: new Date().toISOString(),
    });
    saveAdelantos(lista);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error agregando adelanto:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

// Carga varios adelantos de una sola vez, pegando texto en vez de tipear cada fila a mano.
// Formato esperado, una línea por adelanto: fecha|monto|medio|nota (nota es opcional)
// Ejemplo: 2026-06-05|61961.11|mercadopago|
//          2026-07-18|50000|efectivo|
app.post("/admin/adelantos-importar-masivo", requireAdminApi, (req, res) => {
  try {
    const { empleado, texto } = req.body;
    if (!empleado || !texto || !texto.trim()) {
      return res.status(400).json({ error: "Falta el empleado o el texto a importar" });
    }
    const lineas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
    const lista = loadAdelantos();
    let agregados = 0;
    const errores = [];
    lineas.forEach((linea, idx) => {
      const partes = linea.split("|").map((p) => p.trim());
      const [fecha, montoTexto, medioPago, nota] = partes;
      const monto = Number(montoTexto);
      if (!fecha || !monto || !["efectivo", "mercadopago"].includes(medioPago)) {
        errores.push(`Línea ${idx + 1}: "${linea}" — no se pudo interpretar (formato: fecha|monto|medio|nota)`);
        return;
      }
      lista.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "-" + idx,
        empleado: String(empleado).trim(),
        fecha,
        monto,
        medioPago,
        nota: nota ? nota.trim() : "",
        saldado: false,
        creadoEn: new Date().toISOString(),
      });
      agregados++;
    });
    saveAdelantos(lista);
    res.json({ ok: true, agregados, errores });
  } catch (err) {
    console.error("Error importando adelantos en masa:", err);
    res.status(500).json({ error: "No se pudo importar" });
  }
});

app.post("/admin/adelantos-borrar", requireAdminApi, (req, res) => {
  try {
    const { id } = req.body;
    const lista = loadAdelantos().filter((a) => a.id !== id);
    saveAdelantos(lista);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error borrando adelanto:", err);
    res.status(500).json({ error: "No se pudo borrar" });
  }
});

app.post("/admin/adelantos-saldar", requireAdminApi, (req, res) => {
  try {
    const { empleado, mes } = req.body;
    if (!empleado || !mes) return res.status(400).json({ error: "Falta empleado o mes" });
    const lista = loadAdelantos();
    lista.forEach((a) => {
      if (a.empleado === empleado && a.fecha.slice(0, 7) === mes && !a.saldado) {
        a.saldado = true;
        a.saldadoEn = new Date().toISOString();
      }
    });
    saveAdelantos(lista);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error saldando adelantos:", err);
    res.status(500).json({ error: "No se pudo actualizar" });
  }
});

// ---- Detección asistida de adelantos: a partir de texto de chat (export de WhatsApp,
//      pegado tal cual) o de capturas de transferencias. En los dos casos Claude devuelve
//      CANDIDATOS — nada se guarda como adelanto real hasta que el usuario los revise y
//      confirme desde /admin/adelantos-detectar-guardar. ----
const DETECTAR_ADELANTOS_CHAT_PROMPT = `Sos un asistente que revisa una conversación de WhatsApp exportada entre el dueño de un restaurante y un empleado, buscando menciones de ADELANTOS DE SUELDO (plata que el dueño le adelantó al empleado, en efectivo o por Mercadopago/transferencia).

Buscá frases como "te mando $X", "te adelanto", "te presto", "te transferí", "toma $X", con un monto en pesos y (si se puede inferir) una fecha. NO cuentes cosas que no sean claramente un adelanto de plata (charlas normales, pedidos de mercadería, pagos a proveedores, etc. no cuentan).

Para cada adelanto que encuentres, indicá si por el contexto del mensaje parece haber sido en efectivo o por Mercadopago/transferencia (si no está claro, usá "efectivo" como valor por defecto, pero avisá la incertidumbre en la nota).

Respondé ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown), con esta forma exacta:
{"candidatos": [{"fecha": "YYYY-MM-DD si se puede inferir, si no dejar vacío", "monto": 5000, "medioPago": "efectivo o mercadopago", "nota": "fragmento o resumen breve del mensaje que lo justifica"}]}`;

const DETECTAR_ADELANTOS_CAPTURA_PROMPT = `Sos un asistente que lee una captura de pantalla de una transferencia (de Mercadopago, de un banco, o similar) para registrar un adelanto de sueldo a un empleado. Extraé los datos reales que se vean, sin inventar nada.

Respondé ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown), con esta forma exacta:
{"fecha": "YYYY-MM-DD si se ve", "monto": 5000, "destinatario": "nombre del destinatario tal como figura, si se ve", "medioPago": "mercadopago", "advertencia": "si algo no se ve claro, contalo acá; si no, dejalo vacío"}`;

app.post("/admin/adelantos-detectar-chat", requireAdminApi, upload.single("archivoChat"), async (req, res) => {
  try {
    let texto = req.body.texto || "";
    // Si vino un archivo (en vez de, o además de, texto pegado): puede ser un .zip (lo que
    // exporta WhatsApp normalmente, con el .txt del chat adentro — a veces también fotos,
    // que ignoramos) o directamente un .txt.
    if (req.file) {
      if (req.file.originalname.toLowerCase().endsWith(".zip") || req.file.mimetype === "application/zip") {
        const zip = new AdmZip(req.file.buffer);
        const entradaTxt = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(".txt"));
        if (!entradaTxt) {
          return res.status(400).json({ error: "El .zip no tiene ningún archivo .txt adentro — ¿es realmente la exportación del chat?" });
        }
        texto = entradaTxt.getData().toString("utf8");
      } else {
        texto = req.file.buffer.toString("utf8");
      }
    }
    if (!texto || !texto.trim()) return res.status(400).json({ error: "Falta el texto del chat (pegalo, o subí el .zip/.txt exportado)" });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        system: DETECTAR_ADELANTOS_CHAT_PROMPT,
        messages: [{ role: "user", content: texto.slice(0, 60000) }],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Error de la API de Claude al detectar adelantos en chat:", data);
      return res.status(502).json({ error: "Error consultando a Claude" });
    }
    const textoRespuesta = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n").trim();
    const jsonMatch = textoRespuesta.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ candidatos: [] });
    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ candidatos: Array.isArray(parsed.candidatos) ? parsed.candidatos : [] });
  } catch (err) {
    console.error("Error detectando adelantos en chat:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/adelantos-detectar-captura", requireAdminApi, upload.array("capturas", 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No se recibió ninguna captura" });
    const candidatos = [];
    for (const file of req.files) {
      if (!file.mimetype.startsWith("image/")) continue;
      const base64 = file.buffer.toString("base64");
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
          system: DETECTAR_ADELANTOS_CAPTURA_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: file.mimetype, data: base64 } },
                { type: "text", text: "Extraé los datos de esta transferencia." },
              ],
            },
          ],
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        console.error("Error de la API de Claude al leer captura de transferencia:", data);
        continue;
      }
      const textoRespuesta = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n").trim();
      const jsonMatch = textoRespuesta.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        candidatos.push(parsed);
      } catch {
        continue;
      }
    }
    res.json({ candidatos });
  } catch (err) {
    console.error("Error detectando adelantos en capturas:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/adelantos-detectar-guardar", requireAdminApi, (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "No hay nada para guardar" });
    const lista = loadAdelantos();
    let agregados = 0;
    for (const it of items) {
      if (!it.empleado || !it.fecha || !it.monto || !["efectivo", "mercadopago"].includes(it.medioPago)) continue;
      lista.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        empleado: String(it.empleado).trim(),
        fecha: it.fecha,
        monto: Number(it.monto),
        medioPago: it.medioPago,
        nota: it.nota ? String(it.nota).trim() : "(detectado automáticamente)",
        saldado: false,
        creadoEn: new Date().toISOString(),
      });
      agregados++;
    }
    saveAdelantos(lista);
    res.json({ ok: true, agregados });
  } catch (err) {
    console.error("Error guardando adelantos detectados:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

app.get("/admin/facturas", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Chaparrita - Facturas de proveedores</title>',
    `<style>${ADMIN_BASE_CSS}
      .factura-item { font-size: 12.5px; padding: 4px 0; border-bottom: 1px solid var(--borde); }
      .factura-item:last-child { border-bottom: none; }
      .cat-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
      .cat-row input { flex: 1; margin-top: 0; }
      .cat-row button { flex-shrink: 0; }
    </style>`,
    '</head><body>',
    '<div class="contenedor">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>🧾 Facturas de proveedores</h1>',
    '<p class="sub">Facturas leídas por foto y confirmadas por WhatsApp. Se cargan solas como gasto en FUDO — el stock NO se actualiza automáticamente, elegís acá abajo para cuáles facturas corresponde sumarlo (por ejemplo insumos de Alfa Nea o El Tano) y para cuáles no (verdulería "varios", servicios, etc.).</p>',

    '<h2 style="margin-top:28px">Categoría fija por proveedor</h2>',
    '<p class="sub">Cuando el bot reconozca a este proveedor en una factura, va a usar siempre esta categoría de gasto en FUDO.</p>',
    '<div id="catBox"></div>',
    '<button id="btnAddCat" class="secundario" type="button">+ Agregar proveedor</button>',
    '<button id="btnSaveCat" style="margin-left:8px">Guardar categorías</button>',
    '<div id="catMsg" style="margin-top:8px;font-size:13px"></div>',

    '<h2 style="margin-top:28px">Facturas cargadas</h2>',
    '<div id="msg">Cargando...</div>',
    '<div id="lista"></div>',
    '<script>',
    'var facturaProveedorCategoria = {};',
    'function pintarCategorias() {',
    '  var box = document.getElementById("catBox");',
    '  box.innerHTML = "";',
    '  Object.keys(facturaProveedorCategoria).forEach(function(proveedor) {',
    '    var row = document.createElement("div");',
    '    row.className = "cat-row";',
    '    var inpProv = document.createElement("input");',
    '    inpProv.value = proveedor;',
    '    inpProv.placeholder = "Nombre del proveedor (ej: Alfa Nea)";',
    '    var inpCat = document.createElement("input");',
    '    inpCat.value = facturaProveedorCategoria[proveedor];',
    '    inpCat.placeholder = "Categoría en FUDO (ej: Insumos)";',
    '    var btnDel = document.createElement("button");',
    '    btnDel.className = "secundario"; btnDel.type = "button"; btnDel.textContent = "Eliminar";',
    '    btnDel.addEventListener("click", function(){ delete facturaProveedorCategoria[proveedor]; pintarCategorias(); });',
    '    inpProv.addEventListener("input", function(){ row.dataset.provActual = inpProv.value; });',
    '    row.dataset.provActual = proveedor;',
    '    row.appendChild(inpProv); row.appendChild(inpCat); row.appendChild(btnDel);',
    '    box.appendChild(row);',
    '  });',
    '}',
    'document.getElementById("btnAddCat").addEventListener("click", function(){',
    '  var nombreNuevo = "Proveedor " + (Object.keys(facturaProveedorCategoria).length + 1);',
    '  facturaProveedorCategoria[nombreNuevo] = "";',
    '  pintarCategorias();',
    '});',
    'document.getElementById("btnSaveCat").addEventListener("click", function(){',
    '  var nuevoMapa = {};',
    '  document.querySelectorAll("#catBox .cat-row").forEach(function(row){',
    '    var inputs = row.querySelectorAll("input");',
    '    var prov = inputs[0].value.trim();',
    '    var cat = inputs[1].value.trim();',
    '    if (prov && cat) nuevoMapa[prov] = cat;',
    '  });',
    '  fetch("/admin/factura-categorias-save", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({mapa: nuevoMapa})})',
    '    .then(function(r){ return r.json(); })',
    '    .then(function(){ document.getElementById("catMsg").textContent = "✅ Guardado."; facturaProveedorCategoria = nuevoMapa; })',
    '    .catch(function(e){ document.getElementById("catMsg").textContent = "Error: " + e.message; });',
    '});',
    'function cargarStockBoton(facturaId, contenedor) {',
    '  var btn = document.createElement("button");',
    '  btn.textContent = "Actualizar stock con esta factura";',
    '  btn.style.marginTop = "6px";',
    '  btn.addEventListener("click", function(){',
    '    btn.disabled = true; btn.textContent = "Actualizando...";',
    '    fetch("/admin/facturas-actualizar-stock", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({id: facturaId})})',
    '      .then(function(r){ return r.json(); })',
    '      .then(function(resultado){',
    '        if (!resultado.ok) { btn.disabled = false; btn.textContent = "Reintentar"; alert("Error: " + resultado.error); return; }',
    '        var resumen = document.createElement("div");',
    '        resumen.style.fontSize = "12.5px"; resumen.style.marginTop = "6px";',
    '        resumen.innerHTML = "✅ Stock actualizado. " + resultado.aplicados.length + " ítem(s) sumado(s)." +',
    '          (resultado.sinMatchear.length > 0 ? "<br>⚠️ Sin emparejar: " + resultado.sinMatchear.join(", ") : "");',
    '        btn.replaceWith(resumen);',
    '      })',
    '      .catch(function(e){ btn.disabled = false; btn.textContent = "Reintentar"; alert("Error: " + e.message); });',
    '  });',
    '  contenedor.appendChild(btn);',
    '}',
    'fetch("/admin/config-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '  .then(function(r){ return r.json(); })',
    '  .then(function(cfg){ facturaProveedorCategoria = cfg.facturaProveedorCategoria || {}; pintarCategorias(); });',
    'fetch("/admin/facturas-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '  .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '  .then(function(data){',
    '    var cont = document.getElementById("lista");',
    '    document.getElementById("msg").textContent = data.length + " factura(s) guardada(s).";',
    '    if (data.length === 0) { cont.innerHTML = "<div class=\\"empty-state\\"><div class=\\"icono\\">🧾</div>No hay facturas cargadas todavía.</div>"; return; }',
    '    data.slice().reverse().forEach(function(f) {',
    '      var div = document.createElement("div");',
    '      div.className = "card";',
    '      var badge = f.cargadaEnFudo ? "<span class=\\"badge badge-alto\\">Cargada en FUDO</span>" : "<span class=\\"badge badge-pendiente\\">Pendiente de cargar a mano</span>";',
    '      var itemsHtml = (f.datos.items || []).map(function(it){ return "<div class=\\"factura-item\\">" + (it.cantidad||"?") + " " + it.producto + " — $" + (it.costoUnitario||"?") + "</div>"; }).join("");',
    '      div.innerHTML = "<b>" + (f.datos.proveedor || "(proveedor sin identificar)") + "</b> " + badge +',
    '        "<div class=\\"cliente-detalle\\">" + (f.datos.fecha || "") + " · Total: $" + (f.datos.total || "?") + "</div>" +',
    '        itemsHtml;',
    '      cont.appendChild(div);',
    '      if (f.cargadaEnFudo && !f.stockAplicado) { cargarStockBoton(f.id, div); }',
    '      else if (f.stockAplicado) { var ya = document.createElement("div"); ya.style.fontSize = "12.5px"; ya.style.marginTop = "6px"; ya.textContent = "✅ Stock ya actualizado."; div.appendChild(ya); }',
    '    });',
    '  })',
    '  .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msg").textContent = "Error: " + e.message; } });',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/factura-categorias-save", requireAdminApi, (req, res) => {
  try {
    const mapa = req.body.mapa;
    if (!mapa || typeof mapa !== "object") {
      return res.status(400).json({ error: "Mapa inválido" });
    }
    const config = loadConfig();
    config.facturaProveedorCategoria = mapa;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("Error guardando categorías de proveedor:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

app.post("/admin/facturas-actualizar-stock", requireAdminApi, async (req, res) => {
  try {
    const { id } = req.body;
    const facturas = loadFacturas();
    const factura = facturas.find((f) => f.id === id);
    if (!factura) return res.status(404).json({ ok: false, error: "Factura no encontrada" });
    if (!factura.cargadaEnFudo) return res.status(400).json({ ok: false, error: "Esta factura no llegó a cargarse en FUDO, no se le puede sumar stock" });
    if (factura.stockAplicado) return res.status(400).json({ ok: false, error: "El stock de esta factura ya se aplicó antes" });

    const resultado = await aplicarStockDeFactura(factura.datos);
    factura.stockAplicado = true;
    factura.stockResultado = resultado;
    saveFacturas(facturas);
    res.json({ ok: true, aplicados: resultado.aplicados, sinMatchear: resultado.sinMatchear });
  } catch (err) {
    console.error("Error aplicando stock de factura desde /admin:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================== Panel de Stock e Ingredientes (datos reales de FUDO) ====================

app.get("/admin/fudo-stock", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Chaparrita - Stock, ingredientes y proveedores (FUDO)</title>',
    `<style>${ADMIN_BASE_CSS}
      table.tabla-stock { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
      table.tabla-stock th { text-align: left; padding: 6px 8px; border-bottom: 2px solid var(--borde); font-size: 12px; color: var(--texto-tenue); }
      table.tabla-stock td { padding: 6px 8px; border-bottom: 1px solid var(--borde); vertical-align: middle; }
      table.tabla-stock input { width: 90px; margin-top: 0; padding: 6px 8px; font-size: 13px; }
      table.tabla-stock input.nombre-input { width: 100%; }
      table.tabla-stock button { padding: 5px 10px; font-size: 12px; }
      .fila-cambiada { background: rgba(255,107,74,0.08); }
      .barra-superior { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom: 6px; }
    </style>`,
    '</head><body>',
    '<div class="contenedor" style="max-width:900px">',
    '<a class="volver" href="/admin">← Volver al panel</a>',
    '<h1>📦 Stock, ingredientes y proveedores (FUDO)</h1>',
    '<p class="sub">Trae los datos REALES desde FUDO (no una copia local) y permite corregir todo ahí mismo. Los cambios se guardan directo en FUDO, no acá.</p>',

    '<h2 style="margin-top:24px">Ingredientes / stock</h2>',
    '<div class="barra-superior">',
    '<button id="btnActualizarIng">🔄 Traer datos actuales de FUDO</button>',
    '<span id="msgIng" style="font-size:13px"></span>',
    '</div>',
    '<table class="tabla-stock" id="tablaIng" style="display:none">',
    '<thead><tr><th>Ingrediente</th><th>Stock</th><th>Costo</th><th>Stock mín.</th><th></th></tr></thead>',
    '<tbody id="tbodyIng"></tbody>',
    '</table>',

    '<h2 style="margin-top:32px">Bebidas y productos con stock propio</h2>',
    '<p class="sub" style="margin-top:-4px">Cosas que se compran y venden tal cual (no como receta armada con ingredientes) — bebidas cerradas, por ejemplo.</p>',
    '<div class="barra-superior">',
    '<button id="btnActualizarProd">🔄 Traer productos actuales de FUDO</button>',
    '<span id="msgProd" style="font-size:13px"></span>',
    '</div>',
    '<table class="tabla-stock" id="tablaProd" style="display:none">',
    '<thead><tr><th>Producto</th><th>Stock</th><th>Costo</th><th>Stock mín.</th><th></th></tr></thead>',
    '<tbody id="tbodyProd"></tbody>',
    '</table>',

    '<h2 style="margin-top:32px">Proveedores</h2>',
    '<p class="sub" style="margin-top:-4px">Ojo: guardar cambios de proveedor todavía no está 100% confirmado en la API de FUDO — si al guardar te da error, avisame para ajustarlo.</p>',
    '<div class="barra-superior">',
    '<button id="btnActualizarProv">🔄 Traer proveedores actuales de FUDO</button>',
    '<span id="msgProv" style="font-size:13px"></span>',
    '</div>',
    '<table class="tabla-stock" id="tablaProv" style="display:none">',
    '<thead><tr><th>Nombre</th><th>CUIT</th><th></th></tr></thead>',
    '<tbody id="tbodyProv"></tbody>',
    '</table>',

    '<script>',
    'function cargarIngredientes() {',
    '  document.getElementById("msgIng").textContent = "Consultando FUDO...";',
    '  fetch("/admin/fudo-ingredientes-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      if (!data.ok) { document.getElementById("msgIng").textContent = "Error: " + data.error; return; }',
    '      var ingredientes = data.ingredientes;',
    '      document.getElementById("msgIng").textContent = ingredientes.length + " ingrediente(s) — actualizado ahora mismo.";',
    '      var tbody = document.getElementById("tbodyIng");',
    '      tbody.innerHTML = "";',
    '      ingredientes.forEach(function(ing) {',
    '        var tr = document.createElement("tr");',
    '        tr.dataset.id = ing.id;',
    '        var tdNombre = document.createElement("td"); tdNombre.textContent = ing.nombre;',
    '        var tdStock = document.createElement("td");',
    '        var inpStock = document.createElement("input"); inpStock.type = "number"; inpStock.step = "any"; inpStock.value = ing.stock;',
    '        tdStock.appendChild(inpStock);',
    '        var tdCosto = document.createElement("td");',
    '        var inpCosto = document.createElement("input"); inpCosto.type = "number"; inpCosto.step = "any"; inpCosto.value = ing.costo;',
    '        tdCosto.appendChild(inpCosto);',
    '        var tdMin = document.createElement("td");',
    '        var inpMin = document.createElement("input"); inpMin.type = "number"; inpMin.step = "any"; inpMin.value = ing.minStock;',
    '        tdMin.appendChild(inpMin);',
    '        var tdBtn = document.createElement("td");',
    '        var btnGuardar = document.createElement("button"); btnGuardar.textContent = "Guardar"; btnGuardar.className = "secundario";',
    '        [inpStock, inpCosto, inpMin].forEach(function(inp){ inp.addEventListener("input", function(){ tr.classList.add("fila-cambiada"); }); });',
    '        btnGuardar.addEventListener("click", function(){',
    '          btnGuardar.disabled = true; btnGuardar.textContent = "Guardando...";',
    '          fetch("/admin/fudo-ingrediente-actualizar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({',
    '            id: ing.id, stock: parseFloat(inpStock.value), cost: parseFloat(inpCosto.value), minStock: parseFloat(inpMin.value)',
    '          })})',
    '            .then(function(r){ return r.json(); })',
    '            .then(function(resultado){',
    '              if (!resultado.ok) { alert("Error: " + resultado.error); btnGuardar.disabled = false; btnGuardar.textContent = "Guardar"; return; }',
    '              btnGuardar.textContent = "✅ Guardado"; tr.classList.remove("fila-cambiada");',
    '              setTimeout(function(){ btnGuardar.textContent = "Guardar"; btnGuardar.disabled = false; }, 1500);',
    '            })',
    '            .catch(function(e){ alert("Error: " + e.message); btnGuardar.disabled = false; btnGuardar.textContent = "Guardar"; });',
    '        });',
    '        tdBtn.appendChild(btnGuardar);',
    '        tr.appendChild(tdNombre); tr.appendChild(tdStock); tr.appendChild(tdCosto); tr.appendChild(tdMin); tr.appendChild(tdBtn);',
    '        tbody.appendChild(tr);',
    '      });',
    '      document.getElementById("tablaIng").style.display = "table";',
    '    })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msgIng").textContent = "Error: " + e.message; } });',
    '}',
    'function cargarProductos() {',
    '  document.getElementById("msgProd").textContent = "Consultando FUDO...";',
    '  fetch("/admin/fudo-productos-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      if (!data.ok) { document.getElementById("msgProd").textContent = "Error: " + data.error; return; }',
    '      var productos = data.productos;',
    '      document.getElementById("msgProd").textContent = productos.length + " producto(s) — actualizado ahora mismo.";',
    '      var tbody = document.getElementById("tbodyProd");',
    '      tbody.innerHTML = "";',
    '      productos.forEach(function(prod) {',
    '        var tr = document.createElement("tr");',
    '        tr.dataset.id = prod.id;',
    '        var tdNombre = document.createElement("td"); tdNombre.textContent = prod.nombre;',
    '        var tdStock = document.createElement("td");',
    '        var inpStock = document.createElement("input"); inpStock.type = "number"; inpStock.step = "any"; inpStock.value = prod.stock;',
    '        tdStock.appendChild(inpStock);',
    '        var tdCosto = document.createElement("td");',
    '        var inpCosto = document.createElement("input"); inpCosto.type = "number"; inpCosto.step = "any"; inpCosto.value = prod.costo;',
    '        tdCosto.appendChild(inpCosto);',
    '        var tdMin = document.createElement("td");',
    '        var inpMin = document.createElement("input"); inpMin.type = "number"; inpMin.step = "any"; inpMin.value = prod.minStock;',
    '        tdMin.appendChild(inpMin);',
    '        var tdBtn = document.createElement("td");',
    '        var btnGuardar = document.createElement("button"); btnGuardar.textContent = "Guardar"; btnGuardar.className = "secundario";',
    '        [inpStock, inpCosto, inpMin].forEach(function(inp){ inp.addEventListener("input", function(){ tr.classList.add("fila-cambiada"); }); });',
    '        btnGuardar.addEventListener("click", function(){',
    '          btnGuardar.disabled = true; btnGuardar.textContent = "Guardando...";',
    '          fetch("/admin/fudo-producto-actualizar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({',
    '            id: prod.id, stock: parseFloat(inpStock.value), cost: parseFloat(inpCosto.value), minStock: parseFloat(inpMin.value)',
    '          })})',
    '            .then(function(r){ return r.json(); })',
    '            .then(function(resultado){',
    '              if (!resultado.ok) { alert("Error: " + resultado.error); btnGuardar.disabled = false; btnGuardar.textContent = "Guardar"; return; }',
    '              btnGuardar.textContent = "✅ Guardado"; tr.classList.remove("fila-cambiada");',
    '              setTimeout(function(){ btnGuardar.textContent = "Guardar"; btnGuardar.disabled = false; }, 1500);',
    '            })',
    '            .catch(function(e){ alert("Error: " + e.message); btnGuardar.disabled = false; btnGuardar.textContent = "Guardar"; });',
    '        });',
    '        tdBtn.appendChild(btnGuardar);',
    '        tr.appendChild(tdNombre); tr.appendChild(tdStock); tr.appendChild(tdCosto); tr.appendChild(tdMin); tr.appendChild(tdBtn);',
    '        tbody.appendChild(tr);',
    '      });',
    '      document.getElementById("tablaProd").style.display = "table";',
    '    })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msgProd").textContent = "Error: " + e.message; } });',
    '}',
    'function cargarProveedores() {',
    '  document.getElementById("msgProv").textContent = "Consultando FUDO...";',
    '  fetch("/admin/fudo-proveedores-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) { window.location.href = "/admin/login"; throw new Error("Sesión vencida"); } return r.json(); })',
    '    .then(function(data){',
    '      if (!data.ok) { document.getElementById("msgProv").textContent = "Error: " + data.error; return; }',
    '      var proveedores = data.proveedores;',
    '      document.getElementById("msgProv").textContent = proveedores.length + " proveedor(es) — actualizado ahora mismo.";',
    '      var tbody = document.getElementById("tbodyProv");',
    '      tbody.innerHTML = "";',
    '      proveedores.forEach(function(prov) {',
    '        var tr = document.createElement("tr");',
    '        tr.dataset.id = prov.id;',
    '        var tdNombre = document.createElement("td");',
    '        var inpNombre = document.createElement("input"); inpNombre.className = "nombre-input"; inpNombre.value = prov.nombre;',
    '        tdNombre.appendChild(inpNombre);',
    '        var tdCuit = document.createElement("td");',
    '        var inpCuit = document.createElement("input"); inpCuit.value = prov.cuit || "";',
    '        tdCuit.appendChild(inpCuit);',
    '        var tdBtn = document.createElement("td");',
    '        var btnGuardar = document.createElement("button"); btnGuardar.textContent = "Guardar"; btnGuardar.className = "secundario";',
    '        [inpNombre, inpCuit].forEach(function(inp){ inp.addEventListener("input", function(){ tr.classList.add("fila-cambiada"); }); });',
    '        btnGuardar.addEventListener("click", function(){',
    '          btnGuardar.disabled = true; btnGuardar.textContent = "Guardando...";',
    '          fetch("/admin/fudo-proveedor-actualizar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({',
    '            id: prov.id, name: inpNombre.value, fiscalNumber: inpCuit.value',
    '          })})',
    '            .then(function(r){ return r.json(); })',
    '            .then(function(resultado){',
    '              if (!resultado.ok) { alert("Error: " + resultado.error); btnGuardar.disabled = false; btnGuardar.textContent = "Guardar"; return; }',
    '              btnGuardar.textContent = "✅ Guardado"; tr.classList.remove("fila-cambiada");',
    '              setTimeout(function(){ btnGuardar.textContent = "Guardar"; btnGuardar.disabled = false; }, 1500);',
    '            })',
    '            .catch(function(e){ alert("Error: " + e.message); btnGuardar.disabled = false; btnGuardar.textContent = "Guardar"; });',
    '        });',
    '        tdBtn.appendChild(btnGuardar);',
    '        tr.appendChild(tdNombre); tr.appendChild(tdCuit); tr.appendChild(tdBtn);',
    '        tbody.appendChild(tr);',
    '      });',
    '      document.getElementById("tablaProv").style.display = "table";',
    '    })',
    '    .catch(function(e){ if (e.message !== "Sesión vencida") { document.getElementById("msgProv").textContent = "Error: " + e.message; } });',
    '}',
    'document.getElementById("btnActualizarIng").addEventListener("click", cargarIngredientes);',
    'document.getElementById("btnActualizarProd").addEventListener("click", cargarProductos);',
    'document.getElementById("btnActualizarProv").addEventListener("click", cargarProveedores);',
    'cargarIngredientes();',
    'cargarProductos();',
    'cargarProveedores();',
    '</' + 'script>',
    '</div>',
    '</body></html>'
  ].join("\n");
  res.type("html").send(html);
});

app.post("/admin/fudo-ingredientes-data", requireAdminApi, async (_req, res) => {
  try {
    const ingredientes = await getFudoIngredientes(true); // true = forzar datos frescos de FUDO, ignorar caché
    res.json({ ok: true, ingredientes });
  } catch (err) {
    console.error("Error trayendo ingredientes de FUDO para /admin:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/fudo-ingrediente-actualizar", requireAdminApi, async (req, res) => {
  try {
    const { id, stock, cost, minStock } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "Falta el id del ingrediente" });
    const cambios = {};
    if (!isNaN(stock)) cambios.stock = stock;
    if (!isNaN(cost)) cambios.cost = cost;
    if (!isNaN(minStock)) cambios.minStock = minStock;
    const actualizado = await actualizarIngredienteFudo(id, cambios);
    if (!actualizado) return res.status(500).json({ ok: false, error: "FUDO no devolvió el ingrediente actualizado — revisar log de Railway" });
    res.json({ ok: true, ingrediente: actualizado });
  } catch (err) {
    console.error("Error actualizando ingrediente desde /admin:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/fudo-productos-data", requireAdminApi, async (_req, res) => {
  try {
    const productos = await getFudoProductosConStock(true); // true = forzar datos frescos de FUDO
    res.json({ ok: true, productos });
  } catch (err) {
    console.error("Error trayendo productos de FUDO para /admin:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/fudo-producto-actualizar", requireAdminApi, async (req, res) => {
  try {
    const { id, stock, cost, minStock } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "Falta el id del producto" });
    const cambios = {};
    if (!isNaN(stock)) cambios.stock = stock;
    if (!isNaN(cost)) cambios.cost = cost;
    if (!isNaN(minStock)) cambios.minStock = minStock;
    const actualizado = await actualizarProductoFudo(id, cambios);
    if (!actualizado) return res.status(500).json({ ok: false, error: "FUDO no devolvió el producto actualizado — puede que la ruta de Update product no sea la esperada, revisar log de Railway" });
    res.json({ ok: true, producto: actualizado });
  } catch (err) {
    console.error("Error actualizando producto desde /admin:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/fudo-proveedores-data", requireAdminApi, async (_req, res) => {
  try {
    const proveedores = await getFudoProveedores(true); // true = forzar datos frescos de FUDO
    res.json({ ok: true, proveedores });
  } catch (err) {
    console.error("Error trayendo proveedores de FUDO para /admin:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/fudo-proveedor-actualizar", requireAdminApi, async (req, res) => {
  try {
    const { id, name, fiscalNumber } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "Falta el id del proveedor" });
    const cambios = {};
    if (name) cambios.name = name;
    if (fiscalNumber !== undefined) cambios.fiscalNumber = fiscalNumber || null;
    const actualizado = await actualizarProveedorFudo(id, cambios);
    if (!actualizado) return res.status(500).json({ ok: false, error: "FUDO no devolvió el proveedor actualizado — puede que la ruta de Update provider no sea la esperada, revisar log de Railway" });
    res.json({ ok: true, proveedor: actualizado });
  } catch (err) {
    console.error("Error actualizando proveedor desde /admin:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/facturas-data", requireAdminApi, (_req, res) => {
  res.json(loadFacturas());
});


app.get("/admin/inbox", requireAdminPage, (_req, res) => {
  const html = [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
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
      .wa-fila.entrante .wa-burbuja { background: #FFFFFF; color: #111B21; border-top-left-radius: 2px; }
      .wa-fila.saliente .wa-burbuja { background: #D9FDD3; color: #111B21; border-top-right-radius: 2px; }
      .wa-meta { display: flex; align-items: center; gap: 4px; justify-content: flex-end; margin-top: 3px; font-size: 10.5px; color: rgba(17,27,33,0.45); }
      .wa-fila.entrante .wa-meta { color: #667781; }
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
    '      ultimoConteoMensajes = chat.mensajes.length;',
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
    '',
    '// Auto-refresco cada 1.5s: solo redibuja si cambió algo, para no cortar lo que',
    '// estés escribiendo ni generar parpadeos innecesarios.',
    'var ultimoConteoMensajes = 0;',
    'function chequearActualizaciones() {',
    '  if (document.hidden) return;',
    '  fetch("/admin/inbox-data", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})',
    '    .then(function(r){ if (r.status === 401) return null; return r.json(); })',
    '    .then(function(data){',
    '      if (!data) return;',
    '      todosLosChats = data.chats;',
    '      pintarLista(todosLosChats);',
    '      if (!telefonoActivo) return;',
    '      var chat = todosLosChats.find(function(c){ return c.telefono === telefonoActivo; });',
    '      if (!chat) return;',
    '      document.getElementById("chkManual").checked = !!chat.modoManual;',
    '      if (chat.mensajes.length !== ultimoConteoMensajes) {',
    '        ultimoConteoMensajes = chat.mensajes.length;',
    '        pintarMensajes(chat.mensajes);',
    '      }',
    '    })',
    '    .catch(function(){});',
    '}',
    'setInterval(chequearActualizaciones, 1500);',
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
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
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
// Normaliza un teléfono argentino a un formato canónico y consistente: "+549" + resto,
// sin importar cómo lo haya tipeado la persona en /admin (con o sin "9", con o sin "+54",
// con espacios/guiones, o directamente el número local sin código de país). Así el
// problema de que un teléfono cargado "distinto" no matchee con el que llega de WhatsApp
// (soloDigitos ya lo tolera al comparar, pero esto además deja guardado un formato limpio
// y correcto desde el vamos).
function normalizarTelefonoArgentino(numero) {
  let digitos = (numero || "").replace(/[^\d]/g, "");
  if (!digitos) return "";
  if (digitos.startsWith("54")) {
    if (!digitos.startsWith("549")) {
      digitos = "549" + digitos.slice(2); // le faltaba el "9" de celular
    }
  } else if (digitos.startsWith("9")) {
    digitos = "54" + digitos; // le faltaba el código de país (54)
  } else {
    digitos = "549" + digitos; // número local, sin código de país ni "9"
  }
  return "+" + digitos;
}

// Recorre cualquier objeto/array de la config buscando campos "telefono" (string) y los
// normaliza in-place. Genérico a propósito: cubre equipo[], deliveryConfig[], staff.*, y
// cualquier otro lugar donde haya un teléfono, presente o futuro, sin tener que listar
// cada campo a mano.
function normalizarTelefonosEnConfig(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    const valor = obj[key];
    if (key === "telefono" && typeof valor === "string" && valor.trim()) {
      obj[key] = normalizarTelefonoArgentino(valor);
    } else if (valor && typeof valor === "object") {
      normalizarTelefonosEnConfig(valor);
    }
  }
}

app.get("/admin/config", requireAdminPage, (_req, res) => {
  if (ES_STAGING === "true") {
    // Solo en staging: un banner arriba de todo con un botón para traer la config real.
    const bannerStaging = `
      <div style="max-width:700px;margin:16px auto 0;padding:14px 16px;background:var(--card);border:1px solid var(--alerta);border-radius:var(--radio);font-size:13.5px;color:var(--texto);">
        <span style="color:var(--alerta);font-weight:700;">🧪 Entorno de STAGING</span>
        <span style="color:var(--texto-tenue);"> — ¿config vacía o desactualizada?</span>
        <button id="btnImportarConfig" class="secundario" style="margin-left:8px;margin-top:0;padding:7px 14px;font-size:12.5px;">Traer configuración real</button>
        <span id="msgImportarConfig" style="margin-left:8px;color:var(--texto-tenue);"></span>
      </div>
      <script>
        document.getElementById("btnImportarConfig").addEventListener("click", function(){
          var btn = this;
          btn.disabled = true; btn.textContent = "Importando...";
          fetch("/admin/importar-config-desde-produccion", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({})})
            .then(function(r){ return r.json(); })
            .then(function(data){
              if (data.error) { document.getElementById("msgImportarConfig").textContent = "❌ " + data.error; btn.disabled = false; btn.textContent = "Traer configuración real"; return; }
              document.getElementById("msgImportarConfig").textContent = "✅ Listo, recargando...";
              setTimeout(function(){ window.location.reload(); }, 1200);
            })
            .catch(function(e){ document.getElementById("msgImportarConfig").textContent = "❌ " + e.message; btn.disabled = false; btn.textContent = "Traer configuración real"; });
        });
      </script>`;
    return res.type("html").send(ADMIN_CONFIG_PAGE.replace("<body>", "<body>" + bannerStaging));
  }
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
    normalizarTelefonosEnConfig(nuevaConfig);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(nuevaConfig, null, 2), "utf8");
    console.log("Configuración actualizada desde /admin/config.");
    res.json({ ok: true });
  } catch (err) {
    console.error("Error al guardar config:", err);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

// Trae una copia de la configuración REAL (producción) y la pisa acá — solo pensado para
// arrancar un ambiente de staging con datos de partida (equipo, horarios, menú, etc.) en vez
// de un config.json vacío. SALVAGUARDA: solo funciona si este entorno tiene la variable
// ES_STAGING=true cargada — nunca puede correr por error en producción, porque ahí esa
// variable no existe.
const CHAPARRITA_URL_PRODUCCION = "https://chaparrita-backend-production.up.railway.app";

app.post("/admin/importar-config-desde-produccion", requireAdminApi, async (req, res) => {
  if (ES_STAGING !== "true") {
    return res.status(403).json({ error: "Esto solo está habilitado en staging (falta la variable ES_STAGING en este entorno)." });
  }
  try {
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({ error: "Falta ADMIN_PASSWORD en este entorno" });
    }
    const loginRes = await fetch(`${CHAPARRITA_URL_PRODUCCION}/admin/login-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    if (!loginRes.ok) {
      return res.status(502).json({ error: "No se pudo iniciar sesión en el backend real — revisar que ADMIN_PASSWORD sea igual en los dos entornos" });
    }
    const cookie = loginRes.headers.get("set-cookie");
    if (!cookie) {
      return res.status(502).json({ error: "El backend real no devolvió cookie de sesión" });
    }

    const configRes = await fetch(`${CHAPARRITA_URL_PRODUCCION}/admin/config-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    if (!configRes.ok) {
      return res.status(502).json({ error: "No se pudo traer la configuración del backend real" });
    }
    const configReal = await configRes.json();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configReal, null, 2), "utf8");
    console.log("Configuración importada desde producción a este entorno de staging.");
    res.json({ ok: true });
  } catch (err) {
    console.error("Error importando configuración desde producción:", err);
    res.status(500).json({ error: err.message });
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
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
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
    const dueñoActual = equipoConPermiso(config, "esDueño")[0];
    const telefonoDestino = soloDigitos((dueñoActual && dueñoActual.telefono) || "");

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

// ==================== Backup automático diario (por WhatsApp, al dueño) ====================
// Comprime toda la carpeta de datos (config, reservas, adelantos, sueldos, facturas, etc.)
// y se la manda como archivo al dueño por WhatsApp — así siempre hay una copia fuera del
// volumen de Railway, sin necesidad de contratar ni configurar ningún storage externo.
let ultimoBackupFecha = null; // "YYYY-MM-DD" del último backup ya enviado, para no mandarlo dos veces el mismo día
const HORA_BACKUP_DIARIO = 5; // 5 de la madrugada, hora de Formosa — fuera del horario de atención

async function hacerBackupYEnviarloPorWhatsapp() {
  // En staging no tiene sentido mandar backups (son datos de prueba) — solo corre en el real.
  if (ES_STAGING === "true") return;
  try {
    const config = loadConfig();
    const dueño = equipoConPermiso(config, "esDueño")[0];
    if (!dueño || !dueño.telefono) {
      console.log("Backup diario: no hay ningún miembro del equipo marcado como dueño con teléfono cargado — se omite.");
      return;
    }
    const zip = new AdmZip();
    zip.addLocalFolder(DATA_DIR);
    const buffer = zip.toBuffer();
    const fechaHoy = new Date().toISOString().slice(0, 10);
    const nombreArchivo = `backup-chaparrita-${fechaHoy}.zip`;
    const enviado = await subirYEnviarDocumentoWhatsapp(
      dueño.telefono,
      buffer,
      nombreArchivo,
      "application/zip",
      `📦 Backup automático del ${fechaHoy} — reservas, sueldos, adelantos, facturas y toda la configuración de Chaparrita.`
    );
    if (enviado) {
      console.log(`Backup diario enviado a ${dueño.telefono} (${(buffer.length / 1024).toFixed(0)} KB).`);
    } else {
      console.error("Backup diario: falló el envío por WhatsApp.");
    }
  } catch (err) {
    console.error("Error generando/enviando el backup diario:", err);
  }
}

async function chequearBackupDiario() {
  try {
    const ahora = new Date();
    const horaArgentina = new Date(ahora.toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
    const fechaHoy = horaArgentina.toISOString().slice(0, 10);
    if (ultimoBackupFecha === fechaHoy) return; // ya se mandó hoy
    if (horaArgentina.getHours() < HORA_BACKUP_DIARIO) return; // todavía no es la hora
    ultimoBackupFecha = fechaHoy;
    await hacerBackupYEnviarloPorWhatsapp();
  } catch (err) {
    console.error("Error chequeando si toca backup diario:", err);
  }
}
setInterval(chequearBackupDiario, 30 * 60 * 1000); // chequea cada 30 minutos si ya es la hora
setTimeout(chequearBackupDiario, 20 * 1000); // y un primer chequeo a los 20seg de arrancar

// Backup manual, para pedirlo en cualquier momento desde /admin sin esperar a las 5am.
app.post("/admin/backup-ahora", requireAdminApi, async (_req, res) => {
  try {
    if (ES_STAGING === "true") {
      return res.status(400).json({ error: "En staging no se mandan backups (son datos de prueba)." });
    }
    const config = loadConfig();
    const dueño = equipoConPermiso(config, "esDueño")[0];
    if (!dueño || !dueño.telefono) {
      return res.status(400).json({ error: "No hay nadie marcado como \"Es el dueño\" con teléfono cargado en el Equipo." });
    }
    await hacerBackupYEnviarloPorWhatsapp();
    res.json({ ok: true, enviadoA: dueño.telefono });
  } catch (err) {
    console.error("Error en backup manual:", err);
    res.status(500).json({ error: err.message });
  }
});

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

    const dueñoParaCumple = equipoConPermiso(config, "esDueño")[0];
    const telefonoDestino = soloDigitos(cfg.telefono) || soloDigitos((dueñoParaCumple && dueñoParaCumple.telefono) || "");
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

// ==================== Recordatorio de comandas sin confirmar ====================
async function chequearComandasSinConfirmar() {
  try {
    const ahora = Date.now();
    const QUINCE_MIN = 15 * 60 * 1000;
    for (const [telefono, cola] of pendingComandas.entries()) {
      if (cola.length === 0) continue;
      const masVieja = cola[0];
      if (ahora - masVieja.creadaEn >= QUINCE_MIN && !masVieja.recordatorioEnviado) {
        if (masVieja.tipo === "comanda_cocina") {
          await sendWhatsappText(telefono, `¡Che! 👋 ¿Te llegó bien esta comanda impresa?\n\n${masVieja.resumen}`);
          await sendWhatsappButtons(telefono, "¿Te llegó bien la comanda impresa?", [
            { id: "comanda_recibida", titulo: "Sí, recibida ✅" },
            { id: "comanda_no_recibida", titulo: "No, revisar 🖨️" },
          ]);
        } else {
          await sendWhatsappText(telefono, `¡Che! 👋 ¿Me confirmás que esta reserva ya quedó agendada?\n\n${masVieja.resumen}`);
          await sendWhatsappButtons(telefono, "¿Ya quedó agendada?", [
            { id: "reserva_confirmada", titulo: "Sí, confirmado ✅" },
          ]);
        }
        masVieja.recordatorioEnviado = true;
        console.log(`Recordatorio de comanda sin confirmar enviado a ${telefono} (comanda ${masVieja.id}, tipo ${masVieja.tipo}).`);
      }
    }
  } catch (err) {
    console.error("Error chequeando comandas sin confirmar:", err);
  }
}

setInterval(chequearComandasSinConfirmar, 5 * 60 * 1000); // cada 5 minutos
setTimeout(chequearComandasSinConfirmar, 40 * 1000); // primer chequeo a los 40seg de arrancar

// ==================== API General de FUDO (v1alpha1) — para stock, gastos, etc. ====================
// Documentación de autenticación confirmada. Todavía NO tenemos la URL base ni el formato
// exacto de los endpoints de recursos (Gastos, Ingredientes, etc.) — solo el de login, que
// es lo único que armamos por ahora. El resto se conecta cuando tengamos esa documentación.
const FUDO_AUTH_URL = "https://auth.fu.do/api";

let fudoApiToken = null;
let fudoApiTokenExpiraEn = 0; // timestamp en ms

async function getFudoApiToken() {
  if (fudoApiToken && Date.now() < fudoApiTokenExpiraEn) {
    return fudoApiToken;
  }
  if (!FUDO_API_KEY || !FUDO_API_SECRET) {
    console.error("Faltan FUDO_API_KEY / FUDO_API_SECRET en las variables de entorno de Railway.");
    return null;
  }
  try {
    const response = await fetch(FUDO_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ apiKey: (FUDO_API_KEY || "").trim(), apiSecret: (FUDO_API_SECRET || "").trim() }),
    });
    const data = await response.json();
    if (!response.ok || !data.token) {
      console.error("Error obteniendo token de la API general de FUDO:", JSON.stringify(data));
      return null;
    }
    fudoApiToken = data.token;
    // La documentación dice que dura 24hs y devuelve "exp" (segundos desde 1970 en formato
    // string) — lo usamos si viene, si no, asumimos 23hs de margen de seguridad.
    fudoApiTokenExpiraEn = data.exp ? Number(data.exp) * 1000 - 30 * 60 * 1000 : Date.now() + 23 * 60 * 60 * 1000;
    console.log("Token de la API general de FUDO renovado correctamente.");
    return fudoApiToken;
  } catch (err) {
    console.error("Error de red obteniendo token de la API general de FUDO:", err);
    return null;
  }
}

const FUDO_API_GENERAL_BASE = "https://api.fu.do/v1alpha1";

// Helper genérico para llamar a la API general (distinta de la de pedidos — usa Bearer
// token en vez de los headers custom de la otra integración).
async function fudoApiFetch(rutaRelativa, options = {}) {
  const token = await getFudoApiToken();
  if (!token) return null;
  try {
    const response = await fetch(`${FUDO_API_GENERAL_BASE}${rutaRelativa}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(`Error en API general de FUDO (${rutaRelativa}):`, response.status, JSON.stringify(data));
      return null;
    }
    return data;
  } catch (err) {
    console.error(`Error de red llamando a la API general de FUDO (${rutaRelativa}):`, err);
    return null;
  }
}

// ---- Proveedores de FUDO (para emparejar el proveedor de una factura leída por foto con
//      el registro real en FUDO) — se cachea 30 minutos ----
let fudoProveedoresCache = null;
let fudoProveedoresCacheEn = 0;

async function getFudoProveedores(forzarActualizacion = false) {
  if (!forzarActualizacion && fudoProveedoresCache && Date.now() - fudoProveedoresCacheEn < 30 * 60 * 1000) {
    return fudoProveedoresCache;
  }
  const data = await fudoApiFetch("/providers?filter[active]=eq.true&page[size]=500&fields[provider]=name,fiscalNumber,active");
  if (data && Array.isArray(data.data)) {
    fudoProveedoresCache = data.data.map((p) => ({ id: p.id, nombre: p.attributes.name, cuit: p.attributes.fiscalNumber || null }));
    fudoProveedoresCacheEn = Date.now();
    console.log(`Proveedores de FUDO actualizados: ${fudoProveedoresCache.length} proveedor(es).`);
    return fudoProveedoresCache;
  }
  return fudoProveedoresCache || [];
}

// Crea un proveedor nuevo en FUDO (usado cuando la factura trae una razón social/CUIT que
// no matchea con ningún proveedor existente — ej: un proveedor con más de una razón social,
// mayorista y minorista, cada una con su propio CUIT).
async function crearProveedorFudo(nombre, cuit) {
  const attributes = { active: true, name: nombre };
  if (cuit) attributes.fiscalNumber = cuit;
  const body = { data: { type: "Provider", attributes } };
  const data = await fudoApiFetch("/providers", { method: "POST", body: JSON.stringify(body) });
  if (!data || !data.data) return null;
  fudoProveedoresCache = null; // el próximo getFudoProveedores() va a traer este nuevo también
  return { id: data.data.id, nombre: data.data.attributes.name, cuit: data.data.attributes.fiscalNumber || null };
}

// Actualiza un proveedor existente (nombre, CUIT, etc). OJO: la ruta es la misma que sigue
// el patrón de "Update ingredient" (PATCH /providers/{id}) — no la vimos confirmada en la
// documentación todavía. Si falla, revisar el log de Railway (buscar "providers/") para
// confirmar la ruta real.
async function actualizarProveedorFudo(id, cambios) {
  const body = { data: { id: String(id), type: "Provider", attributes: cambios } };
  const data = await fudoApiFetch(`/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  if (data && data.data) fudoProveedoresCache = null;
  return data ? data.data : null;
}

// Normaliza un CUIT a solo dígitos, para comparar sin importar guiones/espacios.
function soloDigitosCuit(cuit) {
  return (cuit || "").replace(/[^\d]/g, "");
}

// Busca el proveedor real de FUDO para una factura leída por foto: primero por CUIT (más
// confiable — distingue razones sociales distintas con el mismo nombre comercial), después
// por nombre, y si no encuentra ninguno, CREA el proveedor nuevo en FUDO con el nombre y
// CUIT tal como figuran en la factura.
async function matchearOCrearProveedorFudo(datosFactura) {
  const proveedoresFudo = await getFudoProveedores();
  const cuitFactura = soloDigitosCuit(datosFactura.cuit);

  if (cuitFactura) {
    const porCuit = proveedoresFudo.find((p) => soloDigitosCuit(p.cuit) === cuitFactura);
    if (porCuit) return porCuit;
  }

  const porNombre = matchearProveedorFudo(datosFactura.proveedor, proveedoresFudo);
  if (porNombre) return porNombre;

  if (!datosFactura.proveedor) return null; // sin nombre ni CUIT, no hay nada que crear
  console.log(`Proveedor "${datosFactura.proveedor}" (CUIT: ${datosFactura.cuit || "sin CUIT"}) no encontrado en FUDO — creándolo nuevo.`);
  return crearProveedorFudo(datosFactura.proveedor, datosFactura.cuit || null);
}

// ---- Categorías de gastos de FUDO (para elegir la categoría correcta al cargar un gasto)
//      — se cachea 30 minutos. OJO: la ruta "/expense-categories" es la más probable según
//      el mismo patrón que "/providers", pero no la vimos confirmada en la documentación
//      — si el primer intento real falla, va a quedar clarísimo en el log de Railway
//      (error 404), y ahí la corregimos al toque. ----
let fudoCategoriasGastoCache = null;
let fudoCategoriasGastoCacheEn = 0;

async function getFudoCategoriasGasto() {
  if (fudoCategoriasGastoCache && Date.now() - fudoCategoriasGastoCacheEn < 30 * 60 * 1000) {
    return fudoCategoriasGastoCache;
  }
  const data = await fudoApiFetch("/expense-categories?filter[active]=eq.true&page[size]=500");
  if (data && Array.isArray(data.data)) {
    fudoCategoriasGastoCache = data.data.map((c) => ({ id: c.id, nombre: c.attributes.name, categoriaFinanciera: c.attributes.financialCategory }));
    fudoCategoriasGastoCacheEn = Date.now();
    console.log(`Categorías de gasto de FUDO actualizadas: ${fudoCategoriasGastoCache.length} categoría(s).`);
    return fudoCategoriasGastoCache;
  }
  console.log("No se pudo traer /expense-categories — si el error de arriba es 404, probablemente la ruta real tenga otro nombre (avisame y lo corrijo).");
  return fudoCategoriasGastoCache || [];
}

// ---- Ingredientes de FUDO (catálogo + stock actual) — para emparejar los productos de
//      una factura leída por foto con el ingrediente real, y saber cuánto stock tiene
//      ANTES de sumarle lo comprado. Se cachea 10 minutos (más corto que el resto, porque
//      el stock cambia seguido). ----
let fudoIngredientesCache = null;
let fudoIngredientesCacheEn = 0;

async function getFudoIngredientes(forzarActualizacion = false) {
  if (!forzarActualizacion && fudoIngredientesCache && Date.now() - fudoIngredientesCacheEn < 10 * 60 * 1000) {
    return fudoIngredientesCache;
  }
  const data = await fudoApiFetch("/ingredients?page[size]=500");
  if (data && Array.isArray(data.data)) {
    fudoIngredientesCache = data.data.map((i) => ({
      id: i.id,
      nombre: i.attributes.name,
      costo: i.attributes.cost,
      stock: i.attributes.stock,
      minStock: i.attributes.minStock,
      stockControl: i.attributes.stockControl,
    }));
    fudoIngredientesCacheEn = Date.now();
    console.log(`Ingredientes de FUDO actualizados: ${fudoIngredientesCache.length} ingrediente(s).`);
    return fudoIngredientesCache;
  }
  return fudoIngredientesCache || [];
}

// Actualiza un ingrediente en FUDO (ej: sumar stock tras leer una factura).
// "cambios" es un objeto solo con los attributes que se quieran tocar
// (cost, minStock, name, price, stock, stockControl).
async function actualizarIngredienteFudo(id, cambios) {
  const body = {
    data: {
      id: String(id),
      type: "Ingredient",
      attributes: cambios,
    },
  };
  const data = await fudoApiFetch(`/ingredients/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (data && data.data) {
    // Invalidamos el caché de ingredientes para que el próximo getFudoIngredientes()
    // traiga el stock/costo ya actualizado en vez del valor viejo cacheado.
    fudoIngredientesCache = null;
  }
  return data ? data.data : null;
}

// Suma stock comprado sobre el stock actual (no lo reemplaza), y de paso actualiza el
// costo si vino un costo nuevo en la factura.
async function sumarStockIngrediente(id, cantidadComprada, nuevoCosto = null) {
  const ingredientes = await getFudoIngredientes();
  const ingrediente = ingredientes.find((i) => String(i.id) === String(id));
  if (!ingrediente) throw new Error(`Ingrediente ${id} no encontrado en FUDO`);
  const nuevoStock = (ingrediente.stock || 0) + cantidadComprada;
  const cambios = { stock: nuevoStock };
  if (nuevoCosto !== null) cambios.cost = nuevoCosto;
  return actualizarIngredienteFudo(id, cambios);
}

// ---- Productos con stock propio en FUDO (bebidas y otros que se venden tal cual, no como
//      receta armada con ingredientes — ej: una gaseosa cerrada). Se cachea 10 minutos,
//      igual que ingredientes. NOTA: esto es la API GENERAL de FUDO (v1alpha1, fudoApiFetch)
//      — no confundir con getFudoProductos() más abajo, que es el catálogo de venta al
//      cliente para pedidos (API de pedidos/POS, fudoFetch, otra cosa completamente distinta).
let fudoProductosStockCache = null;
let fudoProductosStockCacheEn = 0;

async function getFudoProductosConStock(forzarActualizacion = false) {
  if (!forzarActualizacion && fudoProductosStockCache && Date.now() - fudoProductosStockCacheEn < 10 * 60 * 1000) {
    return fudoProductosStockCache;
  }
  const data = await fudoApiFetch("/products?page[size]=500");
  if (data && Array.isArray(data.data)) {
    fudoProductosStockCache = data.data.map((p) => ({
      id: p.id,
      nombre: p.attributes.name,
      costo: p.attributes.cost,
      stock: p.attributes.stock,
      minStock: p.attributes.minStock,
      stockControl: p.attributes.stockControl,
    }));
    fudoProductosStockCacheEn = Date.now();
    console.log(`Productos (stock) de FUDO actualizados: ${fudoProductosStockCache.length} producto(s).`);
    return fudoProductosStockCache;
  }
  return fudoProductosStockCache || [];
}

// Actualiza un producto (stock/costo/etc). OJO: igual que con proveedores, la ruta sigue el
// mismo patrón que "Update ingredient" (PATCH /products/{id}) pero no la vimos confirmada
// en la documentación — si falla, revisar el log de Railway.
async function actualizarProductoFudo(id, cambios) {
  const body = { data: { id: String(id), type: "Product", attributes: cambios } };
  const data = await fudoApiFetch(`/products/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  if (data && data.data) fudoProductosStockCache = null;
  return data ? data.data : null;
}

// Suma stock comprado a un PRODUCTO (no ingrediente) — misma lógica que
// sumarStockIngrediente pero para bebidas/productos con stock propio.
async function sumarStockProducto(id, cantidadComprada, nuevoCosto = null) {
  const productos = await getFudoProductosConStock();
  const producto = productos.find((p) => String(p.id) === String(id));
  if (!producto) throw new Error(`Producto ${id} no encontrado en FUDO`);
  const nuevoStock = (producto.stock || 0) + cantidadComprada;
  const cambios = { stock: nuevoStock };
  if (nuevoCosto !== null) cambios.cost = nuevoCosto;
  return actualizarProductoFudo(id, cambios);
}

// ---- Medios de pago de FUDO (se cachea 30 minutos) ----
let fudoPaymentMethodsCache = null;
let fudoPaymentMethodsCacheEn = 0;

async function getFudoPaymentMethods() {
  if (fudoPaymentMethodsCache && Date.now() - fudoPaymentMethodsCacheEn < 30 * 60 * 1000) {
    return fudoPaymentMethodsCache;
  }
  const data = await fudoApiFetch("/payment-methods");
  if (data && Array.isArray(data.data)) {
    fudoPaymentMethodsCache = data.data.map((pm) => ({
      id: pm.id,
      nombre: pm.attributes.name,
      activo: pm.attributes.active,
      code: pm.attributes.code,
      forExpenses: pm.attributes.forExpenses,
      forSales: pm.attributes.forSales,
    }));
    fudoPaymentMethodsCacheEn = Date.now();
    console.log(`Medios de pago de FUDO actualizados: ${fudoPaymentMethodsCache.length} medio(s).`);
    return fudoPaymentMethodsCache;
  }
  return fudoPaymentMethodsCache || [];
}

// Busca el id de un medio de pago por nombre (ej: "efectivo", "mercado") en vez de
// depender de un id fijo hardcodeado.
async function getFudoPaymentMethodId(nombreBuscado) {
  const metodos = await getFudoPaymentMethods();
  const encontrado = metodos.find((m) =>
    (m.nombre || "").toLowerCase().includes(nombreBuscado.toLowerCase())
  );
  if (!encontrado) throw new Error(`Medio de pago "${nombreBuscado}" no encontrado en FUDO`);
  return encontrado.id;
}

// Los gastos de proveedores en Chaparrita se pagan de tres formas: efectivo, Mercadopago,
// o quedan a cuenta corriente (fiado, se paga después) — este helper mapea cómo puede venir
// dicho eso en una factura leída por foto (o escrito por el usuario) al medio de pago real
// de FUDO, por code (más estable que por nombre exacto).
const FUDO_ALIAS_MEDIO_PAGO = {
  efectivo: "cash",
  cash: "cash",
  mercadopago: "mercadopago normal",
  "mercado pago": "mercadopago normal",
  mp: "mercadopago normal",
  "cuenta corriente": "house-account",
  "cta cte": "house-account",
  "cta. cte.": "house-account",
  fiado: "house-account",
  "a cuenta": "house-account",
};

async function getFudoPaymentMethodIdPorAlias(textoLibre) {
  const clave = (textoLibre || "").toLowerCase().trim();
  const code = FUDO_ALIAS_MEDIO_PAGO[clave];
  const metodos = await getFudoPaymentMethods();
  const encontrado = code
    ? metodos.find((m) => (m.code || "").toLowerCase() === code)
    : metodos.find((m) => (m.nombre || "").toLowerCase().includes(clave));
  if (!encontrado) throw new Error(`Medio de pago "${textoLibre}" no encontrado en FUDO`);
  return encontrado.id;
}

// ---- Crear gasto en FUDO (factura de proveedor) ----
// Confirmado con gastos reales ya cargados en la cuenta: la caja (cashRegister) es
// siempre la misma ("Principal", id 1), y expenseCategory / receiptType / commercialDocument
// casi nunca se usan en la práctica (vienen null en los gastos existentes) — por eso acá son
// opcionales, se mandan solo si se pasan explícitamente.
const FUDO_CASH_REGISTER_ID = "1"; // "Principal" — confirmado con gastos reales de la cuenta

// IMPORTANTE — useInCashCount cuando el medio de pago es Efectivo:
// el efectivo puede salir de la caja física principal de Chaparrita (SÍ entra al arqueo,
// useInCashCount: true) o de la reserva personal de Tuti (NO entra al arqueo,
// useInCashCount: false). Por eso NO tiene un valor por defecto acá abajo — hay que decidirlo
// explícitamente cada vez que se llama a esta función, para no cargar mal un gasto por error.
async function crearGastoFudo({
  amount,
  date,
  providerId,
  paymentMethodId,
  useInCashCount,
  description = "",
  receiptNumber = "",
  paymentDate = null,
  dueDate = null,
  expenseCategoryId = null,
  receiptTypeId = null,
}) {
  if (useInCashCount !== true && useInCashCount !== false) {
    throw new Error(
      "crearGastoFudo: falta indicar useInCashCount (true/false). Si el pago fue en Efectivo, " +
        "definir si salió de la caja física principal de Chaparrita (true, entra al arqueo) o de " +
        "la reserva personal (false, no entra al arqueo)."
    );
  }
  const relationships = {
    provider: { data: { id: String(providerId), type: "Provider" } },
    paymentMethod: { data: { id: String(paymentMethodId), type: "PaymentMethod" } },
    cashRegister: { data: { id: FUDO_CASH_REGISTER_ID, type: "CashRegister" } },
  };
  if (expenseCategoryId) {
    relationships.expenseCategory = { data: { id: String(expenseCategoryId), type: "ExpenseCategory" } };
  }
  if (receiptTypeId) {
    relationships.receiptType = { data: { id: String(receiptTypeId), type: "ReceiptType" } };
  }

  const body = {
    data: {
      type: "Expense",
      attributes: {
        amount,
        date,
        useInCashCount,
        receiptNumber,
        description,
        paymentDate: paymentDate || date,
        dueDate: dueDate || date,
      },
      relationships,
    },
  };

  const data = await fudoApiFetch("/expenses", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data ? data.data : null;
}

// RUTA TEMPORAL DE PRUEBA — para ver un gasto real de FUDO con cashRegister, receiptType
// y commercialDocument incluidos, y así terminar de armar "Create expense". Borrar cuando
// ya no haga falta.
app.get("/debug/fudo-expenses", async (req, res) => {
  try {
    const data = await fudoApiFetch(
      "/expenses?include=cashRegister,commercialDocument,expenseCategory,provider,paymentMethod,receiptType" +
        "&fields[expenseCategory]=name&fields[cashRegister]=name&fields[commercialDocument]=docUrl,taxes" +
        "&fields[paymentMethod]=name,code&fields[provider]=name&fields[receiptType]=name" +
        "&sort=-id&page[size]=20"
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// RUTA TEMPORAL DE PRUEBA — para ver qué tiene guardado el servidor AHORA MISMO en
// config.cumpleaños.paquetes (y de paso confirmar la ruta real de config.json en disco).
// Borrar cuando ya no haga falta.
app.get("/debug/config-paquetes", (req, res) => {
  try {
    const config = loadConfig();
    res.json({
      configPath: CONFIG_PATH,
      paquetes: config["cumpleaños"] ? config["cumpleaños"].paquetes : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== Integración con FUDO — pedidos (POS) ====================
// Documentación: https://dev.fu.do/integrations-api/#overview
const FUDO_API_BASE = "https://integrations.fu.do/fudo";

let fudoToken = null;
let fudoTokenExpiraEn = 0; // timestamp en ms

async function getFudoToken() {
  if (fudoToken && Date.now() < fudoTokenExpiraEn) {
    return fudoToken;
  }
  if (!FUDO_CLIENT_ID || !FUDO_CLIENT_SECRET) {
    console.error("Faltan FUDO_CLIENT_ID / FUDO_CLIENT_SECRET en las variables de entorno de Railway.");
    return null;
  }
  try {
    const response = await fetch(`${FUDO_API_BASE}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: (FUDO_CLIENT_ID || "").trim(), clientSecret: (FUDO_CLIENT_SECRET || "").trim() }),
    });
    const data = await response.json();
    if (!response.ok || !data.token) {
      console.error("Error obteniendo token de FUDO:", JSON.stringify(data));
      return null;
    }
    fudoToken = data.token;
    // El token dura 24hs — lo renovamos un poco antes (23hs) para no arriesgarnos al límite.
    fudoTokenExpiraEn = Date.now() + 23 * 60 * 60 * 1000;
    console.log("Token de FUDO renovado correctamente.");
    return fudoToken;
  } catch (err) {
    console.error("Error de red obteniendo token de FUDO:", err);
    return null;
  }
}

async function fudoFetch(rutaRelativa, options = {}) {
  const token = await getFudoToken();
  if (!token) return null;
  try {
    const response = await fetch(`${FUDO_API_BASE}${rutaRelativa}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Fudo-External-App-Authorization": `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(`Error en FUDO (${rutaRelativa}):`, response.status, JSON.stringify(data));
      return null;
    }
    return data;
  } catch (err) {
    console.error(`Error de red llamando a FUDO (${rutaRelativa}):`, err);
    return null;
  }
}

// ---- Catálogo de productos de FUDO (se cachea 30 minutos, para no pedirlo en cada pedido) ----
let fudoProductosCache = null;
let fudoProductosCacheEn = 0;

async function getFudoProductos() {
  if (fudoProductosCache && Date.now() - fudoProductosCacheEn < 30 * 60 * 1000) {
    return fudoProductosCache;
  }
  const data = await fudoFetch("/products");
  if (data && Array.isArray(data.products)) {
    fudoProductosCache = data.products.filter((p) => p.active !== false);
    fudoProductosCacheEn = Date.now();
    console.log(`Catálogo de FUDO actualizado: ${fudoProductosCache.length} producto(s) activos.`);
    return fudoProductosCache;
  }
  return fudoProductosCache || [];
}

// Llamada aparte a Claude para "traducir" los ítems que pidió el cliente (texto libre) a
// los productos reales de FUDO con su ID exacto — la API de FUDO necesita el id numérico
// de cada producto, no el nombre en texto.
// ---- Lectura de facturas de proveedores (foto/PDF -> datos estructurados) ----
const FACTURA_SYSTEM_PROMPT = `Sos un asistente que lee facturas o remitos de proveedores para un restaurante bar mexicano en Formosa, Argentina, a partir de una foto o PDF. Tu trabajo es extraer los datos reales de la factura, sin inventar nada que no se vea con claridad.

Prestá especial atención al CUIT del proveedor emisor (no al de Chaparrita, que es quien recibe) — suele estar cerca del nombre/razón social, en el encabezado. Es importante porque algunos proveedores tienen más de una razón social (ej: una mayorista y otra minorista con el mismo nombre comercial), y el CUIT es lo único que las distingue con certeza.

Respondé ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown), con esta forma exacta:
{"proveedor": "nombre o razón social del proveedor tal como figura en la factura, si se ve", "cuit": "CUIT del proveedor emisor, solo números y guiones, si se ve", "fecha": "DD-MM-YYYY si se ve", "numeroFactura": "si se ve", "items": [{"producto": "nombre tal como aparece", "cantidad": 10, "costoUnitario": 500, "subtotal": 5000}], "total": 5000, "advertencia": "si algo no se entiende bien o falta, contalo acá; si no, dejalo vacío"}`;

async function leerFacturaConClaude(base64, mimeType) {
  try {
    const contentBlock = mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } };
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
        system: FACTURA_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [contentBlock, { type: "text", text: "Leé esta factura/remito." }] }],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Error de la API de Claude al leer factura:", data);
      return null;
    }
    const textoRespuesta = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    const jsonMatch = textoRespuesta.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("Error leyendo factura con Claude:", err);
    return null;
  }
}

// Arma el texto legible del resumen de la factura, para mostrárselo a quien la mandó y
// pedirle que confirme antes de cargar nada.
function construirResumenFactura(datos) {
  let texto = `🧾 *Factura leída*\n`;
  if (datos.proveedor) texto += `Proveedor: ${datos.proveedor}\n`;
  if (datos.cuit) texto += `CUIT: ${datos.cuit}\n`;
  if (datos.fecha) texto += `Fecha: ${datos.fecha}\n`;
  if (datos.numeroFactura) texto += `N° de factura: ${datos.numeroFactura}\n`;
  texto += `\nÍtems:\n`;
  (datos.items || []).forEach((it) => {
    texto += `• ${it.cantidad || "?"} ${it.producto} — $${it.costoUnitario || "?"} c/u`;
    if (it.subtotal) texto += ` = $${it.subtotal}`;
    texto += `\n`;
  });
  if (datos.total) texto += `\n*Total: $${datos.total}*\n`;
  if (datos.advertencia) texto += `\n⚠️ ${datos.advertencia}\n`;
  texto += `\n¿Está bien así? Elegí abajo cómo se pagó para cargarla en FUDO, o escribime qué corregir si algo está mal.`;
  return texto;
}

// Interpreta la respuesta del staff/dueño a la confirmación de una factura: si confirma,
// con qué medio de pago, y si ese pago mueve la caja física principal (useInCashCount).
// Devuelve null si el texto no menciona ningún medio de pago reconocible (en ese caso hay
// que pedirle que aclare, en vez de asumir algo).
function interpretarConfirmacionFactura(texto) {
  const t = (texto || "").toLowerCase();

  // BUGFIX: antes exigíamos un "sí"/"dale"/"ok" ANTES de mirar el medio de pago — pero el
  // resumen le pide directamente "contestame con cómo se pagó", así que contestar eso YA es
  // la confirmación. Si contestaba solo "efectivo caja" (sin decir "sí" antes), se
  // interpretaba como rechazo y nunca se cargaba nada. Ahora primero buscamos el medio de
  // pago (eso alcanza para confirmar), y recién si no menciona ninguno miramos si está
  // pidiendo corregir algo.
  if (t.includes("reserva")) {
    return { confirma: true, medioPago: "efectivo", useInCashCount: false };
  }
  if (t.includes("caja")) {
    return { confirma: true, medioPago: "efectivo", useInCashCount: true };
  }
  if (t.includes("mercado") || /\bmp\b/.test(t)) {
    return { confirma: true, medioPago: "mercadopago", useInCashCount: false };
  }
  if (t.includes("cuenta corriente") || t.includes("cta cte") || t.includes("cta. cte") || t.includes("fiado")) {
    return { confirma: true, medioPago: "cuenta corriente", useInCashCount: false };
  }
  if (t.includes("efectivo")) {
    // Dijo "efectivo" pero no aclaró caja o reserva — no hay que asumir, se le pide que aclare.
    return { confirma: true, medioPago: null, useInCashCount: null, faltaAclararEfectivo: true };
  }

  // No mencionó ningún medio de pago. ¿Está pidiendo corregir/rechazar la factura?
  const rechazaExplicitamente = /\b(no|mal|corregir|corrig[ií]|cambiar|est[aá] mal)\b/.test(t);
  if (rechazaExplicitamente) {
    return { confirma: false };
  }

  // Contestó algo (un "sí" suelto, o cualquier otra cosa) pero sin decir el medio de pago —
  // no descartamos la factura, le pedimos que aclare cómo se pagó.
  return { confirma: true, medioPago: null, useInCashCount: null };
}

// Convierte "DD-MM-YYYY" (formato que devuelve leerFacturaConClaude) a "YYYY-MM-DD"
// (formato que pide la API de FUDO). Si no matchea ese patrón, devuelve la fecha de hoy.
function fechaFacturaAFormatoFudo(fechaTexto) {
  const m = (fechaTexto || "").match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return new Date().toISOString().slice(0, 10);
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// Empareja el nombre de proveedor leído en la factura con el proveedor real en FUDO
// (comparación simple, insensible a mayúsculas/tildes, por inclusión en cualquier sentido).
function matchearProveedorFudo(nombreLeido, proveedoresFudo) {
  if (!nombreLeido) return null;
  const normalizar = (s) =>
    (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  const buscado = normalizar(nombreLeido);
  return (
    proveedoresFudo.find((p) => {
      const nombre = normalizar(p.nombre);
      return nombre.includes(buscado) || buscado.includes(nombre);
    }) || null
  );
}

// Empareja los ítems de la factura (texto libre, como los escribió/leyó la IA) con el
// catálogo real de FUDO — que son DOS catálogos distintos: ingredientes (para recetas
// armadas) y productos (cosas que se venden tal cual, como una gaseosa cerrada — las bebidas
// suelen estar acá). Le pasamos los dos juntos a Claude para que elija el correcto y no
// arriesgue a matchear el mismo ítem dos veces.
const FUDO_MATCH_INGREDIENTES_SYSTEM_PROMPT = `Sos un asistente que empareja los ítems de una factura de un proveedor con el catálogo real de un restaurante (en su sistema FUDO). Te paso la lista de ítems de la factura (nombre tal como aparece impreso, puede tener abreviaturas o mayúsculas raras) y DOS catálogos reales con sus IDs: uno de INGREDIENTES (insumos que se usan en recetas) y otro de PRODUCTOS (cosas que se venden/compran tal cual, como bebidas cerradas).

Para cada ítem de la factura, buscá en AMBOS catálogos y encontrá la mejor coincidencia por nombre (aunque no sea idéntica, ej. "COCA COLA 1.5L" puede corresponder a "Coca Cola 1,5L"). Decidí en cuál de los dos catálogos está — un mismo ítem NUNCA está en los dos a la vez. Si no hay ninguna coincidencia razonable en ninguno de los dos, marcalo como no encontrado (no inventes un ID falso).

Respondé ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown), con esta forma exacta:
{"items": [{"tipo": "ingredient", "id": "12", "cantidad": 10, "costoUnitario": 500, "encontrado": true}, {"tipo": "product", "id": "7", "cantidad": 6, "costoUnitario": 800, "encontrado": true}, {"encontrado": false, "textoOriginal": "algo que no está en ninguno de los dos catálogos"}]}`;

async function matchearIngredientesFactura(itemsFactura, ingredientesFudo, productosFudo) {
  try {
    const catalogoIngredientesTexto = ingredientesFudo.map((i) => `id:${i.id} - ${i.nombre}`).join("\n");
    const catalogoProductosTexto = productosFudo.map((p) => `id:${p.id} - ${p.nombre}`).join("\n");
    const itemsTexto = itemsFactura
      .map((it) => `${it.cantidad || "?"} x "${it.producto}" — costo unitario $${it.costoUnitario || "?"}`)
      .join("\n");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", // emparejar nombres contra un catálogo — no hace falta Sonnet acá
        max_tokens: 1500,
        system: FUDO_MATCH_INGREDIENTES_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `CATÁLOGO DE INGREDIENTES:\n${catalogoIngredientesTexto}\n\nCATÁLOGO DE PRODUCTOS (bebidas y afines):\n${catalogoProductosTexto}\n\nÍTEMS DE LA FACTURA:\n${itemsTexto}`,
          },
        ],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Error de la API de Claude al matchear ítems de factura:", data);
      return [];
    }
    const textoRespuesta = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    const jsonMatch = textoRespuesta.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch (err) {
    console.error("Error matcheando ítems de factura con Claude:", err);
    return [];
  }
}

// Carga una factura de proveedor ya confirmada en FUDO: matchea el proveedor y los
// ingredientes con el catálogo real, suma el stock comprado, y crea el gasto con el medio
// de pago y el flag de arqueo (useInCashCount) que confirmó el staff/dueño al aprobarla.
// Busca en config.facturaProveedorCategoria (mapa proveedor -> nombre de categoría, editable
// desde /admin) si hay una categoría fija para este proveedor, y la resuelve al id real de
// FUDO. Devuelve null si no hay mapeo, o si no se encontró una categoría con ese nombre en
// FUDO — en ese caso el gasto se crea sin categoría (como ya vienen la mayoría hoy).
async function resolverCategoriaFudoPorProveedor(nombreProveedor) {
  try {
    const config = loadConfig();
    const mapa = config.facturaProveedorCategoria || {};
    const nombreNorm = (nombreProveedor || "").toLowerCase();
    const clave = Object.keys(mapa).find(
      (prov) => nombreNorm.includes(prov.toLowerCase()) || prov.toLowerCase().includes(nombreNorm)
    );
    if (!clave) return null;
    const nombreCategoriaDeseada = mapa[clave];
    const categorias = await getFudoCategoriasGasto();
    const encontrada = categorias.find((c) => (c.nombre || "").toLowerCase().includes(nombreCategoriaDeseada.toLowerCase()));
    return encontrada ? encontrada.id : null;
  } catch (err) {
    console.error("Error resolviendo categoría de gasto por proveedor:", err);
    return null;
  }
}

// Carga el gasto de la factura en FUDO. IMPORTANTE: ya NO actualiza el stock acá — eso
// ahora se hace a mano desde /admin (ver aplicarStockDeFactura), eligiendo qué facturas
// corresponde aplicar al stock (insumos de cocina/barra, ej. Alfa Nea, El Tano) y cuáles no
// (verdulería "varios", servicios, etc.), sin necesidad de una lista fija en el código.
async function cargarFacturaEnFudo(datosFactura, medioPagoTexto, useInCashCount) {
  try {
    const proveedorMatch = await matchearOCrearProveedorFudo(datosFactura);
    if (!proveedorMatch) {
      return { ok: false, motivo: `proveedor_no_encontrado: "${datosFactura.proveedor || "(sin nombre)"}"` };
    }

    const paymentMethodId = await getFudoPaymentMethodIdPorAlias(medioPagoTexto);
    const expenseCategoryId = await resolverCategoriaFudoPorProveedor(datosFactura.proveedor);

    const gasto = await crearGastoFudo({
      amount: Number(datosFactura.total) || 0,
      date: fechaFacturaAFormatoFudo(datosFactura.fecha),
      providerId: proveedorMatch.id,
      paymentMethodId,
      useInCashCount,
      expenseCategoryId,
      description: `Factura ${datosFactura.numeroFactura || ""}`.trim(),
      receiptNumber: datosFactura.numeroFactura || "",
    });

    if (!gasto) {
      return { ok: false, motivo: "error_creando_gasto_en_fudo" };
    }

    return { ok: true, gastoId: gasto.id };
  } catch (err) {
    console.error("Error cargando factura en FUDO:", err);
    return { ok: false, motivo: "error_inesperado: " + err.message };
  }
}

// Aplica al stock real de FUDO los ítems de una factura YA cargada — se llama a demanda
// desde /admin (nunca automáticamente al confirmar por WhatsApp). Matchea los ítems de la
// factura con los ingredientes reales y suma lo comprado a cada uno.
async function aplicarStockDeFactura(datosFactura) {
  const [ingredientesFudo, productosFudo] = await Promise.all([getFudoIngredientes(), getFudoProductosConStock()]);
  const itemsMatch = await matchearIngredientesFactura(datosFactura.items || [], ingredientesFudo, productosFudo);
  const aplicados = [];
  const sinMatchear = [];
  for (const item of itemsMatch) {
    if (!item.encontrado) {
      sinMatchear.push(item.textoOriginal || "(ítem sin identificar)");
      continue;
    }
    try {
      if (item.tipo === "product") {
        await sumarStockProducto(item.id, Number(item.cantidad) || 0, item.costoUnitario ?? null);
      } else {
        await sumarStockIngrediente(item.id, Number(item.cantidad) || 0, item.costoUnitario ?? null);
      }
      aplicados.push(item.textoOriginal || item.id);
    } catch (errStock) {
      console.error("Error sumando stock de un ítem de factura:", errStock);
      sinMatchear.push(`${item.textoOriginal || item.id} (error al sumar stock)`);
    }
  }
  return { aplicados, sinMatchear };
}

// ---- Confirmaciones de factura pendientes: telefono -> {datos, creadaEn} ----
const pendingFacturas = new Map();

const FUDO_MATCH_SYSTEM_PROMPT = `Sos un asistente que empareja los ítems de un pedido de un restaurante mexicano con el catálogo real de productos de su sistema (FUDO). Te paso la lista de ítems que pidió el cliente (en texto libre, puede incluir opcionales elegidos entre paréntesis, por ejemplo "2 Tacos de asada (salsa verde, guacamole)") y el catálogo completo de productos, con sus grupos de opcionales si los tienen.

Tu trabajo es, para cada ítem pedido:
- Encontrar el producto que mejor corresponda en el catálogo (por nombre, aunque no sea idéntico) y devolver su ID real, la cantidad pedida, y el precio del catálogo (nunca inventes precios, usá el que aparece en el catálogo).
- Si el cliente eligió opcionales para ese ítem (y el producto tiene grupos de opcionales en el catálogo), emparejarlos también con su producto y grupo real, devolviéndolos en "subitems".

Si un ítem pedido NO tiene ningún producto razonable en el catálogo, marcalo como no encontrado (no inventes un ID falso). Si un opcional mencionado no coincide con ninguna opción real del grupo, simplemente omitilo de "subitems" (no inventes un id falso tampoco).

Respondé ÚNICAMENTE con un JSON válido (sin texto extra, sin bloques de código markdown), con esta forma exacta:
{"items": [{"productId": 12, "quantity": 2, "price": 8500, "encontrado": true, "subitems": [{"productId": 20, "productGroupId": 3, "quantity": 1, "price": 0}]}, {"encontrado": false, "textoOriginal": "algo que no está en el catálogo"}]}`;

async function matchearItemsConFudo(itemsTexto, productosFudo) {
  try {
    const productosPorId = {};
    productosFudo.forEach((p) => {
      productosPorId[p.id] = p;
    });
    const catalogoTexto = productosFudo
      .map((p) => {
        let linea = `id:${p.id} - ${p.name} - $${p.price}`;
        if (Array.isArray(p.productGroups) && p.productGroups.length > 0) {
          const grupos = p.productGroups.map((g) => {
            const opciones = (g.productGroupProducts || [])
              .map((opt) => {
                const prodOpt = productosPorId[opt.productId];
                return `id:${opt.productId} ${prodOpt ? prodOpt.name : "?"} ($${opt.price || 0})`;
              })
              .join(", ");
            return `grupo id:${g.id} (elegir ${g.minQuantity}-${g.maxQuantity}): ${opciones}`;
          });
          linea += ` [${grupos.join(" | ")}]`;
        }
        return linea;
      })
      .join("\n");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", // emparejar el pedido con el catálogo — no hace falta Sonnet acá
        max_tokens: 1500,
        system: FUDO_MATCH_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Ítems pedidos:\n${itemsTexto}\n\nCatálogo de FUDO:\n${catalogoTexto}` }],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Error de la API de Claude al matchear ítems con FUDO:", data);
      return [];
    }
    const textoRespuesta = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    const jsonMatch = textoRespuesta.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.items || [];
  } catch (err) {
    console.error("Error matcheando ítems con FUDO:", err);
    return [];
  }
}

// Crea el pedido en FUDO. Devuelve {ok:true, fudoOrderId} si salió bien, o {ok:false,
// motivo} si no — en ese caso seguimos con el flujo manual de siempre, como respaldo,
// nunca se pierde el pedido por un problema de la integración.
async function crearPedidoEnFudo({ itemsTexto, nombreCliente, telefonoCliente, tipo, direccion, costoEnvio, medioPagoId, totalAprox }) {
  const productosFudo = await getFudoProductos();
  if (productosFudo.length === 0) {
    console.log("No se pudo obtener el catálogo de FUDO — se omite la creación automática del pedido.");
    return { ok: false, motivo: "sin_catalogo" };
  }

  const itemsMatcheados = await matchearItemsConFudo(itemsTexto, productosFudo);
  const itemsEncontrados = itemsMatcheados.filter((i) => i.encontrado && i.productId);
  const itemsNoEncontrados = itemsMatcheados.filter((i) => !i.encontrado);

  if (itemsEncontrados.length === 0) {
    console.log("No se pudo emparejar ningún ítem del pedido con el catálogo de FUDO.");
    return { ok: false, motivo: "sin_matches" };
  }

  const orderBody = {
    order: {
      comment: `Pedido vía WhatsApp (Chaparrita IA) — Cliente: ${nombreCliente || "sin nombre"}`,
      customer: { name: nombreCliente || "Cliente WhatsApp", phone: telefonoCliente || "" },
      items: itemsEncontrados.map((i) => ({
        quantity: i.quantity || 1,
        price: i.price || 0,
        product: { id: i.productId },
        ...(Array.isArray(i.subitems) && i.subitems.length > 0
          ? { subitems: i.subitems.map((s) => ({ productId: s.productId, productGroupId: s.productGroupId, quantity: s.quantity || 1, price: s.price || 0 })) }
          : {}),
      })),
      type: tipo === "delivery" ? "delivery" : "pickup",
      people: 1,
    },
  };

  if (tipo === "delivery") {
    orderBody.order.typeOptions = { address: direccion || "" };
    if (costoEnvio) orderBody.order.shippingCost = Number(costoEnvio);
  }
  if (medioPagoId) {
    orderBody.order.payment = { paymentMethod: { id: Number(medioPagoId) }, total: Number(totalAprox) || 0 };
  }

  const resultado = await fudoFetch("/orders", { method: "POST", body: JSON.stringify(orderBody) });

  if (resultado && resultado.order && resultado.order.id) {
    console.log(`Pedido creado en FUDO automáticamente — ID: ${resultado.order.id}.`);
    return { ok: true, fudoOrderId: resultado.order.id, itemsNoEncontrados };
  }
  console.log("No se pudo crear el pedido en FUDO (ver error arriba) — se sigue con el flujo manual.");
  return { ok: false, motivo: "error_api", itemsNoEncontrados };
}

// ---- Webhook de FUDO: nos avisa cuando cambia el estado de un pedido ----
function validarFirmaFudo(rawBody, firmaRecibida) {
  if (!FUDO_CLIENT_SECRET || !firmaRecibida || !rawBody) return false;
  const esperada = crypto.createHmac("sha256", FUDO_CLIENT_SECRET).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(firmaRecibida));
  } catch {
    return false; // longitudes distintas u otro problema — tratamos como inválida
  }
}

app.post("/webhook/fudo", async (req, res) => {
  try {
    const firma = req.headers["fudo-signature"];
    if (!validarFirmaFudo(req.rawBody, firma)) {
      console.error("Webhook de FUDO con firma inválida — se ignora (posible intento falso).");
      return res.status(401).json({ error: "Firma inválida" });
    }

    const evento = req.body || {};
    // Log completo (no recortado) — la primera vez que llegue un webhook real, esto nos
    // va a confirmar los nombres exactos de los campos que usa FUDO en cada evento.
    console.log("Webhook de FUDO recibido:", JSON.stringify(evento));

    // Buscamos el tipo de evento y el id del pedido en los lugares más probables del
    // payload — como todavía no vimos un ejemplo real, cubrimos varias posibilidades.
    // Confirmado con un webhook real: FUDO manda {"name":"ORDER-REJECTED", "resources":
    // {"order":{"id":1387}}} — dejamos las otras variantes como respaldo, por si acaso.
    const tipoEvento = evento.name || evento.event || evento.type || evento.eventType || "";
    const fudoOrderId =
      (evento.resources && evento.resources.order && evento.resources.order.id) ||
      (evento.order && evento.order.id) ||
      evento.orderId ||
      evento.id;

    const MENSAJES_POR_EVENTO = {
      "ORDER-CONFIRMED": "¡Tu pedido fue confirmado por el local! 🎉 Ya lo estamos preparando.",
      "ORDER-REJECTED": "Uy, tu pedido fue rechazado por el local. Ya nos estamos comunicando para resolverlo, disculpá las molestias 🙏",
      "ORDER-READY-TO-DELIVER": "¡Tu pedido ya está listo! 📦 En breve sale para la entrega.",
      "ORDER-DELIVERY-SENT": "¡Tu pedido ya salió en camino! 🛵",
      "ORDER-CLOSED": "¡Tu pedido fue entregado, que lo disfrutes! 🌮🎉",
    };

    if (fudoOrderId) {
      const ordenesFudo = loadFudoOrdenes();
      const orden = ordenesFudo[fudoOrderId];
      if (orden && orden.telefono) {
        const mensaje = MENSAJES_POR_EVENTO[tipoEvento];
        if (mensaje) {
          await sendWhatsappText(orden.telefono, mensaje);
          agregarMensajeInbox(orden.telefono, "chaparrita", mensaje);
          console.log(`Aviso de estado del pedido FUDO #${fudoOrderId} (${tipoEvento}) enviado a ${orden.telefono}.`);
        } else {
          console.log(`Evento de FUDO no reconocido ("${tipoEvento}") para el pedido #${fudoOrderId} — revisar el nombre exacto del campo de evento en el log de arriba.`);
        }
      } else {
        console.log(`Webhook de FUDO para el pedido #${fudoOrderId} (evento: ${tipoEvento}), pero no tenemos guardado el teléfono de ese cliente.`);
      }
    } else {
      console.log("Webhook de FUDO sin id de pedido reconocible — revisar el nombre exacto del campo en el log de arriba.");
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error procesando webhook de FUDO:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

app.listen(PORT, () => console.log(`Chaparrita backend escuchando en el puerto ${PORT}`));
