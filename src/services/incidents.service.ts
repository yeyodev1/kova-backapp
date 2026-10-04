import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { nextSequence } from "../models/counter.model";
import {
  ACTIVE_STATUSES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  Incident,
  IncidentSeverity,
  IncidentSource,
  IncidentStatus,
  IncidentType,
  SEVERITY_RANK,
} from "../models/incident.model";
import { Order } from "../models/order.model";
import { User } from "../models/user.model";
import { normalizeEcPhone } from "../utils/phone";
import { escapeRegex } from "../utils/regex";
import { notifyIncident } from "./teamAlerts.service";

/**
 * BANDEJA DE INCIDENCIAS.
 *
 * `reportIncident` se llama desde donde ocurre el problema (Dropi, Payphone, correo,
 * bot, cron). Nunca lanza ni demora: igual que un correo, una incidencia que no se
 * pudo guardar no debe romper una venta. El mismo problema abierto (misma clave)
 * suma ocurrencias en vez de crear otra tarjeta.
 */

const SYSTEM = "Sistema";
const PAGE_SIZE = 20;

interface OrderRef {
  _id: unknown;
  number?: string;
  customer?: { firstName?: string; lastName?: string; phone?: string };
}

export interface IncidentReport {
  type: IncidentType;
  severity?: IncidentSeverity;
  title: string;
  detail?: string;
  /** Documento del pedido (o su id): de ahí salen número, cliente y teléfono. */
  order?: OrderRef | string | null;
  orderNumber?: string;
  phone?: string;
  customerName?: string;
  source?: IncidentSource;
  /** Clave propia de deduplicación (p. ej. un correo por destinatario y evento). */
  key?: string;
  /** false: un barrido que vuelve a ver el problema no suma "×N veces". */
  countOccurrence?: boolean;
}

const text = (value: unknown, max: number) =>
  String(value ?? "")
    .trim()
    .slice(0, max);

async function resolveOrder(order: IncidentReport["order"]): Promise<OrderRef | null> {
  if (!order) return null;
  if (typeof order === "string") {
    if (!isValidObjectId(order)) return null;
    return Order.findById(order).select("number customer").lean<OrderRef>();
  }
  return order;
}

function dedupeKeyFor(report: IncidentReport, orderId: string, phone: string) {
  if (report.key) return `${report.type}:${report.key}`;
  if (orderId) return `${report.type}:order:${orderId}`;
  if (phone) return `${report.type}:phone:${phone}`;
  return `${report.type}:global`;
}

async function nextIncidentNumber() {
  const seq = await nextSequence("incident");
  return `IN-${String(seq).padStart(4, "0")}`;
}

/** Registra (o vuelve a contar) una incidencia. Nunca lanza. */
export async function reportIncident(report: IncidentReport): Promise<void> {
  try {
    const order = await resolveOrder(report.order);
    const orderId = order?._id ? String(order._id) : "";
    const phone =
      normalizeEcPhone(report.phone || order?.customer?.phone || "") || text(report.phone, 40);
    const severity = report.severity || "medium";
    const key = dedupeKeyFor(report, orderId, phone);
    const detail = text(report.detail, 2000);
    const now = new Date();

    // Primero se intenta sumar a la abierta; si no hay, se crea. Una repetición deja lo
    // nuevo como nota (no pisa el primer detalle); un barrido solo refresca el texto.
    const sweep = report.countOccurrence === false;
    const bump = async () =>
      Incident.findOneAndUpdate(
        { openKey: key },
        {
          $inc: { occurrences: sweep ? 0 : 1 },
          $set: {
            lastSeenAt: now,
            ...(sweep ? { title: text(report.title, 200), ...(detail ? { detail } : {}) } : {}),
          },
          $max: { severityRank: SEVERITY_RANK[severity] },
          ...(!sweep && detail
            ? {
                $push: {
                  notes: {
                    $each: [{ at: now, by: null, byName: SYSTEM, text: `Se repitió: ${detail}` }],
                    $slice: -200,
                  },
                },
              }
            : {}),
        },
        { new: true },
      );
    const existing = await bump();
    if (existing) {
      // Si la nueva ocurrencia es más grave, la tarjeta sube de severidad.
      if (SEVERITY_RANK[existing.severity as IncidentSeverity] < SEVERITY_RANK[severity]) {
        await Incident.updateOne({ _id: existing._id }, { $set: { severity } });
      }
      return;
    }

    const first = order?.customer
      ? `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim()
      : "";
    try {
      const created = await Incident.create({
        number: await nextIncidentNumber(),
        type: report.type,
        severity,
        severityRank: SEVERITY_RANK[severity],
        title: text(report.title, 200),
        detail,
        order: orderId ? new Types.ObjectId(orderId) : null,
        orderNumber: order?.number || text(report.orderNumber, 20),
        phone,
        customerName: text(report.customerName, 120) || first,
        source: report.source || "system",
        status: "open",
        occurrences: 1,
        lastSeenAt: now,
        dedupeKey: key,
        openKey: key,
      });
      if (severity === "high") void notifyIncident(created.toObject());
    } catch (error: any) {
      // Otra llamada simultánea la creó primero: se suma a esa.
      if (error?.code === 11000) await bump();
      else throw error;
    }
  } catch (error: any) {
    console.error("[incidencias] no se pudo registrar:", report.type, error?.message || error);
  }
}

/**
 * El problema se resolvió solo (se confirmó la transferencia, se creó en Dropi…):
 * cierra las incidencias abiertas de ese pedido con una nota. Nunca lanza.
 */
export async function resolveIncidents(
  orderId: unknown,
  types: IncidentType[],
  note: string,
): Promise<void> {
  try {
    if (!orderId || !isValidObjectId(String(orderId))) return;
    const now = new Date();
    await Incident.updateMany(
      { order: orderId, type: { $in: types }, status: { $in: ACTIVE_STATUSES } },
      {
        $set: { status: "resolved", resolvedAt: now, openKey: null },
        $push: { notes: { at: now, by: null, byName: SYSTEM, text: note } },
      },
    );
  } catch (error: any) {
    console.error("[incidencias] no se pudo cerrar:", error?.message || error);
  }
}

// ── Barrido (cron cada hora) ────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
export const RECEIPT_STALE_MS = 12 * HOUR;
export const STUCK_MS = 72 * HOUR;

const hoursSince = (date: Date) => Math.round((Date.now() - date.getTime()) / HOUR);

/** Cuándo entró el pedido a Dropi según el historial (o la última edición si no hay). */
function sentToDropiAt(order: any): Date {
  const entry = [...(order.history || [])]
    .reverse()
    .find((item: any) => item.status === "sent_to_dropi");
  return new Date(entry?.at || order.updatedAt || order.createdAt);
}

/**
 * Comprobantes sin revisar > 12 h y pedidos en Dropi sin guía > 72 h. También cierra
 * las incidencias cuyo pedido ya avanzó (por si el cambio se hizo fuera de los ganchos).
 */
export async function sweepIncidents() {
  const now = Date.now();
  let reported = 0;

  const receipts: any[] = await Order.find({
    status: "transfer_review",
    "transfer.uploadedAt": { $lt: new Date(now - RECEIPT_STALE_MS) },
  })
    .select("number customer transfer total")
    .lean();
  for (const order of receipts) {
    await reportIncident({
      type: "receipt_review_stale",
      severity: "medium",
      title: `Comprobante sin revisar hace ${hoursSince(new Date(order.transfer.uploadedAt))} h`,
      detail: `El cliente envió el comprobante de ${order.number} y nadie lo ha confirmado. Revísalo y confirma la transferencia.`,
      order,
      countOccurrence: false,
    });
    reported++;
  }

  const sent: any[] = await Order.find({
    status: "sent_to_dropi",
    $or: [{ "dropi.guide": "" }, { "dropi.guide": null }, { "dropi.guide": { $exists: false } }],
  })
    .select("number customer history updatedAt createdAt dropi")
    .lean();
  for (const order of sent) {
    const since = sentToDropiAt(order);
    if (now - since.getTime() < STUCK_MS) continue;
    await reportIncident({
      type: "order_stuck",
      severity: "medium",
      title: `Pedido sin guía hace ${hoursSince(since)} h`,
      detail: `${order.number} está en Dropi${order.dropi?.orderId ? ` (#${order.dropi.orderId})` : ""} y todavía no tiene guía. Pide la guía en Dropi o revisa si se quedó trabado.`,
      order,
      countOccurrence: false,
    });
    reported++;
  }

  const resolved = await autoResolve();
  return { reported, resolved };
}

/** Qué estado del pedido deja sin sentido cada tipo de incidencia. */
function isSettled(type: IncidentType, order: any): string {
  if (!order) return "";
  if (order.status === "cancelled") return "El pedido se canceló";
  if (type === "receipt_review_stale" && order.status !== "transfer_review")
    return "El comprobante ya se revisó";
  if (type === "order_stuck" && (order.status !== "sent_to_dropi" || order.dropi?.guide))
    return "El pedido ya tiene guía";
  if (type === "dropi_error" && order.dropi?.orderId) return "El pedido ya está creado en Dropi";
  if ((type === "payment_failed" || type === "payment_mismatch") && order.paymentStatus === "paid")
    return "El pago ya está confirmado";
  return "";
}

async function autoResolve() {
  const types: IncidentType[] = [
    "receipt_review_stale",
    "order_stuck",
    "dropi_error",
    "payment_failed",
    "payment_mismatch",
  ];
  const open: any[] = await Incident.find({
    status: { $in: ACTIVE_STATUSES },
    type: { $in: types },
    order: { $ne: null },
  })
    .select("type order")
    .lean();
  if (!open.length) return 0;
  const orders: any[] = await Order.find({ _id: { $in: open.map((item) => item.order) } })
    .select("status paymentStatus dropi")
    .lean();
  const byId = new Map(orders.map((order) => [String(order._id), order]));
  let count = 0;
  for (const incident of open) {
    const reason = isSettled(incident.type, byId.get(String(incident.order)));
    if (!reason) continue;
    const at = new Date();
    await Incident.updateOne(
      { _id: incident._id, status: { $in: ACTIVE_STATUSES } },
      {
        $set: { status: "resolved", resolvedAt: at, openKey: null },
        $push: { notes: { at, by: null, byName: SYSTEM, text: `Resuelta sola: ${reason}.` } },
      },
    );
    count++;
  }
  return count;
}

// ── Panel ───────────────────────────────────────────────────────────────────

const POPULATE_ASSIGNEE = { path: "assignee", select: "name email" };

async function findOr404(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Incidencia no encontrada", 404);
  const incident = await Incident.findById(id);
  if (!incident) throw new CustomError("Incidencia no encontrada", 404);
  return incident;
}

async function withAssignee(id: unknown) {
  return Incident.findById(id).populate(POPULATE_ASSIGNEE).lean();
}

async function adminName(userId: string) {
  const user: any = isValidObjectId(userId)
    ? await User.findById(userId).select("name email").lean()
    : null;
  return user?.name || user?.email || "Administrador";
}

/** GET /admin/incidents?status&type&severity&q&page */
export async function listIncidents(query: any) {
  const filter: Record<string, unknown> = {};
  const status = text(query.status, 20);
  if (status === "all") {
    // sin filtro
  } else if ((INCIDENT_STATUSES as readonly string[]).includes(status)) {
    filter.status = status;
  } else {
    filter.status = { $in: ACTIVE_STATUSES };
  }
  const type = text(query.type, 40);
  if (type && (INCIDENT_TYPES as readonly string[]).includes(type)) filter.type = type;
  const severity = text(query.severity, 10);
  if (severity && (INCIDENT_SEVERITIES as readonly string[]).includes(severity))
    filter.severity = severity;
  const q = text(query.q, 80);
  if (q) {
    const regex = { $regex: escapeRegex(q), $options: "i" };
    const phone = normalizeEcPhone(q);
    filter.$or = [
      { number: regex },
      { title: regex },
      { detail: regex },
      { orderNumber: regex },
      { customerName: regex },
      { phone: phone || regex },
    ];
  }

  const page = Math.max(1, Number(query.page) || 1);
  const [items, total] = await Promise.all([
    Incident.find(filter)
      .select("-notes -dedupeKey -openKey")
      .sort({ severityRank: -1, lastSeenAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .populate(POPULATE_ASSIGNEE)
      .lean(),
    Incident.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** GET /admin/incidents/summary: conteos para el badge del menú y el panel. */
export async function incidentSummary() {
  const [byStatus, bySeverity] = await Promise.all([
    Incident.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    Incident.aggregate([
      { $match: { status: { $in: ACTIVE_STATUSES } } },
      { $group: { _id: "$severity", count: { $sum: 1 } } },
    ]),
  ]);
  const status = Object.fromEntries(INCIDENT_STATUSES.map((key) => [key, 0])) as Record<
    IncidentStatus,
    number
  >;
  for (const row of byStatus) status[row._id as IncidentStatus] = row.count;
  const severity = { high: 0, medium: 0, low: 0 };
  for (const row of bySeverity) severity[row._id as IncidentSeverity] = row.count;
  return {
    ...status,
    active: status.open + status.in_progress,
    bySeverity: severity,
    // El badge cuenta lo urgente: alta y media sin cerrar.
    badge: severity.high + severity.medium,
  };
}

/** GET /admin/incidents/:id */
export async function getIncident(id: string) {
  await findOr404(id);
  return withAssignee(id);
}

/** POST /admin/incidents: incidencia a mano (un cliente llamó, algo que vio el equipo). */
export async function createIncident(body: any, userId: string) {
  const title = text(body?.title, 200);
  if (!title) throw new CustomError("Escribe un título para la incidencia", 400);
  const severity = text(body?.severity, 10) || "medium";
  if (!(INCIDENT_SEVERITIES as readonly string[]).includes(severity)) {
    throw new CustomError("Severidad no válida: usa alta, media o baja", 400);
  }
  const type = text(body?.type, 40) || "manual";
  if (!(INCIDENT_TYPES as readonly string[]).includes(type)) {
    throw new CustomError("Tipo de incidencia no válido", 400);
  }
  const orderNumber = text(body?.orderNumber, 20).toUpperCase();
  let order: any = null;
  if (orderNumber) {
    order = await Order.findOne({ number: orderNumber }).select("number customer").lean();
    if (!order) throw new CustomError(`No existe el pedido ${orderNumber}`, 404);
  }
  const rawPhone = text(body?.phone, 30);
  const phone = rawPhone ? normalizeEcPhone(rawPhone) : "";
  if (rawPhone && !phone) throw new CustomError("El celular debe ser de Ecuador (09XXXXXXXX)", 400);

  const at = new Date();
  // A mano nunca se deduplica: cada una es un caso que alguien decidió registrar.
  const key = `manual:${at.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const created = await Incident.create({
    number: await nextIncidentNumber(),
    type,
    severity,
    severityRank: SEVERITY_RANK[severity as IncidentSeverity],
    title,
    detail: text(body?.detail, 2000),
    order: order?._id || null,
    orderNumber: order?.number || "",
    phone: phone || order?.customer?.phone || "",
    customerName:
      text(body?.customerName, 120) ||
      (order ? `${order.customer?.firstName || ""} ${order.customer?.lastName || ""}`.trim() : ""),
    source: "admin",
    status: "open",
    lastSeenAt: at,
    dedupeKey: key,
    openKey: key,
    notes: [{ at, by: userId, byName: await adminName(userId), text: "Creó la incidencia" }],
  });
  if (severity === "high") void notifyIncident(created.toObject());
  return withAssignee(created._id);
}

const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: "abierta",
  in_progress: "en curso",
  resolved: "resuelta",
  dismissed: "descartada",
};
const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  high: "alta",
  medium: "media",
  low: "baja",
};

/** PUT /admin/incidents/:id { status?, assignee?, severity? } */
export async function updateIncident(id: string, body: any, userId: string) {
  const incident: any = await findOr404(id);
  const changes: string[] = [];
  const has = (field: string) => body && Object.prototype.hasOwnProperty.call(body, field);

  if (has("severity")) {
    const severity = text(body.severity, 10) as IncidentSeverity;
    if (!(INCIDENT_SEVERITIES as readonly string[]).includes(severity)) {
      throw new CustomError("Severidad no válida: usa alta, media o baja", 400);
    }
    if (severity !== incident.severity) {
      incident.severity = severity;
      incident.severityRank = SEVERITY_RANK[severity];
      changes.push(`Severidad ${SEVERITY_LABELS[severity]}`);
    }
  }

  if (has("assignee")) {
    const assignee = body.assignee ? String(body.assignee) : "";
    if (assignee) {
      const admin: any = isValidObjectId(assignee)
        ? await User.findOne({ _id: assignee, accountType: "admin", isActive: true })
            .select("name email")
            .lean()
        : null;
      if (!admin) throw new CustomError("Ese administrador no existe o está inactivo", 400);
      if (String(incident.assignee || "") !== assignee) {
        incident.assignee = admin._id;
        changes.push(`Asignada a ${admin.name || admin.email}`);
      }
    } else if (incident.assignee) {
      incident.assignee = null;
      changes.push("Sin responsable");
    }
  }

  if (has("status")) {
    const status = text(body.status, 20) as IncidentStatus;
    if (!(INCIDENT_STATUSES as readonly string[]).includes(status)) {
      throw new CustomError("Estado no válido", 400);
    }
    if (status !== incident.status) {
      const reopening = ACTIVE_STATUSES.includes(status) && !incident.openKey;
      if (reopening) {
        const twin: any = await Incident.findOne({ openKey: incident.dedupeKey })
          .select("number")
          .lean();
        if (twin) {
          throw new CustomError(
            `Ya hay otra incidencia abierta por lo mismo: ${twin.number}. Sigue en esa`,
            409,
          );
        }
        incident.openKey = incident.dedupeKey;
        incident.resolvedAt = null;
      }
      if (!ACTIVE_STATUSES.includes(status)) {
        incident.openKey = null;
        incident.resolvedAt = new Date();
      }
      // "Tomar" sin responsable: queda a cargo de quien la tomó.
      if (status === "in_progress" && !incident.assignee && !has("assignee")) {
        incident.assignee = userId;
        changes.push(`Asignada a ${await adminName(userId)}`);
      }
      incident.status = status;
      changes.unshift(`Marcada como ${STATUS_LABELS[status]}`);
    }
  }

  if (!changes.length) return withAssignee(incident._id);
  incident.notes.push({
    at: new Date(),
    by: userId,
    byName: await adminName(userId),
    text: changes.join(" · "),
  });
  await incident.save();
  return withAssignee(incident._id);
}

/** POST /admin/incidents/:id/notes { text } */
export async function addIncidentNote(id: string, body: any, userId: string) {
  const note = text(body?.text, 2000);
  if (!note) throw new CustomError("Escribe la nota", 400);
  const incident = await findOr404(id);
  incident.notes.push({ at: new Date(), by: userId, byName: await adminName(userId), text: note });
  await incident.save();
  return withAssignee(incident._id);
}
