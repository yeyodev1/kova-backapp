import { env } from "../../config/env";
import { formatCents } from "./catalog";
import type { BotPaymentMethod } from "./intents";
import { placeText } from "./location";
import type {
  BankOption,
  BotState,
  CartLine,
  CreatedOrder,
  OrderSummary,
  QuoteSummary,
} from "./types";

/**
 * Textos del bot. El router decide QUÉ decir; aquí vive CÓMO se dice. La voz
 * con IA (voice.ts) puede reescribir el texto libre, nunca los datos.
 */

/** Nombre del bot (configurable con BOT_NAME). */
export const botName = () => env.BOT_NAME.trim() || "Kova";

/**
 * Estilo de la marca: en WhatsApp nadie escribe "¿" ni "¡" al inicio, solo el
 * signo final. Se aplica a TODO lo que sale, incluidas las respuestas de la IA.
 */
export const casualMarks = (text: string) => text.replace(/[¿¡]/g, "");

export const ASK_PRODUCT =
  "Cuéntame qué buscas hoy 🛍️ Escríbeme el nombre del producto, mándame una foto 📸 o pídeme el *catálogo*";

/** "el bot de *Kova*" o "*Luna* 🤖, el bot de *Kova*" según BOT_NAME. */
export const selfIntro = () =>
  botName().toLowerCase() === "kova"
    ? "el bot de *Kova* 🤖"
    : `*${botName()}* 🤖, el bot de *Kova*`;

export const GREETING = () =>
  `Hola! Soy ${selfIntro()}. Te ayudo a comprar, pagar y ver tus pedidos cuando quieras 💙\n\n${ASK_PRODUCT}`;

export const VIDEO_REPLY =
  "Por aquí no puedo ver videos 🙏 Mándame una *foto o captura* de lo que buscas y te digo si lo tenemos.";
export const AUDIO_REPLY =
  "Todavía no puedo escuchar audios 🙏 Escríbeme lo que necesitas o mándame una *foto* de lo que buscas.";

export const QUESTIONS = {
  name: "A nombre de quién va el pedido? 😊 Pásame tu *nombre y apellido*",
  lastName: "Y tu *apellido*? 😊",
  phone: "Pásame un *celular de contacto* (09XXXXXXXX) para coordinar la entrega 📱",
  city: "En qué *ciudad* te lo entregamos? 🚚 (ej. Guayaquil, Quito, Cuenca)",
  address:
    "Cuál es la *dirección exacta*? 🏠 Calle principal, número y secundaria. Si puedes, agrega una *referencia* (ej. frente al parque, casa azul)",
  reference:
    "Y una *referencia* para que el repartidor te encuentre fácil? (ej. junto a la farmacia, casa esquinera). Si no tienes, escribe *no*",
  extras:
    "Último detalle y es opcional 📝 Pásame tu *cédula* y tu *correo* (para la factura y el seguimiento). Si prefieres saltarlo, escribe *no*",
};

export const PAYMENT_LABEL: Record<BotPaymentMethod, string> = {
  card: "Tarjeta (link seguro de Payphone)",
  transfer: "Transferencia bancaria",
  cod: "Contra entrega (pagas al recibir)",
};

const PAYMENT_EMOJI: Record<BotPaymentMethod, string> = { card: "💳", transfer: "🏦", cod: "🚚" };

export function paymentQuestion(options: BotPaymentMethod[], quote: QuoteSummary) {
  const base = quote.subtotal + quote.shippingFee;
  // "El mejor precio" solo es cierto si otro método cobra recargo.
  const othersCostMore = options.some((method) => (quote.surcharges[method] || 0) > 0);
  const lines = options.map((method, index) => {
    const surcharge = quote.surcharges[method] || 0;
    const name =
      method === "card" ? "Tarjeta" : method === "transfer" ? "Transferencia" : "Contra entrega";
    const note =
      method === "card"
        ? surcharge
          ? ` (+${formatCents(surcharge)})`
          : othersCostMore
            ? " (el mejor precio)"
            : ""
        : method === "cod"
          ? ` (${surcharge ? `+${formatCents(surcharge)}, ` : ""}pagas al recibir)`
          : surcharge
            ? ` (+${formatCents(surcharge)})`
            : "";
    return `*${index + 1}.* ${PAYMENT_EMOJI[method]} ${name} — *${formatCents(base + surcharge)}*${note}`;
  });
  return `Cómo prefieres pagar? 💳\n${lines.join("\n")}\n\nRespóndeme con el número 😊`;
}

export function bankQuestion(banks: BankOption[]) {
  const list = banks.map((account, index) => `*${index + 1}.* ${account.bank}`).join("\n");
  return `A qué banco te queda mejor transferir? 🏦\n${list}\n\nRespóndeme con el número o el nombre del banco 😊`;
}

/** Datos de UNA cuenta en formato WhatsApp. */
export function bankText(account: BankOption) {
  return [
    account.bank && `🏦 *${account.bank}*`,
    account.type && `Cuenta ${account.type}`,
    `N.º *${account.number}*`,
    account.holder && `A nombre de: ${account.holder}`,
    account.idNumber && `RUC/Cédula: ${account.idNumber}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const lineText = (line: CartLine) =>
  `• ${line.quantity} × ${line.title}${line.variantName ? ` (${line.variantName})` : ""} — ${formatCents(line.total)}`;

export const cartText = (cart: CartLine[]) => cart.map(lineText).join("\n");

export const cartSubtotal = (cart: CartLine[]) => cart.reduce((sum, line) => sum + line.total, 0);

export function summaryText(state: BotState, quote: QuoteSummary, bank: BankOption | null) {
  const method = state.paymentMethod as BotPaymentMethod;
  const surchargeName = method === "cod" ? "Recargo contra entrega" : "Recargo transferencia";
  return [
    "Así va tu pedido 🛍️✨",
    "",
    cartText(state.cart),
    quote.shippingFee ? `• Envío — ${formatCents(quote.shippingFee)}` : "• Envío — gratis 🎉",
    quote.surcharge ? `• ${surchargeName} — ${formatCents(quote.surcharge)}` : null,
    `*Total: ${formatCents(quote.total)}*`,
    "",
    `👤 ${state.firstName} ${state.lastName}`.trim(),
    `📱 ${state.phone}`,
    `📍 ${state.street}${state.reference ? ` (Ref: ${state.reference})` : ""} — ${placeText(state)}`,
    state.idNumber ? `🪪 ${state.idNumber}` : null,
    state.email ? `📧 ${state.email}` : null,
    `💳 ${PAYMENT_LABEL[method]}${method === "transfer" && bank ? ` · ${bank.bank}` : ""}`,
    "",
    "Lo confirmo? Respóndeme *sí* ✅ o dime qué quieres cambiar",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function cardInstructions(order: CreatedOrder) {
  return [
    `Listo, tu pedido *${order.orderNumber}* ya está registrado 🎉💙`,
    "",
    `Paga *${formatCents(order.total)}* con tarjeta en este link seguro de Payphone 🔒👇`,
    order.paymentLink,
    "",
    "Cuando termines, regresa aquí y escríbeme *pagado* ✅ y lo confirmo al toque",
  ].join("\n");
}

export function transferInstructions(order: CreatedOrder, bank: BankOption) {
  return [
    `Listo, tu pedido *${order.orderNumber}* ya está registrado 🎉💙`,
    "",
    `Transfiere exactamente *${formatCents(order.total)}* a esta cuenta 👇`,
    bankText(bank),
    "",
    "Cuando hagas la transferencia, mándame por aquí la *foto del comprobante* 📸 y el equipo la valida 🙌",
  ].join("\n");
}

export function codInstructions(order: CreatedOrder) {
  return [
    `Listo, tu pedido *${order.orderNumber}* quedó confirmado 🎉💙`,
    "",
    `Pagas *${formatCents(order.total)}* en efectivo cuando te llegue 🚚 Te contactamos para coordinar la entrega.`,
    "",
    "Para ver cómo va, escríbeme *mi pedido* 📦",
  ].join("\n");
}

const STATUS_TEXT: Record<string, string> = {
  pending_payment: "esperando el pago con tarjeta 💳",
  awaiting_transfer: "esperando el comprobante de transferencia 🏦",
  transfer_review: "comprobante en revisión 🔎",
  confirmed: "confirmado ✅, preparando tu envío 📦",
  sent_to_dropi: "en preparación para el envío 📦",
  shipped: "enviado 🚚",
  delivered: "entregado ✅",
  returned: "devuelto",
  cancelled: "cancelado",
  failed: "pago no completado",
};

export function orderStatusLine(order: OrderSummary) {
  const status = STATUS_TEXT[order.status] || order.status;
  const guide = order.guide
    ? ` · guía ${order.carrier ? `${order.carrier} ` : ""}*${order.guide}*`
    : "";
  const pay = order.paymentLink ? `\n  Paga aquí: ${order.paymentLink}` : "";
  return `• *${order.number}* — ${formatCents(order.total)} — ${status}${guide}${pay}`;
}
