import crypto from "crypto";
import { env } from "../config/env";
import { normalizeEcPhone } from "../utils/phone";

/**
 * API de Conversiones de Meta: el servidor reporta cada compra de la web aunque el navegador
 * tenga bloqueador o el iPhone corte el píxel. El event_id es el número de pedido, el mismo que
 * manda el píxel, así Meta cuenta la venta una sola vez.
 *
 * Sin META_PIXEL_ID o META_CAPI_TOKEN no hace nada. Nunca lanza: un fallo de Meta no puede
 * romper un pedido.
 */

const GRAPH_VERSION = "v23.0";
const TIMEOUT_MS = 4000;

/** Datos del navegador que se guardan al crear el pedido (la tarjeta se confirma después). */
export interface AdTracking {
  ip?: string;
  userAgent?: string;
  fbp?: string;
  fbc?: string;
  sourceUrl?: string;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Solo lo que sirve para Meta y con forma esperada: el body del cliente no es confiable. */
export function parseAdTracking(raw: any, ip: unknown, userAgent: unknown): AdTracking {
  const fbp = str(raw?.fbp, 200);
  const fbc = str(raw?.fbc, 500);
  return {
    ip: str(ip, 100),
    userAgent: str(userAgent, 500),
    fbp: /^fb\.\d\.\d+\.\d+$/.test(fbp) ? fbp : "",
    fbc: /^fb\.\d\.\d+\./.test(fbc) ? fbc : "",
    sourceUrl: /^https:\/\//.test(str(raw?.sourceUrl, 1000)) ? str(raw?.sourceUrl, 1000) : "",
  };
}

function hash(value: string): string | undefined {
  const clean = value.trim().toLowerCase();
  return clean ? crypto.createHash("sha256").update(clean).digest("hex") : undefined;
}

/** Meta pide el teléfono con código de país y sin "+": 0997011366 → 593997011366. */
function hashPhone(phone: unknown): string | undefined {
  const local = normalizeEcPhone(phone);
  return local ? hash(`593${local.slice(1)}`) : undefined;
}

function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}

export async function sendPurchase(order: any): Promise<void> {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return;
  // El bot de WhatsApp no pasa por la web: esas ventas no tienen clic del píxel que atribuir.
  if (order?.channel && order.channel !== "web") return;

  const tracking: AdTracking = order.adTracking ?? {};
  const items: any[] = Array.isArray(order.items) ? order.items : [];
  const event = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: String(order.number),
    action_source: "website",
    event_source_url: tracking.sourceUrl || `${env.PUBLIC_WEB_URL}/checkout`,
    user_data: compact({
      ph: hashPhone(order.customer?.phone),
      em: hash(String(order.customer?.email ?? "")),
      fn: hash(String(order.customer?.firstName ?? "")),
      ln: hash(String(order.customer?.lastName ?? "")),
      ct: hash(String(order.address?.city ?? "").replace(/\s+/g, "")),
      country: hash("ec"),
      external_id: hashPhone(order.customer?.phone),
      client_ip_address: tracking.ip,
      client_user_agent: tracking.userAgent,
      fbp: tracking.fbp,
      fbc: tracking.fbc,
    }),
    custom_data: {
      currency: "USD",
      value: Number(order.total ?? 0) / 100,
      order_id: String(order.number),
      content_type: "product",
      content_ids: items.map((item) => String(item.product)),
      contents: items.map((item) => ({ id: String(item.product), quantity: item.quantity })),
      num_items: items.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
    },
  };

  const body: Record<string, unknown> = { data: [event] };
  if (env.META_CAPI_TEST_CODE) body.test_event_code = env.META_CAPI_TEST_CODE;

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) console.error(`[meta-capi] ${order.number} falló (${res.status}):`, await res.text());
  } catch (error: any) {
    console.error(`[meta-capi] ${order.number} no se pudo enviar:`, error?.message);
  }
}
