import { BotProduct, formatCents, searchProducts } from "./catalog";
import { showOptions } from "./cart";
import {
  explicitTracking,
  extractEmail,
  extractIdNumber,
  normalize,
  orderNumberIn,
} from "./intents";
import { reply } from "./reply";
import { AUDIO_REPLY, VIDEO_REPLY } from "./texts";
import type { BotDeps, BotState, CardCheck, OrderSummary, TurnResult } from "./types";

/**
 * DESPUÉS DE LA VENTA: archivos del cliente (comprobante, foto de producto,
 * video, audio), verificación de "pagado" con Payphone y estado de pedidos.
 */

export function cardCheckReply(state: BotState, check: CardCheck): TurnResult {
  const extra = {
    intent: "consultar_pedido" as const,
    route: "searchOrder" as const,
    orderNumber: check.orderNumber,
    paymentMethod: "card" as const,
    total: check.total,
    paymentLink: check.paymentLink,
  };
  if (check.outcome === "paid_now" || check.outcome === "already_paid") {
    return reply(
      state,
      `Listo! ✅ Tu pago de *${formatCents(check.total)}* del pedido *${check.orderNumber}* está confirmado 💙 Ya lo estamos preparando para enviártelo 🚚`,
      check.outcome === "paid_now" ? "R3:pago_confirmado" : "R3:pago_ya_confirmado",
      extra,
    );
  }
  if (check.outcome === "rejected") {
    return reply(
      state,
      `Uy, el pago del pedido *${check.orderNumber}* salió rechazado 😕 Puedes intentarlo otra vez con otra tarjeta aquí 👇\n${check.paymentLink}`,
      "R3:pago_rechazado",
      extra,
    );
  }
  if (check.outcome === "review") {
    return reply(
      state,
      `Recibimos un pago para el pedido *${check.orderNumber}*, pero hay que revisarlo 🤔 Te paso con una persona del equipo 🙌`,
      "R3:pago_por_revisar",
      {
        ...extra,
        intent: "dudas",
        route: "human",
      },
    );
  }
  return reply(
    state,
    `Todavía no me aparece el pago del pedido *${check.orderNumber}* 🤔 Si ya lo hiciste, dame un minutito y escríbeme *pagado* otra vez. Si aún no, aquí tienes tu link seguro 👇\n${check.paymentLink}`,
    check.outcome === "error" ? "R3:pago_error_verificando" : "R3:pago_pendiente",
    extra,
  );
}

export async function handleMedia(
  state: BotState,
  mediaUrl: string,
  deps: BotDeps,
): Promise<TurnResult> {
  const outcome = await deps.receiveMedia(state.orderId, mediaUrl);
  if (outcome.status === "stored") {
    const warning =
      outcome.isReceipt === false
        ? "\n\nOjo: la imagen no parece un comprobante bancario. Si te equivocaste, envíame la foto correcta 🙏"
        : outcome.detectedAmount !== null && outcome.detectedAmount !== outcome.total
          ? `\n\nOjo: leí un monto de ${formatCents(outcome.detectedAmount)} y tu pedido es de ${formatCents(outcome.total)}. Si falta una parte, envíame también ese comprobante.`
          : "";
    return reply(
      state,
      `Gracias! 🙌 Recibí tu comprobante del pedido *${outcome.orderNumber}* 🧾 Una persona del equipo lo revisa y te confirmamos apenas se valide el pago 💙${warning}`,
      "R1:comprobante",
      {
        intent: "comprobante_recibido",
        route: "receiptReceived",
        orderNumber: outcome.orderNumber,
        paymentMethod: "transfer",
        total: outcome.total,
      },
    );
  }
  if (outcome.status === "image" && outcome.kind === "product") {
    const catalog = await deps.loadCatalog();
    const byId = new Map(catalog.map((product) => [product.id, product]));
    const matched = outcome.productIds
      .map((id) => byId.get(id))
      .filter((product): product is BotProduct => Boolean(product));
    const query = outcome.searchQuery || outcome.description;
    // "licuadora vidrio" puede no existir tal cual: se intenta con la palabra principal.
    const found = matched.length
      ? matched
      : searchProducts(catalog, query, 3).length
        ? searchProducts(catalog, query, 3)
        : searchProducts(catalog, query.split(" ")[0] || "", 3);
    if (found.length && outcome.exactMatch) {
      return showOptions(
        state,
        found.slice(0, 1),
        "R1:foto_producto_exacto",
        `Sí lo tenemos! 🙌 Veo ${outcome.description}:`,
      );
    }
    if (found.length) {
      return showOptions(
        state,
        found,
        "R1:foto_producto_parecido",
        `Veo ${outcome.description} 👀 Ese exacto no lo tengo, pero estos se parecen:`,
      );
    }
    return reply(
      state,
      `Veo ${outcome.description} 👀 Eso no lo tenemos ahora mismo 🙏 Dime qué necesitas y te muestro opciones, o pídeme el *catálogo*.`,
      "R1:foto_producto_sin_stock",
    );
  }
  if (outcome.status === "image") {
    const pending = outcome.pendingOrderNumber
      ? `\n\nSi querías enviar el comprobante del pedido *${outcome.pendingOrderNumber}*, mándame la foto del comprobante de la transferencia 🧾`
      : "";
    return reply(
      state,
      `Recibí tu imagen 📎 Si buscas un producto, mándame una foto o captura de él y te digo si lo tenemos.${pending}`,
      "R1:imagen",
    );
  }
  if (outcome.status === "video") return reply(state, VIDEO_REPLY, "R1:video");
  if (outcome.status === "audio") return reply(state, AUDIO_REPLY, "R1:audio");
  if (outcome.status === "no_order") {
    // Captura de un pago con tarjeta: se verifica con Payphone como un "pagado".
    const check = await deps.checkCardPayment(state.orderId);
    if (check) return cardCheckReply(state, check);
    return reply(
      state,
      "Recibí tu archivo 📎 pero no encuentro un pedido pendiente de transferencia con este número. Si compraste en la web, escríbeme tu número de pedido (empieza con *KV-*).",
      "R1:comprobante_sin_pedido",
    );
  }
  if (outcome.status === "unsupported") {
    return reply(
      state,
      "Ese tipo de archivo no lo puedo abrir 🙏 Mándame una *foto* o un *PDF*.",
      "R1:archivo_no_soportado",
    );
  }
  return reply(
    state,
    "Uy, no pude abrir tu archivo ahorita 😕 Me lo reenvías en un momentito? 🙏",
    "R1:archivo_error",
  );
}

// ── Consulta de pedidos ────────────────────────────────────────────────────

const STATUS_PLAIN: Record<string, string> = {
  pending_payment: "esperando el pago con tarjeta 💳",
  awaiting_transfer: "esperando tu transferencia 🏦",
  transfer_review: "revisando tu comprobante 🔎",
  confirmed: "confirmado ✅, lo estamos preparando 📦",
  sent_to_dropi: "en bodega, preparando el envío 📦",
  shipped: "en camino 🚚",
  delivered: "entregado ✅",
  returned: "devuelto ↩️",
  cancelled: "cancelado",
  failed: "el pago no se completó",
};

function paymentText(order: OrderSummary) {
  if (order.paymentMethod === "cod") {
    return order.paymentStatus === "paid"
      ? "contra entrega, ya pagado ✅"
      : `contra entrega: pagas *${formatCents(order.total)}* en efectivo al recibir 💵`;
  }
  if (order.paymentStatus === "paid") return `confirmado ✅ (${formatCents(order.total)})`;
  if (order.status === "cancelled") return "sin cobrar";
  if (order.paymentMethod === "card") {
    return order.status === "failed"
      ? `con tarjeta, no se completó (${formatCents(order.total)})`
      : `pendiente con tarjeta (${formatCents(order.total)})`;
  }
  return order.status === "transfer_review"
    ? `transferencia en revisión (${formatCents(order.total)})`
    : `pendiente por transferencia (${formatCents(order.total)})`;
}

function nextStep(order: OrderSummary) {
  switch (order.status) {
    case "pending_payment":
    case "failed":
      return order.paymentLink
        ? `Paga en este link seguro 👇\n${order.paymentLink}\nCuando termines escríbeme *pagado* ✅`
        : "Cuando pagues, escríbeme *pagado* ✅";
    case "awaiting_transfer":
      return `Transfiere *${formatCents(order.total)}* y mándame por aquí la *foto del comprobante* 📸`;
    case "transfer_review":
      return "El equipo está revisando tu comprobante. Apenas se valide te lo enviamos 💙";
    case "confirmed":
      return "Lo pasamos a la bodega para el envío. Te aviso cuando tenga guía 🙌";
    case "sent_to_dropi":
      return "La bodega lo está preparando. Cuando tenga guía la verás en el link de rastreo 🙌";
    case "shipped":
      return "Va en camino con la transportadora. Puedes seguirlo con la guía 👆";
    case "delivered":
      return "Que lo disfrutes! 💙 Si algo no está bien escribe *asesor*.";
    default:
      return "Si tienes dudas escribe *asesor* y te ayuda una persona del equipo.";
  }
}

const trackingLink = (order: OrderSummary, storeUrl: string) =>
  `${storeUrl}/rastrear?number=${encodeURIComponent(order.number)}&phone=${encodeURIComponent(order.phone)}`;

/** Estado en lenguaje claro, pago, guía, rastreo y qué sigue. */
export function orderDetailText(order: OrderSummary, storeUrl: string) {
  return [
    `Así va tu pedido *${order.number}* 📦`,
    "",
    `• Estado: ${STATUS_PLAIN[order.status] || order.status}`,
    `• Pago: ${paymentText(order)}`,
    ...(order.items ? [`• Productos: ${order.items}`] : []),
    ...(order.guide ? [`• Guía: ${order.carrier ? `${order.carrier} ` : ""}*${order.guide}*`] : []),
    `• Rastreo: ${trackingLink(order, storeUrl)}`,
    "",
    nextStep(order),
  ].join("\n");
}

const ecuadorDay = (date: Date) =>
  new Date(date.getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** "mi pedido de hoy / de ayer": filtra por el día de Ecuador. */
function byDay(orders: OrderSummary[], message: string) {
  const value = normalize(message);
  const offset = /\bantier|anteayer\b/.test(value)
    ? 2
    : /\bayer\b/.test(value)
      ? 1
      : /\bhoy\b/.test(value)
        ? 0
        : -1;
  if (offset < 0) return orders;
  const day = ecuadorDay(new Date(Date.now() - offset * 24 * 60 * 60 * 1000));
  const found = orders.filter((order) => ecuadorDay(new Date(order.createdAt)) === day);
  return found.length ? found : orders;
}

/**
 * "Cómo va mi pedido": SIEMPRE consulta Mongo en vivo y solo pedidos del teléfono del
 * chat. Con número, cédula o correo filtra dentro de esos. Varios pedidos: lista los
 * últimos 3 y pregunta cuál. `null` = no era sobre un pedido suyo (p. ej. "cuándo llega?"
 * antes de comprar y sin pedidos): el router sigue con la conversación normal.
 */
export async function handleOrders(
  state: BotState,
  message: string,
  deps: BotDeps,
  options: { force?: boolean; picked?: string } = {},
): Promise<TurnResult | null> {
  const wanted = options.picked || orderNumberIn(message);
  const idNumber = wanted ? "" : extractIdNumber(message);
  const email = wanted ? "" : extractEmail(message);
  const extra = { intent: "consultar_pedido" as const, route: "searchOrder" as const };
  const privacy = `Por seguridad solo te muestro pedidos hechos con este número de WhatsApp. Si compraste con otro celular, revísalo en ${deps.storeUrl}/rastrear con tu número de pedido y ese celular, o escribe *asesor* 🙌`;

  // WhatsApp ocultó el número: sin un KV- no hay cómo saber de quién son los pedidos.
  if (!deps.whatsappPhone && !wanted) {
    return reply(
      state,
      "Para buscar tu pedido escríbeme su número (empieza con *KV-*) 📦",
      "R3:pedir_numero_pedido",
      extra,
    );
  }

  let orders = await deps.findOrders({
    number: wanted || undefined,
    idNumber: idNumber || undefined,
    email: email || undefined,
  });
  if (!orders.length) {
    if (!wanted && !idNumber && !email && !options.force && !explicitTracking(message)) return null;
    const text = wanted
      ? `No encuentro el pedido *${wanted}* con este número de WhatsApp 🤔 ${privacy}`
      : idNumber || email
        ? `No encuentro pedidos con esos datos y este número de WhatsApp 🤔 ${privacy}`
        : `No encuentro pedidos con este número de WhatsApp 🤔 Si compraste con otro celular, escríbeme tu número de pedido (KV-…) o revísalo en ${deps.storeUrl}/rastrear`;
    return reply(state, text, "R3:sin_pedidos", extra);
  }

  if (!wanted) orders = byDay(orders, message);
  const shopping = state.cart.length > 0 || Boolean(state.pending);
  if (orders.length === 1) {
    const order = orders[0];
    // Pedido por transferencia esperando comprobante: el siguiente archivo se guarda ahí.
    if (order.status === "awaiting_transfer" && !shopping) state.orderId = order.id;
    return reply(state, orderDetailText(order, deps.storeUrl), "R3:consultar_pedido", {
      ...extra,
      route: order.status === "awaiting_transfer" ? "awaitingReceipt" : "searchOrder",
      orderNumber: order.number,
      paymentLink: order.paymentLink || undefined,
    });
  }

  const latest = orders.slice(0, 3);
  state.orderChoices = latest.map((order) => order.number);
  const awaiting = latest.find((order) => order.status === "awaiting_transfer");
  if (awaiting && !shopping) state.orderId = awaiting.id;
  const lines = latest.map(
    (order, index) =>
      `${index + 1}. *${order.number}* — ${formatCents(order.total)} — ${STATUS_PLAIN[order.status] || order.status}`,
  );
  return reply(
    state,
    `Tienes estos pedidos 📦\n\n${lines.join("\n")}\n\nCuál quieres ver? Respóndeme con el número (1, 2…) o el *KV-*`,
    "R3:elegir_pedido",
    { ...extra, orderNumber: latest[0].number },
  );
}
