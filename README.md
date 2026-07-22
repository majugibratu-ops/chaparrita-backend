# Chaparrita — Backend del agente de ventas IA

Backend real (Node.js + Express) que recibe mensajes de WhatsApp, los procesa
con la API de Claude usando toda la lógica de negocio que armamos (reservas,
promos de cumpleaños, delivery, clima, deportes, quejas) y responde por WhatsApp.

## 1) Qué necesitás tener antes de arrancar

1. **Cuenta en Railway** (railway.app) — para hostear este backend.
2. **Cuenta de Meta Developers** (developers.facebook.com) con acceso a
   **WhatsApp Business Platform (Cloud API)**, y el número de Chaparrita
   agregado ahí. Esto requiere verificar el negocio ante Meta — puede tardar
   uno o varios días, conviene arrancarlo ya.
3. **API Key de Anthropic** (console.anthropic.com → API Keys). Esto tiene
   costo por uso (aparte de tu plan de Claude.ai).

Si preferís no lidiar directo con Meta, alternativas más simples de configurar:
**360dialog** o **Twilio** (son intermediarios de WhatsApp Business API, cobran
un poco más pero el setup es más rápido). El código de este backend está
armado para Meta Cloud API directo; si elegís 360dialog/Twilio avisame y
adapto los endpoints de envío/recepción — la lógica del agente (systemPrompt.js)
no cambia.

## 2) Configurar los datos reales del negocio

Editá `config.json` con:
- Horarios reales de atención
- Link real de la tienda online
- Teléfonos reales de Valentina, Marcelo, y el ID del grupo "Reservas Chaparrita"
- Precios/promos actualizados si cambiaron

No hace falta tocar `server.js` ni `systemPrompt.js` para estos cambios.

## 3) Deploy en Railway

1. Subí esta carpeta a un repositorio de GitHub (o conectá Railway directo a
   una carpeta local con la CLI de Railway: `railway login` → `railway init` → `railway up`).
2. En Railway, creá un nuevo proyecto → "Deploy from GitHub repo" (o `railway up`
   si usás la CLI).
3. En la pestaña **Variables** del proyecto en Railway, cargá las variables de
   `.env.example` con los valores reales:
   - `ANTHROPIC_API_KEY`
   - `WHATSAPP_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_VERIFY_TOKEN` (inventás cualquier string, lo vas a volver a usar en el paso 4)
4. Railway te va a dar una URL pública (algo como `https://chaparrita-backend-production.up.railway.app`).

## 4) Conectar el webhook en Meta

1. En developers.facebook.com, en tu app de WhatsApp → **Configuration** → **Webhook**.
2. Callback URL: `https://TU-URL-DE-RAILWAY/webhook`
3. Verify Token: el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`.
4. Suscribite al campo `messages`.

Listo — a partir de ahí, cualquier mensaje que le escriban al número de
WhatsApp de Chaparrita va a llegar a este backend, y el agente va a responder
solo, con toda la lógica que probamos en el artifact.

## 5) Cómo funciona por dentro (resumen)

- `server.js`: recibe el webhook de WhatsApp, arma el historial de la
  conversación por número de teléfono (en memoria — ver punto de mejora abajo),
  llama a Claude, y devuelve la respuesta por WhatsApp.
- `systemPrompt.js`: arma las instrucciones del agente (tono, reglas de
  negocio) a partir de `config.json`. Es exactamente la misma lógica que
  probamos en el artifact de Claude.ai.
- Cuando el cliente confirma una reserva, el agente devuelve una marca
  interna (`[[RESERVA_CONFIRMADA]]`) que el backend detecta para reenviar
  automáticamente el resumen al grupo real de WhatsApp "Reservas Chaparrita" —
  el cliente nunca ve esa marca.
- Si el cliente manda una imagen (ej. comprobante de seña), el backend la
  descarga de WhatsApp y se la pasa a Claude, que puede "leerla" (usa visión).
- El chequeo de clima y de partidos usa búsqueda web real (herramienta
  incluida en la llamada a la API).

## 6) Pendientes para dejarlo 100% productivo

- **Persistencia real**: hoy el historial de conversación vive en memoria del
  servidor (`Map`) — si el proceso se reinicia, se pierde. Para producción
  conviene sumar una base de datos (Railway ofrece Postgres con un clic) y
  guardar ahí conversaciones, pedidos, reservas y el libro de quejas.
- **Panel de administración con los mismos controles del artifact** (promos
  por día, productos agotados, equipo, delivery) pero editando `config.json`
  en la base de datos en vez de en el prototipo. Se puede reusar casi todo el
  diseño de React que ya armamos.
- **Verificación de firma del webhook** (Meta manda un header `X-Hub-Signature-256`)
  para asegurarte de que los mensajes vengan realmente de Meta.
- **Conectar Instagram DM** (mismo patrón, otro webhook de Meta).

## 7) Probarlo local antes de subirlo

```bash
npm install
cp .env.example .env   # completá con tus datos reales
npm start
```

Para probar el webhook desde tu compu antes de tener Railway, podés usar
`ngrok http 3000` y usar esa URL de ngrok como Callback URL en Meta
temporalmente.
