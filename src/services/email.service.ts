import { Resend } from "resend";
import { env } from "../config/env";

let resend: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(env.RESEND_API_KEY);
  return resend;
}

/**
 * Envía un correo. Nunca lanza: el fallo de un correo no debe romper el
 * flujo que lo disparó (una compra, un registro). Devuelve si Resend lo aceptó.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const client = getClient();
  if (!client) {
    console.warn(`[email] RESEND_API_KEY no definida — no se envió "${subject}" a ${to}`);
    return false;
  }

  try {
    const { error } = await client.emails.send({ from: env.RESEND_FROM_EMAIL, to, subject, html });
    if (error) {
      console.error("[email] Resend rechazó el envío:", error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[email] send failed:", error);
    return false;
  }
}

/** Plantilla base: tarjeta blanca centrada con encabezado de marca. */
export function layout(title: string, body: string): string {
  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;font-family:Arial,Helvetica,sans-serif">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden">
        <tr><td style="background:#111;color:#fff;padding:20px 32px;font-size:18px;font-weight:bold">Kova</td></tr>
        <tr><td style="padding:32px;color:#111;font-size:15px;line-height:1.6">
          <h1 style="margin:0 0 16px;font-size:22px">${title}</h1>
          ${body}
        </td></tr>
        <tr><td style="padding:16px 32px;color:#71717a;font-size:12px">© ${new Date().getFullYear()} Kova</td></tr>
      </table>
    </td></tr>
  </table>`;
}

// ── Pedidos ─────────────────────────────────────────────────────────────────

const PAYMENT_LABELS: Record<string, string> = {
  card: "Tarjeta",
  cod: "Pago contra entrega",
  transfer: "Transferencia bancaria",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(cents: number): string {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

function orderSummary(order: any): string {
  const rows = (order.items || [])
    .map(
      (item: any) => `
      <tr>
        <td style="padding:6px 0">${escapeHtml(item.title)}${item.variantName ? ` · ${escapeHtml(item.variantName)}` : ""} × ${item.quantity}</td>
        <td style="padding:6px 0;text-align:right">${money(item.total)}</td>
      </tr>`,
    )
    .join("");
  const extra = (label: string, cents: number) =>
    cents
      ? `<tr><td style="padding:4px 0;color:#71717a">${label}</td><td style="padding:4px 0;text-align:right;color:#71717a">${money(cents)}</td></tr>`
      : "";
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;margin:16px 0">
      ${rows}
      ${extra("Envío", order.shippingFee)}
      ${extra("Recargo por método de pago", order.surcharge)}
      <tr><td style="padding:8px 0;font-weight:bold">Total</td><td style="padding:8px 0;text-align:right;font-weight:bold">${money(order.total)}</td></tr>
    </table>
    <p style="margin:0;color:#52525b">Entrega en: ${escapeHtml(order.address?.street)}, ${escapeHtml(order.address?.city)}, ${escapeHtml(order.address?.province)}</p>
    <p style="margin:4px 0 0;color:#52525b">Método de pago: ${PAYMENT_LABELS[order.paymentMethod] || escapeHtml(order.paymentMethod)}</p>`;
}

function trackLink(order: any): string {
  const url = `${env.FRONTEND_URL}/rastrear?number=${encodeURIComponent(order.number)}&phone=${encodeURIComponent(order.customer?.phone || "")}`;
  return `<p style="margin:24px 0 0"><a href="${url}" style="background:#111;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;display:inline-block">Ver mi pedido</a></p>`;
}

/** Pedido recibido. Solo si el cliente dejó correo. */
export async function sendOrderReceivedEmail(order: any): Promise<boolean> {
  const to = order?.customer?.email;
  if (!to) return false;
  const next =
    order.paymentMethod === "transfer"
      ? "Para despacharlo, sube el comprobante de tu transferencia desde la página de tu pedido."
      : order.paymentMethod === "cod"
        ? "Pagas al recibirlo. Te avisaremos cuando salga a despacho."
        : "Apenas se confirme el pago lo preparamos para despacho.";
  const body = `
    <p style="margin:0">Hola ${escapeHtml(order.customer.firstName)}, recibimos tu pedido <strong>${escapeHtml(order.number)}</strong>.</p>
    <p style="margin:8px 0 0">${next}</p>
    ${orderSummary(order)}
    ${trackLink(order)}`;
  return sendEmail(
    to,
    `Recibimos tu pedido ${order.number}`,
    layout("¡Gracias por tu compra!", body),
  );
}

/** Pago confirmado (tarjeta o transferencia). Solo si el cliente dejó correo. */
export async function sendPaymentConfirmedEmail(order: any): Promise<boolean> {
  const to = order?.customer?.email;
  if (!to) return false;
  const body = `
    <p style="margin:0">Hola ${escapeHtml(order.customer.firstName)}, confirmamos el pago de tu pedido <strong>${escapeHtml(order.number)}</strong>.</p>
    <p style="margin:8px 0 0">Ya lo estamos preparando para despacho. Te compartiremos la guía cuando salga.</p>
    ${orderSummary(order)}
    ${trackLink(order)}`;
  return sendEmail(to, `Pago confirmado · ${order.number}`, layout("Pago confirmado", body));
}
