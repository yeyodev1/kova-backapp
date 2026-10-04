import { env } from "../config/env";
import { getSettings, IBankAccount } from "../models/setting.model";
import {
  BRAND,
  emailButton,
  escapeHtml,
  infoBox,
  layout,
  paragraph,
  sendEmail,
} from "./email.service";
import { teamRecipients, waNumber } from "./teamAlerts.service";

/**
 * CORREOS DE CADA PEDIDO.
 *
 * Un solo lugar decide qué correo sale en cada momento del pedido (web o bot):
 *
 * | Evento     | Cliente (si dejó correo) | Equipo (admins con aviso de pedidos) |
 * |------------|--------------------------|--------------------------------------|
 * | created    | Recibimos tu pedido      | Nuevo pedido                         |
 * | paid       | Pago confirmado          | Pago confirmado: pasa a Dropi        |
 * | receipt    | —                        | Comprobante por revisar              |
 * | shipped    | Va en camino (guía)      | —                                    |
 * | delivered  | ¡Entregado!              | —                                    |
 * | cancelled  | Pedido cancelado         | Pedido cancelado                     |
 *
 * Quien llama lo hace solo en la transición (una vez por evento) y sin await:
 * un correo que falla nunca detiene una venta.
 */

export const ORDER_EVENTS = [
  "created",
  "paid",
  "receipt",
  "shipped",
  "delivered",
  "cancelled",
] as const;
export type OrderEvent = (typeof ORDER_EVENTS)[number];

interface Mail {
  subject: string;
  html: string;
}

export interface OrderMails {
  customer?: Mail;
  team?: Mail;
}

/** Lo que los correos necesitan de Ajustes. Se pasa aparte para poder renderizar sin Mongo. */
export interface MailContext {
  whatsapp: string;
  bankAccounts: IBankAccount[];
}

const METHOD_LABELS: Record<string, string> = {
  card: "Tarjeta",
  cod: "Contra entrega",
  transfer: "Transferencia",
};

const CHANNEL_LABELS: Record<string, string> = {
  web: "Web",
  whatsapp_bot: "Bot de WhatsApp",
};

const site = () => env.FRONTEND_URL.replace(/\/+$/, "");
const money = (cents: number) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;
const methodLabel = (order: any) => METHOD_LABELS[order.paymentMethod] || order.paymentMethod;
const channelLabel = (order: any) => CHANNEL_LABELS[order.channel] || "Web";
const firstName = (order: any) => escapeHtml(String(order.customer?.firstName || "").trim());
const fullName = (order: any) =>
  `${order.customer?.firstName || ""} ${order.customer?.lastName || ""}`.trim() || "Cliente";

const trackUrl = (order: any) =>
  `${site()}/rastrear?number=${encodeURIComponent(order.number)}&phone=${encodeURIComponent(order.customer?.phone || "")}`;
const payUrl = (order: any) => `${site()}/pagar/${encodeURIComponent(order.payToken || "")}`;
const panelUrl = (order: any) => `${site()}/admin/pedidos/${order._id}`;
const storeWaUrl = (ctx: MailContext) => `https://wa.me/${waNumber(ctx.whatsapp)}`;
const customerWaUrl = (order: any) => `https://wa.me/${waNumber(order.customer?.phone || "")}`;

function buttons(...html: string[]): string {
  return `<div style="margin:8px 0 20px">${html.join("")}</div>`;
}

function storeFooter(ctx: MailContext): string {
  if (!ctx.whatsapp) return "¿Dudas? Responde este correo.";
  return `¿Dudas? Escríbenos por WhatsApp: <a href="${storeWaUrl(ctx)}" style="color:${BRAND.accent}">+${escapeHtml(waNumber(ctx.whatsapp))}</a>`;
}

const TEAM_FOOTER =
  "Recibes este aviso porque lo tienes activado en Panel → Ajustes → Avisos por correo (Pedidos).";

// ── Bloques ─────────────────────────────────────────────────────────────────

/** Productos y totales. Con `team`, cada línea lleva el ID de Dropi para crearlo allá. */
function itemsTable(order: any, team = false): string {
  const cell = `padding:10px 0;border-bottom:1px solid ${BRAND.line};font-size:14px;color:${BRAND.ink};vertical-align:top`;
  const rows = (order.items || [])
    .map((item: any) => {
      const variant = item.variantName ? ` · ${escapeHtml(item.variantName)}` : "";
      const dropi = team
        ? `<br><span style="font-size:12px;color:${BRAND.muted}">Dropi ${item.dropiId ? `ID ${escapeHtml(item.dropiId)}` : "sin enlazar"}${item.dropiVariationId ? ` · variación ${escapeHtml(item.dropiVariationId)}` : ""}</span>`
        : "";
      // El cliente ve la foto; la celda va siempre para que las columnas no se corran.
      const image = team
        ? ""
        : `<td width="60" style="${cell};padding-right:12px">${item.image ? `<img src="${escapeHtml(item.image)}" width="48" height="48" alt="" style="display:block;border-radius:8px;object-fit:cover;border:0">` : ""}</td>`;
      return `<tr>${image}<td style="${cell}">${escapeHtml(item.title)}${variant} × ${Number(item.quantity) || 1}${dropi}</td><td align="right" style="${cell};white-space:nowrap">${money(item.total)}</td></tr>`;
    })
    .join("");
  const span = team ? 1 : 2;
  const line = (label: string, value: string, strong = false) =>
    `<tr><td colspan="${span}" style="padding:6px 0;font-size:${strong ? 16 : 14}px;color:${strong ? BRAND.ink : BRAND.muted};${strong ? "font-weight:bold" : ""}">${label}</td><td align="right" style="padding:6px 0;font-size:${strong ? 16 : 14}px;color:${strong ? BRAND.ink : BRAND.muted};${strong ? "font-weight:bold" : ""};white-space:nowrap">${value}</td></tr>`;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px">
    ${rows}
    ${line("Subtotal", money(order.subtotal))}
    ${line("Envío", order.shippingFee ? money(order.shippingFee) : "Gratis")}
    ${order.surcharge ? line(`Recargo (${escapeHtml(methodLabel(order))})`, money(order.surcharge)) : ""}
    ${line(`Total · ${escapeHtml(methodLabel(order))}`, money(order.total), true)}
  </table>`;
}

function addressText(order: any): string {
  const a = order.address || {};
  return [
    escapeHtml(a.street),
    a.reference ? `Ref: ${escapeHtml(a.reference)}` : "",
    [a.city, a.province].filter(Boolean).map(escapeHtml).join(", "),
  ]
    .filter(Boolean)
    .join("<br>");
}

function bankBox(account: IBankAccount): string {
  return infoBox(
    `<strong>${escapeHtml(account.bank)}</strong><br>
     Cuenta ${escapeHtml(account.type || "")} N.º <strong>${escapeHtml(account.number)}</strong><br>
     A nombre de ${escapeHtml(account.holder)}${account.idNumber ? ` · ${escapeHtml(account.idNumber)}` : ""}`,
  );
}

/** Ficha del cliente para el equipo: todo lo que se necesita para cargarlo en Dropi. */
function customerBox(order: any): string {
  const c = order.customer || {};
  return infoBox(
    `<strong>${escapeHtml(fullName(order))}</strong><br>
     Celular: ${escapeHtml(c.phone)}<br>
     ${c.email ? `Correo: ${escapeHtml(c.email)}<br>` : ""}
     ${c.idNumber ? `Cédula/RUC: ${escapeHtml(c.idNumber)}<br>` : ""}
     ${addressText(order)}
     ${order.notes ? `<br><em>Nota: ${escapeHtml(order.notes)}</em>` : ""}`,
  );
}

const teamButtons = (order: any, extra = "") =>
  buttons(
    emailButton("Abrir en el panel", panelUrl(order)),
    emailButton("WhatsApp al cliente", customerWaUrl(order), "#1f9d55"),
    extra,
  );

/** Qué le toca al equipo después de un pago o de un contra entrega. */
function dropiTask(order: any): string {
  if (order.dropi?.orderId) return `Ya está creado en Dropi (#${escapeHtml(order.dropi.orderId)}).`;
  const error = order.dropi?.error ? ` Dropi respondió: ${escapeHtml(order.dropi.error)}.` : "";
  return `<strong>Pásalo a Dropi</strong> con los IDs de abajo y registra el número en el panel.${error}`;
}

// ── Plantillas por evento ───────────────────────────────────────────────────

function created(order: any, ctx: MailContext): OrderMails {
  let next = "";
  let cta = emailButton("Ver mi pedido", trackUrl(order));
  if (order.paymentMethod === "card") {
    const payable =
      order.paymentStatus !== "paid" &&
      order.payToken &&
      ["pending_payment", "failed"].includes(order.status);
    next = payable
      ? paragraph(
          `Para completar tu compra paga <strong>${money(order.total)}</strong> con tarjeta en el link seguro de Payphone. Si ya pagaste, ignora este paso: te confirmamos por aquí.`,
        )
      : paragraph("Apenas se confirme tu pago lo preparamos para despacho.");
    if (payable) cta = emailButton(`Pagar ${money(order.total)}`, payUrl(order)) + cta;
  } else if (order.paymentMethod === "transfer") {
    const chosen = (ctx.bankAccounts || []).filter(
      (a) => !order.transfer?.bank || a.bank === order.transfer.bank,
    );
    const accounts = chosen.length ? chosen : ctx.bankAccounts || [];
    next =
      paragraph(
        `Transfiere <strong>${money(order.total)}</strong> a ${accounts.length > 1 ? "una de estas cuentas" : "esta cuenta"}:`,
      ) +
      accounts.map(bankBox).join("") +
      paragraph(
        "Luego envíanos la foto del comprobante: súbela en la página de tu pedido o mándala por WhatsApp. Apenas la revisemos, despachamos.",
      );
    cta = emailButton("Subir comprobante", trackUrl(order));
    if (ctx.whatsapp) cta += emailButton("Enviar por WhatsApp", storeWaUrl(ctx), "#1f9d55");
  } else {
    next = paragraph(
      `Pagas <strong>${money(order.total)}</strong> en efectivo al recibirlo. Te contactamos por WhatsApp para coordinar la entrega.`,
    );
  }

  const customer: Mail | undefined = order.customer?.email
    ? {
        subject: `Recibimos tu pedido ${order.number}`,
        html: layout(
          `¡Gracias, ${order.customer.firstName || "por tu compra"}! Recibimos tu pedido`,
          paragraph(`Tu pedido <strong>${escapeHtml(order.number)}</strong> ya está registrado.`) +
            next +
            buttons(cta) +
            itemsTable(order) +
            paragraph(`<strong>Entrega en</strong><br>${addressText(order)}`),
          { preheader: `Pedido ${order.number} · ${money(order.total)}`, footer: storeFooter(ctx) },
        ),
      }
    : undefined;

  const task =
    order.paymentMethod === "cod"
      ? `Contra entrega: ${dropiTask(order)}`
      : order.paymentMethod === "transfer"
        ? `Transferencia${order.transfer?.bank ? ` a ${escapeHtml(order.transfer.bank)}` : ""}: espera el comprobante antes de pasarlo a Dropi.`
        : "Tarjeta: espera la confirmación del pago antes de pasarlo a Dropi.";

  const team: Mail = {
    subject: `Nuevo pedido ${order.number} · ${money(order.total)} · ${methodLabel(order)} · ${channelLabel(order)}`,
    html: layout(
      `Nuevo pedido ${order.number}`,
      paragraph(
        `Entró por <strong>${escapeHtml(channelLabel(order))}</strong> · ${escapeHtml(methodLabel(order))} · <strong>${money(order.total)}</strong>`,
      ) +
        paragraph(task) +
        customerBox(order) +
        itemsTable(order, true) +
        teamButtons(order),
      { preheader: `${fullName(order)} · ${money(order.total)}`, footer: TEAM_FOOTER },
    ),
  };
  return { customer, team };
}

function paid(order: any, ctx: MailContext): OrderMails {
  const how = order.paymentMethod === "card" ? "con tarjeta" : "por transferencia";
  const customer: Mail | undefined = order.customer?.email
    ? {
        subject: `Pago confirmado · ${order.number}`,
        html: layout(
          "Pago confirmado",
          paragraph(
            `Hola ${firstName(order)}, recibimos tu pago de <strong>${money(order.total)}</strong> ${how} por el pedido <strong>${escapeHtml(order.number)}</strong>.`,
          ) +
            paragraph("Ya lo estamos preparando para despacho. Te enviamos la guía apenas salga.") +
            buttons(emailButton("Ver mi pedido", trackUrl(order))) +
            itemsTable(order),
          {
            preheader: `Tu pago de ${money(order.total)} está confirmado`,
            footer: storeFooter(ctx),
          },
        ),
      }
    : undefined;

  const inDropi = Boolean(order.dropi?.orderId);
  const team: Mail = {
    subject: inDropi
      ? `Pago confirmado ${order.number} · ya está en Dropi`
      : `Pago confirmado ${order.number}: pasa el pedido a Dropi`,
    html: layout(
      `Pago confirmado ${order.number}`,
      paragraph(
        `<strong>${escapeHtml(fullName(order))}</strong> pagó <strong>${money(order.total)}</strong> ${how} (${escapeHtml(channelLabel(order))}).`,
      ) +
        paragraph(dropiTask(order)) +
        customerBox(order) +
        itemsTable(order, true) +
        teamButtons(order),
      { preheader: `${fullName(order)} pagó ${money(order.total)}`, footer: TEAM_FOOTER },
    ),
  };
  return { customer, team };
}

function receipt(order: any): OrderMails {
  const url = order.transfer?.receiptUrl || "";
  return {
    team: {
      subject: `Comprobante por revisar ${order.number} · ${money(order.total)}`,
      html: layout(
        `Comprobante por revisar ${order.number}`,
        paragraph(
          `<strong>${escapeHtml(fullName(order))}</strong> envió el comprobante de su transferencia por <strong>${money(order.total)}</strong>${order.transfer?.bank ? ` a ${escapeHtml(order.transfer.bank)}` : ""} (${escapeHtml(channelLabel(order))}).`,
        ) +
          paragraph(
            "Revisa que el dinero haya llegado a la cuenta y confírmalo en el panel: ahí el pedido pasa a confirmado.",
          ) +
          customerBox(order) +
          teamButtons(order, url ? emailButton("Ver comprobante", url, BRAND.accent) : ""),
        { preheader: `${fullName(order)} · ${money(order.total)}`, footer: TEAM_FOOTER },
      ),
    },
  };
}

function shipped(order: any, ctx: MailContext): OrderMails {
  if (!order.customer?.email) return {};
  const guide = order.dropi?.guide || "";
  const carrier = order.dropi?.carrier || "";
  const cod =
    order.paymentMethod === "cod" && order.paymentStatus !== "paid"
      ? paragraph(`Ten listos <strong>${money(order.total)}</strong> para pagar al recibirlo.`)
      : "";
  return {
    customer: {
      subject: `Tu pedido ${order.number} va en camino`,
      html: layout(
        "Tu pedido va en camino",
        paragraph(
          `Hola ${firstName(order)}, tu pedido <strong>${escapeHtml(order.number)}</strong> ya salió.`,
        ) +
          infoBox(
            `${carrier ? `Transportadora: <strong>${escapeHtml(carrier)}</strong><br>` : ""}${guide ? `N.º de guía: <strong>${escapeHtml(guide)}</strong>` : ""}`,
          ) +
          cod +
          paragraph("La transportadora te llamará o escribirá antes de entregar.") +
          buttons(emailButton("Ver mi pedido", trackUrl(order))) +
          itemsTable(order),
        { preheader: guide ? `Guía ${guide}` : "Tu pedido ya salió", footer: storeFooter(ctx) },
      ),
    },
  };
}

function delivered(order: any, ctx: MailContext): OrderMails {
  if (!order.customer?.email) return {};
  return {
    customer: {
      subject: `¡Entregado! Tu pedido ${order.number}`,
      html: layout(
        "¡Entregado!",
        paragraph(
          `Hola ${firstName(order)}, tu pedido <strong>${escapeHtml(order.number)}</strong> fue entregado. Gracias por comprar en Kova.`,
        ) +
          paragraph(
            "Si algo no llegó como esperabas o tienes una duda con tu producto, escríbenos por WhatsApp y lo resolvemos.",
          ) +
          buttons(
            ctx.whatsapp ? emailButton("Escríbenos por WhatsApp", storeWaUrl(ctx), "#1f9d55") : "",
            emailButton("Seguir comprando", site()),
          ),
        { preheader: "Gracias por comprar en Kova", footer: storeFooter(ctx) },
      ),
    },
  };
}

function cancelled(order: any, ctx: MailContext): OrderMails {
  const wasPaid = order.paymentStatus === "paid";
  const customer: Mail | undefined = order.customer?.email
    ? {
        subject: `Pedido cancelado · ${order.number}`,
        html: layout(
          "Pedido cancelado",
          paragraph(
            `Hola ${firstName(order)}, cancelamos tu pedido <strong>${escapeHtml(order.number)}</strong>.`,
          ) +
            (wasPaid
              ? paragraph("Como ya lo habías pagado, te contactamos para devolverte el dinero.")
              : "") +
            paragraph("Si fue un error o quieres hacerlo de nuevo, escríbenos por WhatsApp.") +
            buttons(
              ctx.whatsapp
                ? emailButton("Escríbenos por WhatsApp", storeWaUrl(ctx), "#1f9d55")
                : "",
              emailButton("Ir a la tienda", site()),
            ),
          { preheader: `Pedido ${order.number} cancelado`, footer: storeFooter(ctx) },
        ),
      }
    : undefined;

  const notes = [
    wasPaid ? "<strong>Estaba pagado: gestiona el reembolso.</strong>" : "",
    order.dropi?.orderId
      ? `Tenía pedido en Dropi #${escapeHtml(order.dropi.orderId)}: verifica que quedó cancelado allá.`
      : "",
  ].filter(Boolean);
  const team: Mail = {
    subject: `Pedido cancelado ${order.number} · ${money(order.total)}`,
    html: layout(
      `Pedido cancelado ${order.number}`,
      paragraph(
        `${escapeHtml(fullName(order))} · ${escapeHtml(methodLabel(order))} · ${money(order.total)} · ${escapeHtml(channelLabel(order))}`,
      ) +
        notes.map(paragraph).join("") +
        teamButtons(order),
      { footer: TEAM_FOOTER },
    ),
  };
  return { customer, team };
}

const BUILDERS: Record<OrderEvent, (order: any, ctx: MailContext) => OrderMails> = {
  created,
  paid,
  receipt: (order) => receipt(order),
  shipped,
  delivered,
  cancelled,
};

/** Arma los correos de un evento sin enviarlos (sirve para revisarlos o probarlos). */
export function renderOrderMails(event: OrderEvent, order: any, ctx: MailContext): OrderMails {
  return BUILDERS[event](order, ctx);
}

async function deliver(event: OrderEvent, order: any) {
  const settings = await getSettings();
  const ctx: MailContext = {
    whatsapp: settings.whatsapp || "",
    bankAccounts: settings.bankAccounts || [],
  };
  const mails = renderOrderMails(event, order, ctx);
  const sends: Promise<boolean>[] = [];
  if (mails.customer && order.customer?.email) {
    sends.push(sendEmail(order.customer.email, mails.customer.subject, mails.customer.html));
  }
  if (mails.team) {
    const recipients = await teamRecipients("orders");
    // Responder al aviso le escribe directo al cliente.
    const replyTo = order.customer?.email || undefined;
    for (const to of recipients)
      sends.push(sendEmail(to, mails.team.subject, mails.team.html, replyTo));
  }
  await Promise.all(sends);
}

/**
 * Dispara los correos de un evento del pedido. No se espera ni lanza: un correo
 * caído queda en el log y el flujo sigue.
 */
export function notifyOrder(event: OrderEvent, order: any): void {
  if (!order) return;
  const plain = typeof order.toObject === "function" ? order.toObject() : order;
  deliver(event, plain).catch((error: any) =>
    console.error(`[correos] falló "${event}" de ${plain?.number}:`, error?.message),
  );
}
