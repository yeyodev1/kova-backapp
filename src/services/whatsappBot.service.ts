import crypto from "crypto";
import { env } from "../config/env";
import { WhatsappSession } from "../models/whatsappSession.model";
import { geminiEnabled } from "./gemini.service";
import { notifyHumanRequest } from "./teamAlerts.service";
import { logBotEvent } from "./whatsappBot/activity";
import { catalogOverview } from "./whatsappBot/catalog";
import { decideRoute, Decision } from "./whatsappBot/decide";
import { buildDeps, loadCatalog, storeUrl } from "./whatsappBot/deps";
import {
  builderBotHistory,
  mediaEventKind,
  readMediaUrl,
  readMessage,
  readPhone,
} from "./whatsappBot/input";
import { claimsPaid } from "./whatsappBot/intents";
import { handleTurn } from "./whatsappBot/router";
import { ASK_PRODUCT, casualMarks } from "./whatsappBot/texts";
import { BotState, TurnResult, createInitialState } from "./whatsappBot/types";
import { naturalize } from "./whatsappBot/voice";

/**
 * BOT DE WHATSAPP (BuilderBot Cloud). Todas las rutas responden HTTP 200 con
 * `{ success, intencion, route, message, step, decision, ... }`: un 4xx/5xx
 * dejaría al cliente sin respuesta. Ver docs/WHATSAPP-BOT.md.
 */

export const HUMAN_SILENCE_MS = 60 * 60 * 1000;
const TURN_LOCK_MS = 45_000;
const TURN_WAIT_MS = 25_000;
const RETRY_WINDOW_MS = 5_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const FLOW_PATHS: Record<Decision, string> = {
  conversation: "/api/whatsapp-bot/conversation",
  catalog: "/api/whatsapp-bot/catalog",
  checkoutCard: "/api/whatsapp-bot/checkout",
  checkoutTransfer: "/api/whatsapp-bot/checkout",
  human: "/api/whatsapp-bot/human",
  silenced: "",
};

const isResetKeyword = (message: string) =>
  message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z]/g, "") === "reiniciatodo";

const oneLine = (text: string, max = 220) => {
  const flat = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Datos que aún faltan para cerrar el pedido (para BuilderBot y el panel). */
function missingData(state: BotState) {
  if (!state.cart.length) return ["producto"];
  return [
    !state.firstName || !state.lastName ? "nombre" : "",
    !state.phone ? "celular" : "",
    !state.city ? "ciudad" : "",
    !state.street ? "direccion" : "",
    !state.paymentMethod ? "pago" : "",
  ].filter(Boolean);
}

function emptyResponse(route: string, decision: string, message: string, success = true) {
  return {
    success,
    intencion: "conversar",
    route,
    message,
    step: "idle",
    decision,
    readyToCheckout: false,
    orderNumber: "",
    paymentMethod: "",
    paymentLink: "",
    total: null,
    cart: [],
    missingData: [],
    targetEndpoint: "/api/whatsapp-bot/brain",
  };
}

const NO_PHONE_MESSAGE =
  "No logré leer tu número de WhatsApp 🙏 Escríbenos de nuevo en un momento.";
const ERROR_MESSAGE =
  "Dame un segundito 🙏 Se me cruzaron los cables con ese mensaje, me lo repites? 😅";

export const errorResponse = () => emptyResponse("conversation", "error", ERROR_MESSAGE, false);
export const unauthorizedResponse = () =>
  emptyResponse("conversation", "token invalido", "", false);

function toBotResponse(result: TurnResult) {
  const state = result.state;
  return {
    success: true,
    intencion: result.intent,
    route: result.route,
    // Nunca vacío: BuilderBot mandaría un mensaje en blanco.
    message: casualMarks(result.reply || ASK_PRODUCT),
    step: result.step,
    decision: result.decision,
    readyToCheckout: result.step === "confirm",
    orderNumber: result.orderNumber || state.orderNumber || "",
    paymentMethod: result.paymentMethod || state.paymentMethod || "",
    paymentLink: result.paymentLink || "",
    // Centavos, como el resto del API de Kova.
    total: result.total ?? null,
    cart: state.cart.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      name: line.variantName ? `${line.title} (${line.variantName})` : line.title,
      quantity: line.quantity,
      price: line.unitPrice,
    })),
    missingData: missingData(state),
    telefonoSoporte: env.BOT_SUPPORT_PHONE,
    targetEndpoint: "/api/whatsapp-bot/brain",
  };
}

// ─── /brain ──────────────────────────────────────────────────────────────────

/** Solo DECIDE a qué flujo va el mensaje; no responde ni toca el pedido. */
export async function decide(body: any) {
  const startedAt = Date.now();
  const phone = readPhone(body);
  const message = readMessage(body);
  const mediaUrl = readMediaUrl(body);
  if (!phone) return emptyResponse("conversation", "sin telefono", "", false);
  if (isResetKeyword(message)) return emptyResponse("conversation", "reinicio", "");

  const session: any = await WhatsappSession.findOne(
    { phone },
    { state: 1, silencedUntil: 1 },
  ).lean();
  const silenced = Boolean(
    session?.silencedUntil && new Date(session.silencedUntil).getTime() > Date.now(),
  );
  const { route, reason } = decideRoute(session?.state, {
    message,
    mediaUrl,
    mediaEvent: Boolean(mediaEventKind(body)),
    silenced,
  });
  const step = session?.state?.stage || "idle";
  console.log(
    `[bot] ${phone} 🧠 /brain → ${route} (${reason}) ${Date.now() - startedAt}ms | 👤 ${oneLine(message || (mediaUrl ? "[archivo]" : ""))}`,
  );
  logBotEvent({
    phone,
    endpoint: "brain",
    kind: "decision",
    route,
    decision: reason,
    step,
    message: message || (mediaUrl ? "[archivo adjunto]" : ""),
    mediaUrl,
    durationMs: Date.now() - startedAt,
  });
  return { ...emptyResponse(route, reason, ""), step, targetEndpoint: FLOW_PATHS[route] };
}

// ─── Turno completo ──────────────────────────────────────────────────────────

/** Toma el candado del teléfono (y crea la sesión si no existe) de forma atómica. */
async function acquireTurnLock(phone: string): Promise<any | null> {
  const deadline = Date.now() + TURN_WAIT_MS;
  for (;;) {
    const now = new Date();
    try {
      const session = await WhatsappSession.findOneAndUpdate(
        { phone, $or: [{ turnLockUntil: null }, { turnLockUntil: { $lt: now } }] },
        { $set: { turnLockUntil: new Date(now.getTime() + TURN_LOCK_MS) } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      if (session) return session;
    } catch (error: any) {
      // E11000: la sesión existe con el candado tomado (el upsert intentó crear otra).
      if (error?.code !== 11000) throw error;
    }
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
}

const turnHash = (message: string, mediaUrl: string) =>
  crypto.createHash("sha1").update(`${message}|${mediaUrl}`).digest("hex");

type TurnOutcome = TurnResult & { duplicated?: boolean };

async function runTurn(body: any, phone: string): Promise<TurnOutcome> {
  const arrivedAt = Date.now();
  const message = readMessage(body);
  const mediaUrl = readMediaUrl(body);

  if (isResetKeyword(message)) {
    await WhatsappSession.replaceOne(
      { phone },
      { phone, history: [], state: null },
      { upsert: true },
    );
    const state = createInitialState();
    return {
      state,
      reply: "Listo, empezamos de cero 🔄 Cuéntame qué estás buscando 😊",
      route: "conversation",
      intent: "conversar",
      step: "idle",
      decision: "R0:reinicio",
    };
  }

  const session = await acquireTurnLock(phone);
  if (!session) {
    const state = createInitialState();
    return {
      state,
      reply: "Estoy terminando de procesar tu mensaje anterior. Dame unos segundos 🙏",
      route: "conversation",
      intent: "conversar",
      step: state.stage,
      decision: "R0:ocupado",
    };
  }

  let released = false;
  try {
    // BuilderBot reintenta si la respuesta tarda: el mismo mensaje dentro de 5 s
    // recibe la misma respuesta y no crea otro pedido. "pagado" siempre se
    // vuelve a verificar (verificar dos veces nunca cobra dos veces).
    const hash = turnHash(message, mediaUrl);
    const lastAt = session.lastMessageAt ? new Date(session.lastMessageAt).getTime() : 0;
    if (
      session.lastResponse &&
      session.lastMessageHash === hash &&
      !claimsPaid(message) &&
      arrivedAt - lastAt < RETRY_WINDOW_MS
    ) {
      await WhatsappSession.updateOne({ phone }, { $set: { turnLockUntil: null } });
      released = true;
      return {
        ...(session.lastResponse as TurnResult),
        decision: "R0:duplicado",
        duplicated: true,
      };
    }

    const previous = { ...createInitialState(), ...(session.state || {}) } as BotState;
    const history = [...(session.history || [])];
    // Contexto para la IA: el {history} de BuilderBot si llega (incluye lo que
    // escribió un asesor a mano); si no, el historial guardado por teléfono.
    const recent =
      builderBotHistory(body?.history) ||
      history
        .slice(-8)
        .map(
          (entry: any) =>
            `${entry.role === "user" ? "Cliente" : "Bot"}: ${String(entry.content).slice(0, 400)}`,
        )
        .join("\n");

    const result = await handleTurn(
      previous,
      {
        message,
        mediaUrl: mediaUrl || undefined,
        mediaWithoutUrl: !mediaUrl && Boolean(mediaEventKind(body)),
        mediaEvent: mediaEventKind(body),
        history: recent,
      },
      await buildDeps(phone, previous.phone),
    );

    // Voz con IA: el mismo contenido dicho distinto cada vez. El saludo y la
    // respuesta "sí, soy un bot" (transparencia de Meta) van tal cual.
    const verbatim = ["R9:saludo", "R2:soy_un_bot", "R0:no_escribir"].some((prefix) =>
      result.decision.startsWith(prefix),
    );
    if (geminiEnabled() && env.BOT_AI_VOICE !== "off" && !verbatim) {
      const lastBotMessages = history
        .filter((entry: any) => entry.role === "assistant")
        .slice(-3)
        .map((entry: any) => String(entry.content));
      result.reply = await naturalize(result.reply, lastBotMessages);
    }

    const userEntry = message || (mediaUrl ? "[archivo adjunto]" : "");
    if (userEntry)
      history.push({
        role: "user",
        content: userEntry.slice(0, 2000),
        ...(mediaUrl ? { mediaUrl } : {}),
        createdAt: new Date(),
      });
    history.push({
      role: "assistant",
      content: result.reply.slice(0, 2000),
      createdAt: new Date(),
    });

    const human = result.route === "human";
    await WhatsappSession.updateOne(
      { phone },
      {
        $set: {
          state: JSON.parse(JSON.stringify(result.state)),
          history: history.slice(-30),
          lastMessageHash: hash,
          lastMessageAt: new Date(),
          lastResponse: JSON.parse(JSON.stringify(result)),
          turnLockUntil: null,
          // El flujo "Asesor humano" de BuilderBot pausa 60 min; /brain respeta lo mismo.
          ...(human
            ? {
                silencedUntil: new Date(Date.now() + HUMAN_SILENCE_MS),
                humanRequestedAt: new Date(),
              }
            : {}),
        },
      },
    );
    released = true;
    return result;
  } finally {
    if (!released)
      await WhatsappSession.updateOne({ phone }, { $set: { turnLockUntil: null } }).catch(() => {});
  }
}

/** Endpoints de los flujos destino: procesan el mensaje completo y responden en `message`. */
export async function turn(body: any, endpoint: string) {
  const startedAt = Date.now();
  const phone = readPhone(body);
  const mediaUrl = readMediaUrl(body);
  const message = readMessage(body) || (mediaUrl ? "[archivo adjunto]" : "");
  if (!phone) {
    console.warn(
      "[whatsapp-bot] mensaje sin teléfono. Revisa que el nodo HTTP mande phone = {from}",
    );
    return emptyResponse("conversation", "sin telefono", NO_PHONE_MESSAGE, false);
  }
  try {
    const result = await runTurn(body, phone);
    if (result.route === "human" && !result.duplicated) {
      logBotEvent({
        phone,
        endpoint,
        kind: "human_request",
        route: "human",
        decision: result.decision,
        step: result.step,
        message,
        reply: result.reply,
        mediaUrl,
      });
      // Sin await: el correo al equipo no debe demorar la respuesta al cliente.
      void notifyHumanRequest({
        phone,
        name: `${result.state.firstName || ""} ${result.state.lastName || ""}`.trim(),
        message,
        reply: result.reply,
      });
    }
    console.log(
      `[bot] ${phone} /${endpoint} → ${result.route} ${result.decision} paso=${result.step}${result.orderNumber ? ` ${result.orderNumber}` : ""} ${Date.now() - startedAt}ms | 👤 ${oneLine(message)} | 🤖 ${oneLine(result.reply)}`,
    );
    logBotEvent({
      phone,
      endpoint,
      kind: "turn",
      route: result.route,
      decision: result.decision,
      step: result.step,
      message,
      reply: result.reply,
      mediaUrl,
      orderNumber: result.orderNumber || "",
      paymentLink: result.paymentLink || "",
      duplicated: Boolean(result.duplicated),
      durationMs: Date.now() - startedAt,
    });
    return toBotResponse(result);
  } catch (error: any) {
    console.error(`[bot] ${phone} /${endpoint} ❌ ERROR | 👤 ${oneLine(message)} |`, error);
    logBotEvent({
      phone,
      endpoint,
      kind: "error",
      message,
      error: error?.message || String(error),
      durationMs: Date.now() - startedAt,
    });
    return errorResponse();
  }
}

/** /media sin archivo ni texto: no hay nada que procesar. */
export async function media(body: any, endpoint: string) {
  if (!readMediaUrl(body) && !readMessage(body) && !mediaEventKind(body)) {
    return emptyResponse(
      "conversation",
      "sin archivo",
      "Uy, no logré abrir tu archivo 😕 Me reenvías la foto? 📸",
      false,
    );
  }
  return turn(body, endpoint);
}

/** /catalog: con mensaje corre el turno; sin mensaje, solo el resumen del catálogo. */
export async function catalog(body: any) {
  if (readMessage(body) && readPhone(body)) return turn(body, "catalog");
  return {
    ...emptyResponse("catalog", "catalogo", catalogOverview(await loadCatalog(), storeUrl())),
    intencion: "menu",
  };
}
