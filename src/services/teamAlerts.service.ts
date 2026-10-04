import { env } from "../config/env";
import { User } from "../models/user.model";
import { emailButton, escapeHtml, infoBox, layout, paragraph, sendEmail } from "./email.service";

interface HumanRequest {
  phone: string;
  name: string;
  message: string;
  reply: string;
}

/** Qué aviso por correo se consulta: cada administrador los prende o apaga en Ajustes. */
export type TeamAlertKind = "orders" | "humanRequests";

const FLAG: Record<TeamAlertKind, string> = {
  orders: "notifyOrders",
  humanRequests: "notifyHumanRequests",
};

/** Correos de los administradores activos con ese aviso encendido (sin campo = encendido). */
export async function teamRecipients(kind: TeamAlertKind): Promise<string[]> {
  const admins = await User.find({
    accountType: "admin",
    isActive: true,
    [FLAG[kind]]: { $ne: false },
  })
    .select("email")
    .lean();
  return [...new Set(admins.map((admin: any) => String(admin.email || "").trim()).filter(Boolean))];
}

/** 09XXXXXXXX → 5939XXXXXXXX para abrir el chat con wa.me. */
export function waNumber(phone: string): string {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.startsWith("0") ? `593${digits.slice(1)}` : digits;
}

/**
 * Avisa por correo a los administradores que tienen activado el aviso (por defecto, todos)
 * cuando un cliente del bot pide una persona. Nunca lanza: un correo que falla no debe
 * cortar la respuesta del bot.
 */
export async function notifyHumanRequest(request: HumanRequest): Promise<void> {
  try {
    const recipients = await teamRecipients("humanRequests");
    if (!recipients.length) return;

    const who = request.name.trim() || "Un cliente";
    const chatUrl = `https://wa.me/${waNumber(request.phone)}`;
    const panelUrl = `${env.FRONTEND_URL.replace(/\/+$/, "")}/admin/bot`;
    const html = layout(
      "Un cliente pide un asesor",
      paragraph(
        `<strong>${escapeHtml(who)}</strong> (${escapeHtml(request.phone)}) quiere hablar con una persona. El bot quedó en pausa 60 minutos para ese chat.`,
      ) +
        paragraph(`<span style="font-size:13px;color:#6b746e">Lo que escribió:</span>`) +
        infoBox(escapeHtml(request.message || "(sin texto)")) +
        `<div style="margin:8px 0 16px">${emailButton("Responder por WhatsApp", chatUrl, "#1f9d55")}${emailButton("Ver en el panel", panelUrl)}</div>`,
      {
        preheader: `${who} quiere hablar con una persona`,
        footer:
          "Recibes este aviso porque lo tienes activado en Panel → Ajustes → Avisos por correo (Asesor).",
      },
    );
    const subject = `Asesor solicitado: ${who} · ${request.phone}`;
    await Promise.all(recipients.map((to) => sendEmail(to, subject, html)));
  } catch (error: any) {
    console.error("[alertas] no se pudo avisar del asesor:", error?.message);
  }
}

interface IncidentAlert {
  _id: unknown;
  number: string;
  title: string;
  detail?: string;
  orderNumber?: string;
  order?: unknown;
  phone?: string;
  customerName?: string;
}

/**
 * Incidencia de severidad alta recién abierta: aviso a los administradores con el aviso
 * de pedidos encendido. Solo la primera vez (las repeticiones suman "×N" en el panel).
 * Nunca lanza.
 */
export async function notifyIncident(incident: IncidentAlert): Promise<void> {
  try {
    const recipients = await teamRecipients("orders");
    if (!recipients.length) return;

    const base = env.FRONTEND_URL.replace(/\/+$/, "");
    const who = [incident.customerName, incident.phone].filter(Boolean).join(" · ");
    const buttons = [
      emailButton("Ver incidencia", `${base}/admin/incidencias?id=${String(incident._id)}`),
      incident.order
        ? emailButton("Ver pedido", `${base}/admin/pedidos/${String(incident.order)}`, "#4a6e58")
        : "",
      incident.phone
        ? emailButton(
            "WhatsApp del cliente",
            `https://wa.me/${waNumber(incident.phone)}`,
            "#1f9d55",
          )
        : "",
    ].join("");
    const html = layout(
      `Incidencia ${incident.number}`,
      paragraph(`<strong>${escapeHtml(incident.title)}</strong>`) +
        (who || incident.orderNumber
          ? paragraph(
              `<span style="font-size:13px;color:#6b746e">${escapeHtml([incident.orderNumber, who].filter(Boolean).join(" · "))}</span>`,
            )
          : "") +
        (incident.detail ? infoBox(escapeHtml(incident.detail)) : "") +
        `<div style="margin:8px 0 16px">${buttons}</div>`,
      {
        preheader: incident.title,
        footer:
          "Recibes este aviso porque tienes activados los avisos de pedidos en Panel → Ajustes → Avisos por correo.",
      },
    );
    const subject = `Incidencia ${incident.number}: ${incident.title}${incident.orderNumber ? ` · ${incident.orderNumber}` : ""}`;
    await Promise.all(recipients.map((to) => sendEmail(to, subject, html)));
  } catch (error: any) {
    console.error("[alertas] no se pudo avisar de la incidencia:", error?.message);
  }
}
