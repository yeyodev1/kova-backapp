import { Resend } from "resend";
import { env } from "../config/env";

let resend: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(env.RESEND_API_KEY);
  return resend;
}

/**
 * Envía un correo desde `RESEND_FROM_EMAIL`. Nunca lanza: el fallo de un correo no debe
 * romper el flujo que lo disparó (una compra, un registro). Devuelve si Resend lo aceptó.
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  replyTo?: string,
): Promise<boolean> {
  const client = getClient();
  if (!client) {
    console.warn(`[email] RESEND_API_KEY no definida — no se envió "${subject}" a ${to}`);
    return false;
  }

  try {
    const { error } = await client.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to,
      subject,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    if (error) {
      console.error(`[email] Resend rechazó "${subject}" a ${to}:`, error);
      return false;
    }
    console.info(`[email] enviado "${subject}" a ${to}`);
    return true;
  } catch (error) {
    console.error(`[email] falló "${subject}" a ${to}:`, error);
    return false;
  }
}

// ── Plantilla ───────────────────────────────────────────────────────────────

export const BRAND = {
  moss: "#1f3329",
  accent: "#4a6e58",
  paper: "#edf1ec",
  ink: "#1d2420",
  muted: "#6b746e",
  line: "#dfe5df",
  logo: "https://kovashopper.com/logo.jpg",
};

/** Todo texto que viene del cliente o del pedido pasa por aquí antes de ir al HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Botón "a prueba de Outlook": tabla con fondo en la celda, no solo en el enlace. */
export function emailButton(label: string, url: string, color: string = BRAND.moss): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 8px 0 0;display:inline-table">
    <tr><td align="center" bgcolor="${color}" style="background:${color};border-radius:999px">
      <a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:999px">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

export function paragraph(html: string): string {
  return `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:${BRAND.ink}">${html}</p>`;
}

/** Recuadro gris para datos (guía, cuenta bancaria, dirección). */
export function infoBox(html: string): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 16px">
    <tr><td style="background:${BRAND.paper};border-radius:12px;padding:14px 16px;font-size:14px;line-height:1.6;color:${BRAND.ink}">${html}</td></tr>
  </table>`;
}

interface LayoutOptions {
  /** Texto que el cliente de correo muestra junto al asunto. */
  preheader?: string;
  /** Línea extra del pie (p. ej. el WhatsApp de la tienda). */
  footer?: string;
}

/** Plantilla base: encabezado musgo con logo, tarjeta blanca y pie. HTML de correo (tablas e inline). */
export function layout(title: string, body: string, options: LayoutOptions = {}): string {
  const preheader = options.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(options.preheader)}</div>`
    : "";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.paper}">
  ${preheader}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.paper};padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid ${BRAND.line}">
        <tr><td bgcolor="${BRAND.moss}" style="background:${BRAND.moss};padding:18px 28px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="padding-right:12px"><img src="${BRAND.logo}" width="40" height="40" alt="Kova" style="display:block;border-radius:10px;border:0"></td>
            <td style="color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:0.5px">Kova</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:28px 28px 8px">
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${BRAND.moss}">${escapeHtml(title)}</h1>
          ${body}
        </td></tr>
        <tr><td style="padding:20px 28px 24px;border-top:1px solid ${BRAND.line};color:${BRAND.muted};font-size:12px;line-height:1.6">
          ${options.footer ? `${options.footer}<br>` : ""}
          © ${new Date().getFullYear()} Kova · Envíos a todo Ecuador ·
          <a href="https://kovashopper.com" style="color:${BRAND.accent}">kovashopper.com</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
