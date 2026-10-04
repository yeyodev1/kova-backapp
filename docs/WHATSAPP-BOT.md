# Bot de WhatsApp de Kova (BuilderBot Cloud + Gemini)

Mismo esquema que el bot de Megaprinter: **el backend decide cada paso** y BuilderBot solo enruta el
mensaje y envía `{message}` al cliente. `/brain` decide el flujo sin IA (milisegundos); los flujos destino
procesan el turno completo. Gemini (`GEMINI_MODEL`, por defecto `gemini-2.5-flash`) extrae datos de frases
libres, responde preguntas usando solo el catálogo real y lee comprobantes; el backend valida todo lo que
devuelve (ids del catálogo, cédula, correo, precios) y si Gemini falla o tarda sigue con reglas.

Código: `src/services/whatsappBot/*` (máquina de estados pura), `src/services/whatsappBot.service.ts`
(sesión, candado, bitácora), `src/services/botAdmin.service.ts` (panel), `src/routes/whatsappBot.routes.ts`.

## Personalidad

- Se presenta como **el bot de Kova** 🤖 (`BOT_NAME`, por defecto "Kova"; con otro nombre dice
  "*Luna* 🤖, el bot de *Kova*"). Cercano, tutea, emojis con moderación.
- Signos de pregunta y exclamación **solo al final** ("Cómo prefieres pagar?"): un filtro final quita "¿" y "¡"
  de todo lo que sale, incluidas las respuestas de Gemini.
- **Voz con IA** (`BOT_AI_VOICE`, `on` por defecto): el router decide QUÉ decir y Gemini lo reescribe para no
  repetir los últimos 3 mensajes. No puede cambiar datos: las líneas de listas, viñetas, cuenta bancaria y resumen
  salen idénticas; montos, `KV-`, links, números largos, correos, palabras en *negrita* y la palabra "bot" se
  conservan; tampoco puede **agregar** datos nuevos (un `KV-` o monto que no estaba) ni decir que es una persona.
  Si la IA cambia algo, tarda más de 8 s o falla, se envía el texto original. El saludo, "sí, soy un bot" y la
  confirmación de "no me escribas" van siempre tal cual. `BOT_AI_VOICE=off` la apaga.

## Políticas de Meta (WhatsApp Business) y cómo se cumplen

| Regla de Meta | Cómo la cumple el bot |
|---|---|
| Desde el 15-ene-2026 no se permiten chatbots de **propósito general** | Gemini solo responde sobre el catálogo y los pedidos de Kova. Lo demás (tareas, recetas, poemas, política…) se clasifica `fuera_de_tema` y el bot redirige (`R8:fuera_de_tema`). |
| Escalamiento a una persona | "asesor", reclamo, queja, garantía, devolución, reembolso → `route = human` → flujo 🙋 Asesor humano + Silenciar 60 min. Queda un `botEvent` `human_request` visible en el panel. |
| Responder rápido | `/brain` decide sin IA (< 100 ms). Los flujos usan Gemini con timeout de 8–15 s; si falla, siguen con reglas. |
| Transparencia: decir que es un bot | Se presenta como "el bot de Kova" 🤖. "eres un bot?", "hablo con una persona?" → *"Sí, soy un bot 🤖"* + ofrece *asesor* (`R2:soy_un_bot`). |
| Respetar a quien no quiere mensajes | "no me escribas", "stop", "darme de baja", "no me interesa" → lo confirma y queda `optOut` en la sesión. |
| Mensajes fuera de plantilla solo en la ventana de 24 h que abre el cliente | El bot **solo responde**: un mensaje por turno, nunca escribe primero. No hay envíos salientes ni recordatorios. |

## Flujo de una venta

1. El cliente pregunta ("tienen licuadoras?", "un parlante gris", una foto) → opciones numeradas con precio
   (`$22.90 ~$34.90~`). Solo productos **publicados con stock**.
2. Elige ("1", "la segunda", "sí" con una sola opción, "el gris").
3. **Variante** (productos `VARIABLE`): lista las opciones con stock y su precio. Si dijo la variante en el mismo
   mensaje ("el parlante gris") la toma directo.
4. **Cantidad con ofertas** (`product.offers`): "1, 2 o 3 unidades" con el total y el ahorro de cada una
   (calculado con `checkout.service.buildQuote`, nunca a mano). "quiero 2 licuadoras" salta este paso.
5. Pide lo que falte, en orden:
   - nombre y apellido;
   - celular (solo si WhatsApp oculta el número, sesiones `lid:`). Con número visible se usa el de WhatsApp
     normalizado a `09XXXXXXXX`;
   - **ciudad**, validada contra `Location` (Dropi): "Guayaquil" → Guayas; "Santa Rosa" (varias) → lista para elegir;
     "Pichincha" → pregunta la ciudad dentro de la provincia. Sin ubicaciones cargadas acepta "ciudad, provincia";
   - dirección y referencia ("…, ref: frente al parque" o en un mensaje aparte; "no" la salta);
   - cédula y correo, **opcionales** en una sola pregunta ("no" la salta). La cédula se valida (dígito verificador);
   - forma de pago con el total de cada una (recargos de `settings`):
     **Tarjeta** (el mejor precio, solo si Payphone está configurado), **Transferencia** (+`transferSurcharge`, solo
     si hay `settings.bankAccounts`), **Contra entrega** (+`codSurcharge`, "pagas al recibir"). Con un solo método no
     pregunta;
   - **banco** si hay varias cuentas: muestra solo los nombres y luego manda solo la cuenta elegida.
   El cliente puede mandar todo junto ("soy Carla Mendoza, Guayaquil, Urdesa calle Guayacanes 214, frente a la
   panadería"): con IA se extrae todo; sin IA se va paso a paso.
6. **Resumen** con el total del quote (envío y recargo incluidos) → "sí".
7. Crea el pedido con **`order.service.createOrder`** (`channel: "whatsapp_bot"`; misma validación, stock, ofertas,
   correo y Dropi que la web) y responde:
   - **Tarjeta**: link `PUBLIC_WEB_URL/pagar/<payToken>` (`route: checkoutCard`). Luego "pagado" lo verifica.
   - **Transferencia**: datos de la cuenta elegida, monto exacto y "mándame la foto del comprobante" (`checkoutTransfer`).
   - **Contra entrega**: pedido confirmado, "te contactamos para coordinar la entrega" (`checkoutCod`). Dropi se
     intenta como siempre; si falla queda para el panel.
   El carrito se vacía al crear el pedido: un "sí" repetido nunca crea otro.
8. Al tener teléfono + producto se guarda el **carrito abandonado** (`checkout.service.saveLead`, igual que la web);
   al crear el pedido se marca convertido.

"no" en el resumen → "qué cambiamos?"; "la dirección", "ciudad", "cédula", "forma de pago"… borra ese dato y lo
vuelve a pedir. "cancelar" / "vaciar carrito" vacía el carrito. "reiniciatodo" borra la conversación (pruebas).

## Comprobantes, fotos y pagos

- **Comprobante** (imagen o PDF en `urlTempFile`): se descarga, Gemini mira qué es. Si es comprobante (o PDF, o no
  hay IA) se guarda en el pedido por transferencia pendiente del chat o del teléfono con
  `order.service.attachReceipt` (Cloudinary `kova/receipts`, pedido → `transfer_review`, la misma función que usa
  `POST /orders/:number/receipt`). Gemini lee monto, banco y referencia y queda en el historial del pedido como
  "Lectura automática (no verificada)". Si el monto leído no coincide, el bot avisa al cliente.
  **La IA nunca aprueba un pago**: lo aprueba una persona en el panel (`confirm-transfer`).
- **Foto que no es comprobante**: si es un producto se cruza con el catálogo ("Sí lo tenemos" / "estos se parecen").
  Si hay un pedido esperando comprobante, se lo recuerda.
- Videos y audios: "no puedo verlos/escucharlos, mándame una foto o escríbeme".
- **"pagado" / "ya pagué"** (tarjeta): el bot consulta a Payphone cada `clientTransactionId` del pedido
  (del más nuevo al más viejo). Si uno está aprobado hace la **confirmación obligatoria** con `confirmPayphone`
  (idempotente; sin ella Payphone revierte a los 5 min) y el pedido queda pagado. Si aún no aparece, reenvía el link.
  Rechazado: link para reintentar. Aprobado con monto distinto: pasa a una persona. Un segundo "pagado" responde
  "ya está confirmado".
- **"ya transferí"** con pedido por transferencia: pide la foto del comprobante.

## Consultas de pedido

El bot **siempre** responde desde Mongo en vivo (`deps.findOrders`, sin caché) y solo con pedidos **del teléfono del
chat**. Funciona desde cualquier paso: a mitad de una compra responde el estado y después repite la pregunta pendiente
("Y seguimos con tu compra 🛒 …") sin tocar el carrito.

| El cliente escribe | Qué pasa |
|---|---|
| "cómo va mi pedido", "dónde está mi paquete", "ya me llegó?", "no me ha llegado", "mi pedido de ayer" | Busca por el WhatsApp. Uno: detalle. Varios: lista los **últimos 3** y pregunta cuál ("el 2" o el `KV-`); "de hoy/ayer/anteayer" filtra por día de Ecuador |
| "KV-1007", "kv 1007", "pedido 1007" | Ese pedido si es de este teléfono |
| "mi pedido, cédula 09…" / "…ana@correo.com" | Filtra **dentro** de los pedidos del teléfono por cédula o correo |
| KV-, cédula o correo de **otro** teléfono | "No encuentro… Por seguridad solo te muestro pedidos hechos con este número de WhatsApp" + `/rastrear`. Nunca confirma que exista |
| "cuándo llega?" sin "mi" ni KV-, y sin pedidos | No es consulta: sigue como pregunta normal (tiempos de envío) |
| WhatsApp oculto (`@lid`) | Pide el número `KV-` antes de buscar |

Detalle: estado en lenguaje claro, pago (confirmado / pendiente con tarjeta o transferencia / contra entrega: cuánto
paga al recibir), productos, guía y transportadora si hay, link de rastreo
`https://kovashopper.com/rastrear?number=KV-…&phone=09…`, link de pago si la tarjeta sigue pendiente, y qué sigue.
Si el pedido espera comprobante, el siguiente archivo se guarda en ese pedido (salvo que haya una compra en curso).

`/brain` manda estas consultas (y la respuesta "el 2" a la lista) a `conversation`; `/search-order` también procesa el
turno completo. Decisiones: `R3:consultar_pedido`, `R3:elegir_pedido`, `R3:sin_pedidos`, `R3:pedir_numero_pedido`.

## Incidencias desde el bot

Además del correo al equipo, quedan en Panel → Incidencias (`docs/API.md`, "Incidencias"):

- **Reclamo** (reclamo, queja, garantía, devolución, reembolso, dañado, roto, defectuoso, "llegó mal", "no prende";
  "el link no funciona" no cuenta): decisión `R2:reclamo`, ruta `human`, incidencia `customer_complaint` (alta) con lo
  que escribió y su último pedido (o el `KV-` que mencionó).
- **Pide asesor**: `R2:humano` → `human_request` (media).
- **Error en un turno** (excepción): `bot_error` (media) por teléfono. **Gemini falla 3 veces seguidas**: `bot_error`
  con clave `gemini` (el bot sigue con reglas).
- El mismo problema abierto suma "×N" y guarda cada mensaje nuevo como nota.

## Endpoints

Base: `https://api.kovashopper.com/api/whatsapp-bot`

| Endpoint | Uso |
|---|---|
| `POST /brain` | **Flujo principal.** Solo decide `route`; `message` vacío; `targetEndpoint` = endpoint del flujo destino. |
| `POST /conversation` | Turno completo (charla, búsqueda, datos, pedidos, contra entrega). |
| `GET\|POST /catalog` | Turno completo; sin mensaje, solo el resumen del catálogo. |
| `POST /checkout` | Turno completo (el "sí" que crea el pedido; también fotos y comprobantes). |
| `POST /search-order` | Turno completo (extra). |
| `POST /human` | Turno completo (aviso de que lo atiende una persona; silencia la sesión 60 min). |
| `POST /media` | Fotos, PDF, videos y audios (alias `/transfer-receipt`). |

Todos aceptan cualquier método (`router.all`) y **responden HTTP 200 siempre**: un 4xx/5xx deja al cliente sin
respuesta. Con `WHATSAPP_BOT_SECRET` exigen el header `X-Bot-Token` (si falta, 200 con `success:false` y `message` vacío).

### Body (Body con campos, RAW apagado)

| Campo | Variable BuilderBot | Notas |
|---|---|---|
| `rawMessage` | `{body}` | Texto del cliente. También acepta `body`, `message` o el último mensaje de `history`. Los eventos `_event_media__…` cuentan como "sin texto". |
| `phone` | `{from}` | También `from`. Acepta JID `593…@s.whatsapp.net` (→ `09XXXXXXXX`) y `…@lid` (→ sesión `lid:…`, el bot pide el celular). |
| `urlTempFile` | `{urlTempFile}` | Foto o PDF. Una variable no reemplazada (`{urlTempFile}`) se ignora. |
| `history` | `{history}` | Opcional, recomendado: contexto para la IA (incluye lo que escribió un asesor a mano). El backend guarda además su propio historial por teléfono (30 mensajes, la sesión expira a los 3 días sin mensajes). |

### Respuesta

```json
{
  "success": true,
  "intencion": "conversar | menu | dudas | consultar_pedido | orden_creada | comprobante_recibido",
  "route": "conversation | catalog | confirmOrder | checkoutCard | checkoutTransfer | checkoutCod | awaitingReceipt | receiptReceived | searchOrder | human",
  "message": "texto para el cliente (nunca vacío en los flujos destino)",
  "step": "idle | choosing | variant | quantity | name | phone | city | city_choice | address | reference | extras | payment | bank | confirm | ordered",
  "decision": "R7:orden_creada",
  "readyToCheckout": false,
  "orderNumber": "KV-1007",
  "paymentMethod": "card | transfer | cod | ",
  "paymentLink": "https://kovashopper.com/pagar/…",
  "total": 6280,
  "cart": [{ "productId": "…", "variantId": null, "name": "Parlante (Gris)", "quantity": 2, "price": 3140 }],
  "missingData": ["ciudad", "direccion"],
  "telefonoSoporte": "",
  "targetEndpoint": "/api/whatsapp-bot/brain"
}
```

`total` y `price` en **centavos** (como todo el API de Kova). Las Rules de BuilderBot van por **`route`** de
`/brain`; `decision` es para depurar (qué regla respondió). `/brain` responde la misma forma con `message: ""` y
`route` ∈ `conversation | catalog | checkoutCard | checkoutTransfer | human | silenced`.

## Configurar BuilderBot (6 flujos)

Todos los nodos HTTP: `POST`, `Content-Type: application/json` (+ `X-Bot-Token` si hay secreto), Body con campos:
`rawMessage = {body}`, `phone = {from}`, `history = {history}`, `urlTempFile = {urlTempFile}`.

| Flujo | Evento | Endpoint | Enviar al cliente | Después |
|---|---|---|---|---|
| 🧠 Principal | GENERAL | `https://api.kovashopper.com/api/whatsapp-bot/brain` | **APAGADO** | Rules por `route` (abajo) |
| 💬 Conversación | ACCIÓN | `https://api.kovashopper.com/api/whatsapp-bot/conversation` | `{message}` | Sin Rules |
| 📚 Catálogo | ACCIÓN | `https://api.kovashopper.com/api/whatsapp-bot/catalog` | `{message}` | Sin Rules |
| 💳 Checkout tarjeta | ACCIÓN | `https://api.kovashopper.com/api/whatsapp-bot/checkout` | `{message}` | Sin Rules |
| 🏦 Checkout transferencia | IMAGEN O VÍDEO | `https://api.kovashopper.com/api/whatsapp-bot/checkout` | `{message}` | Sin Rules (también recibe fotos y comprobantes) |
| 🙋 Asesor humano | ACCIÓN | `https://api.kovashopper.com/api/whatsapp-bot/human` | `{message}` | Paso **Silenciar 60 min** |

Rules de 🧠 Principal:

| `route` | Va a | Cuándo |
|---|---|---|
| `conversation` | 💬 Conversación | Charla, búsqueda, datos, consultas de pedido, "sí" con contra entrega, "eres un bot?" |
| `catalog` | 📚 Catálogo | Pide el catálogo |
| `checkoutCard` | 💳 Checkout tarjeta | "sí" al resumen con tarjeta |
| `checkoutTransfer` | 🏦 Checkout transferencia | "sí" al resumen con transferencia, o llega una foto/PDF |
| `human` | 🙋 Asesor humano | Asesor, reclamo, garantía, devolución, producto dañado |
| `silenced` | **Sin Rule** | La sesión está silenciada (pidió asesor hace < 60 min o el panel la silenció): el bot no contesta |

Nunca una Rule hacia el mismo flujo (bucle). Los flujos destino no llevan Rules. Contra entrega no necesita flujo
propio: el "sí" va a 💬 Conversación, que crea el pedido igual. Endpoints extra: `/search-order`, `/media`.

El panel muestra esta misma guía con URLs completas en `GET /api/whatsapp-bot/admin/config`.

## Variables de entorno

| Variable | Para qué |
|---|---|
| `GEMINI_API_KEY` | Gemini (extracción, respuestas de productos, voz, fotos y comprobantes). Sin ella el bot funciona con reglas. |
| `GEMINI_MODEL` | Opcional, por defecto `gemini-2.5-flash`. |
| `BOT_NAME` | Nombre del bot (por defecto "Kova"). |
| `BOT_AI_VOICE` | `off` apaga la voz con IA (los textos salen tal cual). |
| `BOT_SUPPORT_PHONE` | Opcional: número que el bot da cuando piden un asesor. |
| `WHATSAPP_BOT_SECRET` | Opcional: exige `X-Bot-Token` en los endpoints del bot. |
| `BOT_TEST_PHONE` | Solo con `NODE_ENV` ≠ `production`: fija el teléfono (pruebas por Postman/Telegram). |
| `PUBLIC_WEB_URL` | Base del link de pago (`https://kovashopper.com/pagar/<token>`). |
| Ya existentes | `PAYPHONE_TOKEN`, `PAYPHONE_STORE_ID` (sin ellos no se ofrece tarjeta), `CLOUDINARY_*`, `RESEND_*`. |

Cuentas de transferencia y recargos: panel → Configuración (`settings.bankAccounts`, `codSurcharge`,
`transferSurcharge`). Sin cuentas, ni la web ni el bot ofrecen transferencia.

## Panel (admin)

`authMiddleware + adminMiddleware`, prefijo `/api/whatsapp-bot/admin`:

| Método | Ruta | Respuesta |
|---|---|---|
| GET | `/events?phone&page&limit&errors=1&kind` | `{ items: [{ _id, createdAt, phone, endpoint, kind, route, decision, step, message, reply, mediaUrl, orderNumber, paymentLink, duplicated, durationMs, error }], total, page, pages }`. `kind`: `decision` (brain), `turn`, `error`, `human_request` |
| GET | `/conversations/:phone?before&limit` | Chat completo (ver abajo): `{ phone, session, messages, hasMore, nextBefore }` |
| GET | `/sessions?page&limit&q` | `{ items: [{ phone, customerName, stage, cart: { items, total, summary }, paymentMethod, orderNumber, silencedUntil, optOut, humanRequested, humanRequestedAt, lastMessage: { role, content, hasMedia, at }, updatedAt }], total, page, pages }`. `q` busca por teléfono, nombre o `KV-` |
| POST | `/sessions/:phone/reset` | `{ ok, phone }` — vacía carrito y paso (no toca pedidos). 404 si no existe |
| POST | `/sessions/:phone/silence` | body `{ minutes }` (1–1440, por defecto 60) → `{ ok, phone, silencedUntil }` |
| POST | `/sessions/:phone/unsilence` | `{ ok, phone, silencedUntil: null }` |
| GET | `/config` | `{ botName, aiEnabled, aiModel, aiVoice, secretRequired, supportPhone, payLinkBase, body, headers, endpoints: [{ name, method, url, use }], flows: [...], rules: [...] }` |

`:phone` acepta `0990000001`, `+593990000001` o `lid:…`. La bitácora se borra sola a los 30 días (TTL).

### Conversación (`GET /conversations/:phone`)

Lo que usa la vista `/admin/bot/chat/:phone` del panel (se refresca cada 8 s). Une la bitácora (`BotEvent`, 30 días)
con el `history` de la sesión (3 días) para los turnos que no quedaron en la bitácora.

- `session`: el mismo resumen de `/sessions` (`customerName`, `stage`, `cart`, `orderNumber`, `silencedUntil`, `optOut`,
  `humanRequested`, …) o `null` si la sesión ya expiró y solo queda la bitácora. 404 si no hay ni sesión ni eventos.
- `messages` (cronológico): `{ id, at, role: "client" | "bot" | "system", text, mediaUrl?, kind?, meta?, source }`.
  - `client`: lo que escribió el cliente (`mediaUrl` si mandó foto/PDF; `text` es `[archivo adjunto]` sin texto).
  - `bot`: la respuesta del flujo, con `meta: { endpoint, route, decision, step, ms, error, orderNumber, paymentLink,
    duplicated?, brain?: { route, decision, step, ms } }` (`brain` = lo que decidió `/brain` antes de ese flujo).
  - `system` con `kind`: `order_created` (`R7:orden_creada`), `payment_link`, `receipt` (`R1:comprobante`),
    `payment_confirmed`, `human_request`, `silenced` (`/brain` respondió `silenced`: el bot no contestó),
    `duplicated` (mismo mensaje en < 5 s: misma respuesta), `error` (el flujo falló; `meta.error`).
  - Un `/brain` sin flujo después sale como mensaje `client` con `meta` del brain (silenciado o aún procesando).
  - `source: "history"` cuando el turno sale del historial de la sesión y no de la bitácora (sin `meta`).
  - `id` es estable entre refrescos (el mensaje del cliente usa el id del `/brain`): el panel reemplaza en vez de duplicar.
- Paginación hacia atrás: `limit` (1–200, por defecto 50) cuenta filas de la bitácora; si `hasMore`, pide la página
  anterior con `before=<nextBefore>`. El `/brain` de un turno nunca queda en otra página que su respuesta.

## Logs

- **Terminal:** `pnpm bot:logs` (últimos 60 pasos), `pnpm bot:logs -- 0991234567`, `pnpm bot:logs -- --errors`,
  `pnpm bot:logs -- --human`. Lee `DB_URI`: para desarrollo exporta la de `kova-dev` antes (el `.env` apunta a producción).
- **Vercel:** cada mensaje deja una línea `[bot]` con teléfono, decisión de `/brain`, flujo, regla, tiempo, lo que
  escribió el cliente y lo que respondió el bot.

## Pruebas

```bash
pnpm test:bot              # conversaciones completas sin red ni Mongo (dependencias falsas)
VERBOSE=1 pnpm test:bot    # imprime las conversaciones
```

Cubre: compra con tarjeta (oferta de 2 u), transferencia con dos bancos + comprobante, contra entrega, variante,
"quiero 2 licuadoras", consulta `KV-`, asesor/reclamo/garantía, opt-out, fuera de tema, "eres un bot?", sin "¿¡",
"pagado", "ya transferí", foto de producto, ciudades ambiguas, sesión `@lid`, cédula/correo, cambio de datos en el
resumen, `/brain`, voz con IA (no cambia ni inventa datos), extractor con IA (refs y precios inventados), Payphone.

Contra la API local (`pnpm dev`, puerto 8100):

```bash
curl -s -X POST localhost:8100/api/whatsapp-bot/conversation -H 'Content-Type: application/json' \
  -d '{"rawMessage":"quiero un parlante","phone":"593990000001@s.whatsapp.net"}'
```

`reiniciatodo` borra la conversación de ese teléfono.

## Qué NO se copió de Megaprinter (a propósito)

- Servicio técnico, suministros y tickets: Kova no los ofrece.
- Cuentas bancarias con logo y su propio modelo: Kova usa `settings.bankAccounts`.
- Lógica propia de pedidos: el bot usa `checkout.service` y `order.service`, igual que la web.
- Aprobación automática del pago por IA y mensajes proactivos (violan la política de Meta).
