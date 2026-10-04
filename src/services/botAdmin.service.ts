import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { BotEvent } from "../models/botEvent.model";
import { WhatsappSession } from "../models/whatsappSession.model";
import { geminiEnabled } from "./gemini.service";
import { toSessionPhone } from "./whatsappBot/input";

/**
 * Panel del bot: bitácora, sesiones y la guía de configuración de BuilderBot.
 * Reiniciar o silenciar una sesión nunca toca los pedidos.
 */

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function paging(query: Record<string, unknown>, defaultLimit: number) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || defaultLimit)));
  return { page, limit, skip: (page - 1) * limit };
}

/** El panel puede mandar "0991234567", "+593 99…" o "lid:…". */
const sessionKey = (raw: unknown) => toSessionPhone(String(raw ?? "")) || String(raw ?? "").trim();

/** GET /whatsapp-bot/admin/events?phone&page&errors=1 */
export async function listEvents(query: Record<string, unknown>) {
  const { page, limit, skip } = paging(query, 50);
  const filter: Record<string, unknown> = {};
  if (query.phone) filter.phone = sessionKey(query.phone);
  if (query.errors === "1" || query.errors === "true") filter.kind = "error";
  if (typeof query.kind === "string" && query.kind && !filter.kind) filter.kind = query.kind;
  const [items, total] = await Promise.all([
    BotEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    BotEvent.countDocuments(filter),
  ]);
  return {
    items: items.map((event: any) => ({
      _id: event._id,
      createdAt: event.createdAt,
      phone: event.phone,
      endpoint: event.endpoint,
      kind: event.kind,
      route: event.route,
      decision: event.decision,
      step: event.step,
      message: event.message,
      reply: event.reply,
      mediaUrl: event.mediaUrl,
      orderNumber: event.orderNumber,
      paymentLink: event.paymentLink || "",
      duplicated: event.duplicated,
      durationMs: event.durationMs,
      error: event.error,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

/** Resumen de una sesión para el panel (tarjeta de /sessions y encabezado del chat). */
function summarizeSession(session: any, last: any) {
  const state = session.state || {};
  const cart = state.cart || [];
  return {
    phone: session.phone,
    customerName: [state.firstName, state.lastName].filter(Boolean).join(" "),
    stage: state.stage || "idle",
    cart: {
      items: cart.reduce((sum: number, line: any) => sum + (Number(line.quantity) || 0), 0),
      total: cart.reduce((sum: number, line: any) => sum + (Number(line.total) || 0), 0),
      summary: cart
        .map(
          (line: any) =>
            `${line.quantity} × ${line.title}${line.variantName ? ` (${line.variantName})` : ""}`,
        )
        .join(", "),
    },
    paymentMethod: state.paymentMethod || null,
    orderNumber: state.orderNumber || "",
    silencedUntil:
      session.silencedUntil && new Date(session.silencedUntil).getTime() > Date.now()
        ? session.silencedUntil
        : null,
    optOut: Boolean(state.optOut),
    humanRequested: Boolean(session.humanRequestedAt),
    humanRequestedAt: session.humanRequestedAt || null,
    lastMessage: last
      ? {
          role: last.role,
          content: last.content,
          hasMedia: Boolean(last.mediaUrl),
          at: last.createdAt,
        }
      : null,
    updatedAt: session.updatedAt,
  };
}

/** GET /whatsapp-bot/admin/sessions?page&q */
export async function listSessions(query: Record<string, unknown>) {
  const { page, limit, skip } = paging(query, 30);
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 60) : "";
  const filter: Record<string, unknown> = {};
  if (q) {
    const digits = q.replace(/\D/g, "");
    const key = sessionKey(q);
    filter.$or = [
      ...(digits
        ? [
            { phone: { $regex: escapeRegex(digits.replace(/^593/, "").replace(/^0/, "")) } },
            { phone: key },
          ]
        : []),
      { "state.firstName": { $regex: escapeRegex(q), $options: "i" } },
      { "state.lastName": { $regex: escapeRegex(q), $options: "i" } },
      { "state.orderNumber": { $regex: escapeRegex(q), $options: "i" } },
    ];
  }
  const [sessions, total] = await Promise.all([
    WhatsappSession.find(filter, {
      history: { $slice: -1 },
      phone: 1,
      state: 1,
      silencedUntil: 1,
      humanRequestedAt: 1,
      updatedAt: 1,
      createdAt: 1,
    })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    WhatsappSession.countDocuments(filter),
  ]);
  return {
    items: sessions.map((session: any) => summarizeSession(session, session.history?.[0])),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

// ── Conversación completa (chat del panel) ──────────────────────────────────

/** Un /brain y el flujo que lo atiende llegan con segundos de diferencia. */
const BRAIN_PAIR_MS = 2 * 60_000;
/** Ventana para reconocer en el historial un mensaje que ya está en la bitácora. */
const HISTORY_MATCH_MS = 5 * 60_000;
const FILE_PLACEHOLDER = "[archivo adjunto]";

export type ConversationRole = "client" | "bot" | "system";
export type ConversationSystemKind =
  | "order_created"
  | "payment_link"
  | "receipt"
  | "payment_confirmed"
  | "human_request"
  | "silenced"
  | "duplicated"
  | "error";

export interface ConversationMeta {
  endpoint: string;
  route: string;
  decision: string;
  step: string;
  ms: number;
  error: string;
  orderNumber: string;
  paymentLink: string;
  duplicated?: boolean;
  /** Lo que decidió /brain antes de llamar al flujo. */
  brain?: { route: string; decision: string; step: string; ms: number };
}

export interface ConversationMessage {
  id: string;
  at: Date;
  role: ConversationRole;
  text: string;
  mediaUrl?: string;
  kind?: ConversationSystemKind;
  meta?: ConversationMeta;
  /** "history" cuando el turno no está en la bitácora y sale del historial de la sesión. */
  source: "event" | "history";
}

const brainMeta = (event: any) => ({
  route: event.route || "",
  decision: event.decision || "",
  step: event.step || "",
  ms: event.durationMs || 0,
});

const eventMeta = (event: any, brain?: any): ConversationMeta => ({
  endpoint: event.endpoint || "",
  route: event.route || "",
  decision: event.decision || "",
  step: event.step || "",
  ms: event.durationMs || 0,
  error: event.error || "",
  orderNumber: event.orderNumber || "",
  paymentLink: event.paymentLink || "",
  ...(event.duplicated ? { duplicated: true } : {}),
  ...(brain ? { brain: brainMeta(brain) } : {}),
});

const sameText = (a: unknown, b: unknown) =>
  String(a || "")
    .trim()
    .slice(0, 300) ===
  String(b || "")
    .trim()
    .slice(0, 300);

/** Convierte la bitácora (orden cronológico) en burbujas de chat y avisos de sistema. */
function eventsToMessages(events: any[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let pendingBrain: any = null;
  let pendingHuman: any = null;
  const id = (event: any, suffix: string) => `${event._id}:${suffix}`;
  const media = (url?: string) => (url ? { mediaUrl: url } : {});

  const system = (event: any, kind: ConversationSystemKind, text: string, meta?: any) =>
    messages.push({
      id: id(event, kind),
      at: event.createdAt,
      role: "system",
      kind,
      text,
      ...(meta ? { meta } : {}),
      source: "event",
    });

  // Un /brain sin flujo después: el cliente escribió y el bot calló (silenciado) o aún procesa.
  const flushBrain = () => {
    if (!pendingBrain) return;
    const brain = pendingBrain;
    pendingBrain = null;
    messages.push({
      id: id(brain, "client"),
      at: brain.createdAt,
      role: "client",
      text: brain.message || "",
      ...media(brain.mediaUrl),
      meta: eventMeta(brain),
      source: "event",
    });
    if (brain.route === "silenced")
      system(brain, "silenced", "Bot en silencio: no respondió", eventMeta(brain));
  };

  // Se registra antes que el turno; el aviso va después de la respuesta del bot.
  const flushHuman = (after?: any) => {
    if (!pendingHuman) return;
    system(
      after ? { ...pendingHuman, createdAt: after.createdAt } : pendingHuman,
      "human_request",
      "Pidió un asesor",
      eventMeta(pendingHuman),
    );
    pendingHuman = null;
  };

  // El /brain pendiente corresponde a este turno si llegó justo antes.
  const takeBrain = (event: any) => {
    if (!pendingBrain) return null;
    const gap = new Date(event.createdAt).getTime() - new Date(pendingBrain.createdAt).getTime();
    if (gap > BRAIN_PAIR_MS) {
      flushBrain();
      return null;
    }
    const brain = pendingBrain;
    pendingBrain = null;
    return brain;
  };

  for (const event of events) {
    if (event.kind === "decision") {
      flushBrain();
      pendingBrain = event;
      continue;
    }
    if (event.kind === "human_request") {
      flushHuman();
      pendingHuman = event;
      continue;
    }
    if (event.kind === "turn" && event.duplicated) {
      // El cliente repitió el mensaje (o BuilderBot reintentó): se muestra lo que escribió, sin otra respuesta.
      const brain = takeBrain(event);
      if (brain)
        messages.push({
          id: id(brain, "client"),
          at: brain.createdAt,
          role: "client",
          text: brain.message || event.message || "",
          ...media(brain.mediaUrl || event.mediaUrl),
          source: "event",
        });
      system(
        event,
        "duplicated",
        "Mensaje repetido: el bot reenvió la misma respuesta",
        eventMeta(event, brain),
      );
      continue;
    }

    const brain = takeBrain(event);
    const clientText = event.message || brain?.message || "";
    const clientMedia = event.mediaUrl || brain?.mediaUrl || "";
    if (clientText || clientMedia)
      messages.push({
        // Mismo id que tenía como /brain suelto: el panel en vivo lo reemplaza sin duplicarlo.
        id: id(brain || event, "client"),
        at: brain?.createdAt || event.createdAt,
        role: "client",
        text: clientText,
        ...media(clientMedia),
        source: "event",
      });

    if (event.kind === "error") {
      system(
        event,
        "error",
        "Error del bot: el cliente recibió el mensaje de reintento",
        eventMeta(event, brain),
      );
      continue;
    }

    messages.push({
      id: id(event, "bot"),
      at: event.createdAt,
      role: "bot",
      text: event.reply || "",
      meta: eventMeta(event, brain),
      source: "event",
    });
    const decision = String(event.decision || "");
    if (decision.startsWith("R7:orden_creada"))
      system(
        event,
        "order_created",
        `Pedido creado ${event.orderNumber || ""}`.trim(),
        eventMeta(event),
      );
    if (event.paymentLink) system(event, "payment_link", "Link de pago enviado", eventMeta(event));
    if (decision === "R1:comprobante")
      system(event, "receipt", "Comprobante recibido", eventMeta(event));
    if (decision.startsWith("R3:pago_confirmado"))
      system(event, "payment_confirmed", "Pago confirmado", eventMeta(event));
    flushHuman(event);
  }
  flushHuman();
  flushBrain();
  return messages;
}

/** Turnos del historial de la sesión que no quedaron en la bitácora. */
function historyFallback(history: any[], events: any[], from: Date | null, to: Date | null) {
  return history
    .filter((entry) => {
      const at = new Date(entry.createdAt).getTime();
      if (from && at < from.getTime()) return false;
      if (to && at >= to.getTime()) return false;
      return !events.some((event) => {
        if (Math.abs(new Date(event.createdAt).getTime() - at) > HISTORY_MATCH_MS) return false;
        return entry.role === "user"
          ? sameText(event.message, entry.content)
          : sameText(event.reply, entry.content);
      });
    })
    .map((entry): ConversationMessage => ({
      id: `history:${new Date(entry.createdAt).getTime()}:${entry.role}`,
      at: entry.createdAt,
      role: entry.role === "user" ? "client" : "bot",
      text: entry.content || "",
      ...(entry.mediaUrl ? { mediaUrl: entry.mediaUrl } : {}),
      source: "history",
    }));
}

/**
 * GET /whatsapp-bot/admin/conversations/:phone?before&limit — chat completo con
 * lo que decidió el bot en cada turno. `limit` cuenta filas de la bitácora;
 * `nextBefore` es el `before` de la página anterior.
 */
export async function getConversation(rawPhone: unknown, query: Record<string, unknown>) {
  const phone = sessionKey(rawPhone);
  if (!phone) throw new CustomError("Falta el teléfono", 400);
  const limit = Math.min(200, Math.max(1, Math.floor(Number(query.limit) || 50)));
  let before: Date | null = null;
  if (query.before) {
    before = new Date(String(query.before));
    if (Number.isNaN(before.getTime()))
      throw new CustomError("La fecha 'before' no es válida", 400);
  }

  const [session, newest]: [any, any[]] = await Promise.all([
    WhatsappSession.findOne(
      { phone },
      { phone: 1, state: 1, history: 1, silencedUntil: 1, humanRequestedAt: 1, updatedAt: 1 },
    ).lean(),
    BotEvent.find({ phone, ...(before ? { createdAt: { $lt: before } } : {}) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
  ]);
  if (!session && !newest.length && !before)
    throw new CustomError("No hay conversación con ese número", 404);

  // Que el /brain de un turno no quede en otra página que su respuesta.
  const oldest = newest[newest.length - 1];
  if (oldest && oldest.kind !== "decision") {
    const brain = await BotEvent.findOne({
      phone,
      kind: "decision",
      createdAt: {
        $lt: oldest.createdAt,
        $gte: new Date(new Date(oldest.createdAt).getTime() - BRAIN_PAIR_MS),
      },
    })
      .sort({ createdAt: -1 })
      .lean();
    if (brain) newest.push(brain);
  }
  const events = newest.reverse();
  const from: Date | null = events.length ? events[0].createdAt : null;
  const hasMore = from
    ? Boolean(await BotEvent.exists({ phone, createdAt: { $lt: from } }))
    : false;

  const history = session?.history || [];
  const messages = [
    ...eventsToMessages(events),
    // Sin más bitácora atrás, esta página se queda con todo el historial anterior.
    ...historyFallback(history, events, hasMore ? from : null, before),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return {
    phone,
    session: session ? summarizeSession(session, history[history.length - 1]) : null,
    messages,
    hasMore,
    nextBefore: hasMore && from ? new Date(from).toISOString() : null,
  };
}

async function findSession(rawPhone: unknown) {
  const phone = sessionKey(rawPhone);
  const session = await WhatsappSession.findOne({ phone });
  if (!session) throw new CustomError("No hay conversación con ese número", 404);
  return session;
}

/** POST /admin/sessions/:phone/reset — vacía carrito y paso. Los pedidos no se tocan. */
export async function resetSession(rawPhone: unknown) {
  const session = await findSession(rawPhone);
  await WhatsappSession.updateOne(
    { _id: session._id },
    {
      $set: {
        state: null,
        lastResponse: null,
        lastMessageHash: "",
        turnLockUntil: null,
        silencedUntil: null,
      },
    },
  );
  return { ok: true, phone: session.phone };
}

/** POST /admin/sessions/:phone/silence — { minutes } (1..1440, por defecto 60). */
export async function silenceSession(rawPhone: unknown, rawMinutes: unknown) {
  const session = await findSession(rawPhone);
  const minutes = Math.min(1440, Math.max(1, Math.floor(Number(rawMinutes) || 60)));
  const silencedUntil = new Date(Date.now() + minutes * 60_000);
  await WhatsappSession.updateOne({ _id: session._id }, { $set: { silencedUntil } });
  return { ok: true, phone: session.phone, silencedUntil };
}

export async function unsilenceSession(rawPhone: unknown) {
  const session = await findSession(rawPhone);
  await WhatsappSession.updateOne({ _id: session._id }, { $set: { silencedUntil: null } });
  return { ok: true, phone: session.phone, silencedUntil: null };
}

const API_BASE = "https://api.kovashopper.com/api/whatsapp-bot";

/** GET /admin/config — guía de configuración de BuilderBot para el panel. */
export function getConfig() {
  const body = {
    rawMessage: "{body}",
    phone: "{from}",
    history: "{history}",
    urlTempFile: "{urlTempFile}",
  };
  return {
    botName: env.BOT_NAME,
    aiEnabled: geminiEnabled(),
    aiModel: env.GEMINI_MODEL,
    aiVoice: geminiEnabled() && env.BOT_AI_VOICE !== "off",
    secretRequired: Boolean(env.WHATSAPP_BOT_SECRET),
    supportPhone: env.BOT_SUPPORT_PHONE,
    payLinkBase: `${env.PUBLIC_WEB_URL.replace(/\/$/, "")}/pagar/`,
    body,
    headers: env.WHATSAPP_BOT_SECRET
      ? { "Content-Type": "application/json", "X-Bot-Token": "(WHATSAPP_BOT_SECRET)" }
      : { "Content-Type": "application/json" },
    endpoints: [
      {
        name: "brain",
        method: "POST",
        url: `${API_BASE}/brain`,
        use: "Flujo principal: solo decide la ruta (Enviar al cliente APAGADO)",
      },
      {
        name: "conversation",
        method: "POST",
        url: `${API_BASE}/conversation`,
        use: "Conversación, búsqueda, datos y pedidos",
      },
      { name: "catalog", method: "POST", url: `${API_BASE}/catalog`, use: "Catálogo" },
      {
        name: "checkout",
        method: "POST",
        url: `${API_BASE}/checkout`,
        use: "Confirmar pedido (tarjeta y transferencia) y recibir fotos",
      },
      {
        name: "human",
        method: "POST",
        url: `${API_BASE}/human`,
        use: "Pasar a un asesor (luego Silenciar 60 min)",
      },
      {
        name: "search-order",
        method: "POST",
        url: `${API_BASE}/search-order`,
        use: "Extra: estado de pedidos",
      },
      {
        name: "media",
        method: "POST",
        url: `${API_BASE}/media`,
        use: "Extra: fotos y PDF (alias /transfer-receipt)",
      },
    ],
    flows: [
      {
        flow: "🧠 Principal",
        event: "GENERAL",
        endpoint: `${API_BASE}/brain`,
        sendToClient: false,
        after: "Rules por route",
      },
      {
        flow: "💬 Conversación",
        event: "ACCIÓN",
        endpoint: `${API_BASE}/conversation`,
        sendToClient: true,
        after: "Sin Rules",
      },
      {
        flow: "📚 Catálogo",
        event: "ACCIÓN",
        endpoint: `${API_BASE}/catalog`,
        sendToClient: true,
        after: "Sin Rules",
      },
      {
        flow: "💳 Checkout tarjeta",
        event: "ACCIÓN",
        endpoint: `${API_BASE}/checkout`,
        sendToClient: true,
        after: "Sin Rules",
      },
      {
        flow: "🏦 Checkout transferencia",
        event: "IMAGEN O VÍDEO",
        endpoint: `${API_BASE}/checkout`,
        sendToClient: true,
        after: "Sin Rules (también recibe fotos y comprobantes)",
      },
      {
        flow: "🙋 Asesor humano",
        event: "ACCIÓN",
        endpoint: `${API_BASE}/human`,
        sendToClient: true,
        after: "Paso Silenciar 60 min",
      },
    ],
    rules: [
      {
        route: "conversation",
        goTo: "💬 Conversación",
        when: "Charla, búsqueda, datos, consultas de pedido, contra entrega, eres un bot?",
      },
      { route: "catalog", goTo: "📚 Catálogo", when: "Pide el catálogo" },
      { route: "checkoutCard", goTo: "💳 Checkout tarjeta", when: "sí al resumen con tarjeta" },
      {
        route: "checkoutTransfer",
        goTo: "🏦 Checkout transferencia",
        when: "sí al resumen con transferencia, o llega una foto/PDF",
      },
      {
        route: "human",
        goTo: "🙋 Asesor humano",
        when: "Pide asesor, reclamo, garantía o devolución",
      },
      {
        route: "silenced",
        goTo: "(sin Rule)",
        when: "Un asesor atiende el chat: el bot no responde",
      },
    ],
  };
}
