import { BotProduct, catalogOverview, searchProducts } from "./catalog";
import {
  chooseProduct,
  continuePending,
  handlePendingStep,
  refreshCart,
  showOptions,
} from "./cart";
import {
  applyExtraction,
  applyStageAnswer,
  askNext,
  availableMethods,
  confirmOrder,
  missingStage,
  pickBankFromText,
  resetNamedField,
  retryText,
} from "./checkout";
import {
  asksIfBot,
  claimsPaid,
  claimsTransfer,
  detectPaymentMethod,
  extractChoice,
  extractQuantity,
  isComplaint,
  isGreeting,
  isNo,
  isYes,
  normalize,
  orderNumberIn,
  wantsCancel,
  wantsHuman,
  wantsOptOut,
  wantsTracking,
} from "./intents";
import { cardCheckReply, handleMedia, handleOrders } from "./afterSale";
import { reply } from "./reply";
import {
  ASK_PRODUCT,
  AUDIO_REPLY,
  GREETING,
  VIDEO_REPLY,
  selfIntro,
  cartText,
  QUESTIONS,
} from "./texts";
import { BotDeps, BotState, TurnInput, TurnResult, createInitialState } from "./types";

/**
 * MÁQUINA DE ESTADOS DEL BOT DE WHATSAPP.
 *
 * Función pura: recibe el estado guardado y el mensaje, devuelve el estado
 * nuevo y la respuesta. Todo lo externo entra por `BotDeps`.
 *
 * Reglas, en orden: R1 archivo · R0 control (vacío, no escribir, ¿eres bot?) ·
 * R2 humano · R3 pagos y pedidos · R4 cancelar · R5 elección (producto,
 * variante, cantidad) · R6 datos · R7 confirmar · R8 catálogo y preguntas ·
 * R9 siguiente paso.
 */

const DATA_STAGES: BotState["stage"][] = [
  "name",
  "phone",
  "city",
  "city_choice",
  "address",
  "reference",
  "extras",
  "payment",
  "bank",
];

const resetOrder = (state: BotState) =>
  Object.assign(state, {
    cart: [],
    options: [],
    pending: null,
    quantityOptions: [],
    paymentMethod: null,
    paymentOptions: [],
    bankIndex: -1,
    orderId: "",
    orderNumber: "",
    stage: "idle",
  });

/**
 * La consulta de un pedido no corta la compra en curso: después del estado del pedido
 * se repite la pregunta pendiente (producto, variante, cantidad, datos o resumen).
 */
async function resumePurchase(state: BotState, deps: BotDeps, result: TurnResult) {
  const keep = (next: TurnResult): TurnResult => ({
    ...next,
    route: result.route,
    intent: result.intent,
    orderNumber: result.orderNumber,
    paymentLink: result.paymentLink,
  });
  const prefix = `${result.reply}\n\nY seguimos con tu compra 🛒`;
  if (state.stage === "choosing" && state.options.length) {
    return keep(
      reply(
        state,
        `${prefix} Respóndeme con el número del producto que te interesa.`,
        result.decision,
      ),
    );
  }
  if ((state.stage === "variant" || state.stage === "quantity") && state.pending)
    return keep(await continuePending(state, deps, result.decision, prefix));
  if (state.cart.length && (DATA_STAGES.includes(state.stage) || state.stage === "confirm"))
    return keep(await askNext(state, deps, result.decision, prefix));
  return result;
}

// ─── Turno ───────────────────────────────────────────────────────────────────

export async function handleTurn(
  previous: BotState,
  input: TurnInput,
  deps: BotDeps,
): Promise<TurnResult> {
  const state: BotState = JSON.parse(JSON.stringify({ ...createInitialState(), ...previous }));
  if (!state.phone && deps.whatsappPhone) state.phone = deps.whatsappPhone;
  const message = input.message.trim();
  // La lista de pedidos para elegir vale solo para la respuesta siguiente.
  const orderChoices = state.orderChoices || [];
  state.orderChoices = [];

  // R1: comprobante, foto de producto, video o audio.
  if (input.mediaUrl) return handleMedia(state, input.mediaUrl, deps);
  if (input.mediaWithoutUrl && !message) {
    if (input.mediaEvent === "video") return reply(state, VIDEO_REPLY, "R0:video_sin_url");
    if (input.mediaEvent === "audio") return reply(state, AUDIO_REPLY, "R0:audio_sin_url");
    return reply(
      state,
      "Uy, no logré abrir tu archivo 😕 Me lo reenvías como *foto*? 📸",
      "R0:media_sin_url",
    );
  }
  if (!message) return askNext(state, deps, "R0:mensaje_vacio");

  // R0: no quiere más mensajes. Se respeta y se lo dice (el bot nunca escribe primero).
  if (wantsOptOut(message) && !["confirm", "choosing"].includes(state.stage)) {
    state.optOut = true;
    return reply(
      state,
      "Listo, no te escribo más 🙊 Si algún día me necesitas, escríbeme y aquí estoy 💙",
      "R0:no_escribir",
    );
  }

  // Transparencia (Meta): si pregunta si es un bot o una persona, se le dice la verdad.
  if (asksIfBot(message)) {
    return reply(
      state,
      `Sí, soy un bot 🤖 Soy ${selfIntro().replace(" 🤖", "")}, y te ayudo con productos, pagos y pedidos a cualquier hora 💙 Si prefieres hablar con una persona del equipo, escríbeme *asesor* 🙌`,
      "R2:soy_un_bot",
    );
  }

  // R2: reclamo (garantía, devolución, producto dañado): a una persona y queda como incidencia.
  if (isComplaint(message)) {
    const contact = deps.supportPhone ? ` También puedes escribir al ${deps.supportPhone}.` : "";
    return reply(
      state,
      `Siento mucho el inconveniente 🙏 Ya le pasé tu caso a una persona del equipo de Kova y te escribe por aquí en un ratito para ayudarte 💙${contact}`,
      "R2:reclamo",
      { intent: "dudas", route: "human" },
    );
  }

  // R2: pedir una persona.
  if (wantsHuman(message)) {
    const contact = deps.supportPhone
      ? ` También puedes escribir directo al ${deps.supportPhone}.`
      : "";
    return reply(
      state,
      `Claro! Te paso con una persona del equipo de Kova 🙌 En un ratito te escribe por aquí 💙${contact}`,
      "R2:humano",
      {
        intent: "dudas",
        route: "human",
      },
    );
  }

  // R3: "pagado" con un pedido de tarjeta: se verifica con Payphone y se confirma.
  if (claimsPaid(message) && state.paymentMethod !== "transfer") {
    const check = await deps.checkCardPayment(state.orderId);
    if (check) return cardCheckReply(state, check);
  }
  // R3: "ya transferí": falta la foto del comprobante.
  if (
    (claimsTransfer(message) || claimsPaid(message)) &&
    state.stage === "ordered" &&
    state.paymentMethod === "transfer"
  ) {
    return reply(
      state,
      "Genial! 🙌 Mándame por aquí la *foto del comprobante* 📸 y el equipo valida tu pago 💙",
      "R3:pedir_comprobante",
      {
        route: "awaitingReceipt",
        orderNumber: state.orderNumber,
        paymentMethod: "transfer",
      },
    );
  }
  // R3: respuesta a "cuál pedido?" ("el 2", "KV-1003").
  if (orderChoices.length) {
    const choice = extractChoice(message, orderChoices.length);
    const typed = orderNumberIn(message);
    const picked = choice ? orderChoices[choice - 1] : typed;
    if (picked) {
      const shown = await handleOrders(state, message, deps, { picked });
      if (shown) return resumePurchase(state, deps, shown);
    }
  }
  // R3: estado de pedidos ("mi pedido", "KV-1001", "dónde está mi paquete"), desde
  // cualquier paso: siempre en vivo desde la base y luego se retoma la compra.
  if (wantsTracking(message) || orderNumberIn(message) || claimsTransfer(message)) {
    const shown = await handleOrders(state, message, deps, { force: claimsTransfer(message) });
    if (shown) return resumePurchase(state, deps, shown);
  }

  // R4: vaciar el carrito (antes de crear el pedido).
  if (wantsCancel(message) && state.stage !== "ordered" && (state.cart.length || state.pending)) {
    resetOrder(state);
    return reply(
      state,
      "Listo, vacié tu carrito 🗑️ Si quieres ver otra cosa, cuéntame qué buscas 😊",
      "R4:vaciar_carrito",
    );
  }

  // R5: variante y cantidad del producto elegido.
  if (state.stage === "variant" || state.stage === "quantity") {
    const answered = await handlePendingStep(state, message, deps);
    if (answered) return answered;
  }

  const catalog = await deps.loadCatalog();
  const byId = new Map(catalog.map((product) => [product.id, product]));

  // R5: elección entre las opciones mostradas ("2", "la segunda", "sí" con una sola).
  if (state.stage === "choosing" && state.options.length) {
    const choice =
      extractChoice(message, state.options.length) ||
      (state.options.length === 1 && isYes(message) ? 1 : null);
    const product = choice ? byId.get(state.options[choice - 1].productId) : null;
    if (product) return chooseProduct(state, product, deps, `R5:eleccion_${choice}`, null, message);
    // "el azul": la opción cuya variante nombró.
    const value = ` ${normalize(message)} `;
    const byVariant = state.options
      .map((option) => byId.get(option.productId))
      .find((item) =>
        item?.variants.some((variant) => value.includes(` ${normalize(variant.name)} `)),
      );
    if (byVariant)
      return chooseProduct(state, byVariant, deps, "R5:eleccion_por_variante", null, message);
  }

  // Desde aquí se necesita entender el mensaje.
  const extraction = await deps.extract(message, {
    stage: state.stage,
    lastQuestion: state.lastQuestion,
    cart: state.cart,
    history: input.history || "",
    catalog,
  });

  // Después de un pedido, un producto nuevo arranca otro (se conservan los datos del cliente).
  if (state.stage === "ordered" && (extraction.items.length || extraction.intent === "comprar"))
    resetOrder(state);
  if (state.stage === "ordered") {
    // Un saludo después del pedido es una conversación nueva: no se repite la instrucción de pago.
    if (isGreeting(message)) {
      resetOrder(state);
      return reply(
        state,
        `Hola de nuevo! 👋 ${ASK_PRODUCT}\n\nPara ver cómo va tu pedido escribe *mi pedido* 📦`,
        "R9:saludo_nuevo",
      );
    }
    if (
      extraction.intent !== "pregunta" &&
      extraction.intent !== "catalogo" &&
      extraction.intent !== "fuera_de_tema"
    ) {
      return reply(
        state,
        `Tu pedido *${state.orderNumber}* ya está registrado ✅ Para ver cómo va escríbeme *mi pedido* 📦 Te ayudo con algo más? 😊`,
        "R7:ya_registrado",
        {
          orderNumber: state.orderNumber,
        },
      );
    }
  }

  // R6: datos del cliente y cambios al carrito.
  const snapshot = () =>
    JSON.stringify([
      state.firstName,
      state.lastName,
      state.phone,
      state.city,
      state.street,
      state.reference,
      state.idNumber,
      state.email,
      state.paymentMethod,
      state.bankIndex,
    ]);
  const before = snapshot();
  await applyExtraction(state, extraction, message, deps);

  if (extraction.remove.length) {
    state.cart = state.cart.filter((line) => !extraction.remove.includes(line.productId));
    await refreshCart(state, deps);
    return askNext(
      state,
      deps,
      "R6:quitado",
      state.cart.length
        ? `Listo, lo quité 👍\n\n${cartText(state.cart)}`
        : "Listo, lo quité 👍 Tu carrito quedó vacío.",
    );
  }
  const wanted = extraction.items
    .map((item) => ({ product: byId.get(item.productId), quantity: item.quantity }))
    .find((item) => item.product);
  if (wanted?.product) {
    // La IA a veces pone 1 por defecto: solo cuenta si el cliente dijo un número.
    const saidNumber = /\d|\b(dos|tres|cuatro|cinco)\b/.test(normalize(message));
    const quantity = extractQuantity(message) || (saidNumber ? wanted.quantity : null);
    return chooseProduct(state, wanted.product, deps, "R6:agregado", quantity, message);
  }

  // "tarjeta" / "contra entrega" con carrito es la forma de pago, nunca una búsqueda.
  const namedMethod = detectPaymentMethod(message);
  if (
    namedMethod &&
    state.cart.length &&
    !["choosing", "variant", "quantity"].includes(state.stage) &&
    extraction.intent !== "pregunta"
  ) {
    if (!availableMethods(deps).includes(namedMethod)) {
      return askNext(
        state,
        deps,
        "R6:pago_no_disponible",
        "Por ahora esa forma de pago no la tenemos activa 🙏",
      );
    }
    if (state.paymentMethod !== namedMethod)
      Object.assign(state, { paymentMethod: namedMethod, bankIndex: -1 });
    // "transfiero por Pichincha": ya trae el banco, no se le pregunta.
    if (namedMethod === "transfer") pickBankFromText(state, deps, message, true);
    return askNext(state, deps, "R6:pago", "Perfecto 👍");
  }
  // "mejor te pago por Pichincha" en el resumen: cambia a transferencia a ese banco.
  if (
    state.stage === "confirm" &&
    extraction.intent !== "pregunta" &&
    pickBankFromText(state, deps, message, false)
  ) {
    return askNext(state, deps, "R6:banco", "Perfecto 👍");
  }

  // R7: confirmación del resumen.
  if (state.stage === "confirm") {
    if (isYes(message) && missingStage(state, deps) === "confirm") return confirmOrder(state, deps);
    if (resetNamedField(state, message))
      return askNext(state, deps, "R7:cambiar_dato", "Claro! ✏️");
    if (isNo(message)) {
      return reply(
        state,
        "Claro! ✏️ Qué cambiamos? Escríbeme *nombre*, *ciudad*, *dirección*, *cédula*, *forma de pago* o el producto que quieres agregar o quitar 😊",
        "R7:pedir_cambio",
      );
    }
  }

  // Respuesta al paso pendiente con reglas. "también un cargador" al pedir el nombre es un producto.
  const asksProduct =
    /\b(tambien|ademas|agrega|agregame|anade|quiero|busco|necesito)\b/.test(normalize(message)) &&
    searchProducts(catalog, message).length > 0;
  if (!asksProduct && DATA_STAGES.includes(state.stage)) {
    const stage = state.stage;
    const answered = await applyStageAnswer(state, message, deps);
    if (answered === true) {
      const prefix =
        stage === "city" && state.city && state.province !== state.city
          ? `Listo, ${state.city} (${state.province}) 📍`
          : "";
      return askNext(state, deps, `R6:dato_${stage}`, prefix);
    }
    if (
      answered === "retry" &&
      (extraction.intent === "dato" ||
        extraction.intent === "otro" ||
        extraction.intent === "comprar")
    ) {
      return reply(state, retryText(stage) || QUESTIONS.name, `R6:dato_${stage}_invalido`);
    }
  }
  const dataChanged = before !== snapshot();
  if (dataChanged && state.cart.length && extraction.intent !== "pregunta") {
    return askNext(
      state,
      deps,
      state.stage === "confirm" ? "R7:dato_cambiado" : "R6:datos",
      state.stage === "confirm" ? "Actualizado 👍" : "",
    );
  }

  // R8: catálogo, preguntas y búsquedas.
  const pendingStage =
    state.cart.length && !["choosing", "variant", "quantity", "ordered"].includes(state.stage)
      ? missingStage(state, deps)
      : "idle";
  const resume = async (text: string, decision: string, extra: Partial<TurnResult> = {}) => {
    if (pendingStage === "idle") return reply(state, text, decision, extra);
    const next = await askNext(state, deps, decision, text);
    return { ...next, ...extra, route: extra.route || next.route };
  };

  // Política de Meta (2026): nada de asistente de propósito general. Solo Kova.
  if (extraction.intent === "fuera_de_tema") {
    return resume(
      "Uy, eso se me escapa 🙈 Yo te ayudo con todo lo de *Kova*: productos, pagos, envíos y tus pedidos 🛍️",
      "R8:fuera_de_tema",
    );
  }
  if (extraction.intent === "catalogo") {
    return resume(catalogOverview(catalog, deps.storeUrl), "R8:catalogo", {
      intent: "menu",
      route: "catalog",
    });
  }
  const suggested = extraction.suggestions
    .map((id) => byId.get(id))
    .filter((product): product is BotProduct => Boolean(product));
  if (extraction.intent === "pregunta" && extraction.answer) {
    if (suggested.length && pendingStage === "idle")
      return showOptions(state, suggested, "R8:pregunta_con_opciones", extraction.answer);
    return resume(extraction.answer, "R8:pregunta");
  }
  if (
    ["comprar", "pregunta"].includes(extraction.intent) ||
    (extraction.intent === "otro" && state.stage === "idle")
  ) {
    const found = suggested.length
      ? suggested
      : searchProducts(catalog, extraction.searchQuery || message);
    if (found.length === 1 && extraction.intent === "comprar" && extractQuantity(message)) {
      return chooseProduct(
        state,
        found[0],
        deps,
        "R8:busqueda_directa",
        extractQuantity(message),
        message,
      );
    }
    if (found.length) return showOptions(state, found, "R8:busqueda");
    if (extraction.intent === "pregunta") {
      return resume(
        `Esa pregunta no te la sé responder con seguridad 🤔 Escribe *asesor* y te ayuda una persona del equipo, o pídeme el *catálogo*.`,
        "R8:pregunta_sin_respuesta",
      );
    }
    if (!isGreeting(message) && extraction.intent === "comprar" && state.stage === "idle") {
      return reply(
        state,
        `No encontré eso en la tienda 🤔 Prueba con otras palabras o pídeme el *catálogo*. Si buscas algo especial, escribe *asesor*.`,
        "R8:sin_resultados",
      );
    }
  }

  // R9: saludo o algo que no se entendió: se retoma el paso pendiente.
  if (
    isGreeting(message) &&
    !state.cart.length &&
    !["variant", "quantity", "choosing"].includes(state.stage)
  ) {
    return reply(state, GREETING(), "R9:saludo");
  }
  if (state.stage === "choosing") {
    return reply(
      state,
      "No te entendí 🙏 Respóndeme con el número de la opción que quieres, o dime qué otra cosa buscas.",
      "R9:eleccion_no_entendida",
    );
  }
  if ((state.stage === "variant" || state.stage === "quantity") && state.pending) {
    return continuePending(state, deps, "R9:repetir", "No te entendí 🙏");
  }
  return askNext(state, deps, "R9:siguiente_paso");
}
