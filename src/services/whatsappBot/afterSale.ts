import { BotProduct, formatCents, searchProducts } from "./catalog";
import { showOptions } from "./cart";
import { orderNumberIn } from "./intents";
import { reply } from "./reply";
import { AUDIO_REPLY, VIDEO_REPLY, orderStatusLine } from "./texts";
import type { BotDeps, BotState, CardCheck, TurnResult } from "./types";

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

export async function handleOrders(
  state: BotState,
  message: string,
  deps: BotDeps,
): Promise<TurnResult> {
  const wanted = orderNumberIn(message);
  const orders = await deps.findOrders(wanted || undefined);
  const extra = { intent: "consultar_pedido" as const, route: "searchOrder" as const };
  if (!orders.length) {
    const text = wanted
      ? `No encuentro el pedido *${wanted}* con este número de WhatsApp 🤔 Si lo hiciste con otro celular, revísalo en ${deps.storeUrl}/rastrear o escribe *asesor*.`
      : `No encuentro pedidos con este número de WhatsApp 🤔 Si compraste con otro celular, escríbeme tu número de pedido (KV-…) o revísalo en ${deps.storeUrl}/rastrear`;
    return reply(state, text, "R3:sin_pedidos", extra);
  }
  // Pedido por transferencia esperando comprobante: el siguiente archivo se guarda en ese pedido.
  const awaiting = orders.find((order) => order.status === "awaiting_transfer");
  if (awaiting) state.orderId = awaiting.id;
  const tail = awaiting
    ? `\n\nPara el pedido *${awaiting.number}* mándame la *foto del comprobante* 📸`
    : "";
  const title = orders.length === 1 ? "Así va tu pedido 📦" : "Estos son tus pedidos 📦";
  return reply(
    state,
    `${title}\n\n${orders.slice(0, 3).map(orderStatusLine).join("\n")}${tail}`,
    "R3:consultar_pedido",
    {
      ...extra,
      route: awaiting ? "awaitingReceipt" : "searchOrder",
      orderNumber: orders[0].number,
    },
  );
}
