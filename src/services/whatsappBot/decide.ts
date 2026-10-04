import {
  asksIfBot,
  extractChoice,
  isComplaint,
  isYes,
  orderNumberIn,
  wantsCatalog,
  wantsHuman,
  wantsTracking,
} from "./intents";
import { createInitialState, type BotState } from "./types";

/**
 * Rutas que decide /brain: una por flujo de BuilderBot (Conversación,
 * Catálogo, Checkout tarjeta, Checkout transferencia, Asesor humano) y
 * `silenced`, que no tiene Rule: BuilderBot no contesta mientras un asesor
 * atiende. Todos los endpoints procesan el turno completo, así que pedidos,
 * consultas y contra entrega se atienden bien aunque no tengan flujo propio.
 */
export const DECISIONS = [
  "conversation",
  "catalog",
  "checkoutCard",
  "checkoutTransfer",
  "human",
  "silenced",
] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * Decide el flujo SIN procesar el mensaje: no cambia el carrito, no crea
 * pedidos, no llama a la IA (milisegundos). Usa los mismos detectores que
 * handleTurn; si alguna vez difieren, el destino igual responde bien porque
 * corre el turno completo.
 */
export function decideRoute(
  previous: Partial<BotState> | null,
  input: { message: string; mediaUrl?: string; mediaEvent?: boolean; silenced?: boolean },
): { route: Decision; reason: string } {
  const state = { ...createInitialState(), ...(previous || {}) };
  const message = input.message.trim();

  if (input.silenced) return { route: "silenced", reason: "lo atiende una persona" };
  // Fotos: al flujo de transferencia, que en BuilderBot tiene el evento IMAGEN O VIDEO.
  if (input.mediaUrl || (input.mediaEvent && !message))
    return { route: "checkoutTransfer", reason: "archivo adjunto" };
  if (!message) return { route: "conversation", reason: "mensaje vacio" };
  // "hablo con una persona?" es una pregunta (se responde que es un bot), no un pedido de asesor.
  if (asksIfBot(message)) return { route: "conversation", reason: "pregunta si es un bot" };
  if (isComplaint(message)) return { route: "human", reason: "reclamo" };
  if (wantsHuman(message)) return { route: "human", reason: "pide una persona" };
  // Consultas de pedido: /conversation las responde en vivo desde la base, en cualquier paso.
  if (wantsTracking(message) || orderNumberIn(message))
    return { route: "conversation", reason: "consulta de pedido" };
  if (state.orderChoices?.length && extractChoice(message, state.orderChoices.length))
    return { route: "conversation", reason: "elige un pedido" };
  if (state.stage === "confirm" && isYes(message)) {
    if (state.paymentMethod === "transfer")
      return { route: "checkoutTransfer", reason: "confirma pedido por transferencia" };
    if (state.paymentMethod === "card")
      return { route: "checkoutCard", reason: "confirma pedido con tarjeta" };
    return { route: "conversation", reason: "confirma pedido contra entrega" };
  }
  if (
    wantsCatalog(message) &&
    !["choosing", "variant", "quantity", "payment", "bank"].includes(state.stage)
  ) {
    return { route: "catalog", reason: "pide el catalogo" };
  }
  return { route: "conversation", reason: "conversacion" };
}
