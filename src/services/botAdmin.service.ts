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
      duplicated: event.duplicated,
      durationMs: event.durationMs,
      error: event.error,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
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
  const now = Date.now();
  return {
    items: sessions.map((session: any) => {
      const state = session.state || {};
      const cart = state.cart || [];
      const last = session.history?.[0];
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
          session.silencedUntil && new Date(session.silencedUntil).getTime() > now
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
    }),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
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
