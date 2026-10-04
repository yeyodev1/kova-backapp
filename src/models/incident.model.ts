import mongoose, { Schema, Types } from "mongoose";

/**
 * INCIDENCIAS: problemas que el equipo tiene que atender (Dropi rechazó un pedido,
 * un pago no cuadra, un cliente reclama por WhatsApp…). Se acumulan en una bandeja
 * del panel hasta que alguien los resuelve o descarta.
 */

export const INCIDENT_TYPES = [
  "dropi_error",
  "payment_mismatch",
  "payment_failed",
  "email_failed",
  "bot_error",
  "customer_complaint",
  "human_request",
  "receipt_review_stale",
  "order_stuck",
  "manual",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_SEVERITIES = ["high", "medium", "low"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ["open", "in_progress", "resolved", "dismissed"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Estados en los que la incidencia sigue pendiente (y deduplica). */
export const ACTIVE_STATUSES: IncidentStatus[] = ["open", "in_progress"];

export const INCIDENT_SOURCES = ["system", "bot", "admin"] as const;
export type IncidentSource = (typeof INCIDENT_SOURCES)[number];

/** Para ordenar por severidad sin agregaciones. */
export const SEVERITY_RANK: Record<IncidentSeverity, number> = { high: 3, medium: 2, low: 1 };

export interface IIncidentNote {
  at: Date;
  /** null = la escribió el sistema (resolución automática, cambios de estado). */
  by: Types.ObjectId | null;
  byName: string;
  text: string;
}

export interface IIncident {
  number: string;
  type: IncidentType;
  severity: IncidentSeverity;
  severityRank: number;
  title: string;
  detail: string;
  order: Types.ObjectId | null;
  orderNumber: string;
  phone: string;
  customerName: string;
  source: IncidentSource;
  status: IncidentStatus;
  assignee: Types.ObjectId | null;
  notes: IIncidentNote[];
  occurrences: number;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  /** Qué problema es: `type:pedido`, `type:teléfono` o una clave propia. */
  dedupeKey: string;
  /**
   * = dedupeKey mientras está abierta o en curso; null al cerrarse. El índice único
   * parcial garantiza una sola incidencia abierta por problema aunque lleguen dos a la vez.
   */
  openKey: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const noteSchema = new Schema<IIncidentNote>(
  {
    at: { type: Date, default: Date.now },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    byName: { type: String, default: "" },
    text: { type: String, required: true },
  },
  { _id: true },
);

const incidentSchema = new Schema<IIncident>(
  {
    number: { type: String, required: true, unique: true },
    type: { type: String, enum: INCIDENT_TYPES, required: true, index: true },
    severity: { type: String, enum: INCIDENT_SEVERITIES, default: "medium" },
    severityRank: { type: Number, default: 2 },
    title: { type: String, required: true },
    detail: { type: String, default: "" },
    order: { type: Schema.Types.ObjectId, ref: "Order", default: null, index: true },
    orderNumber: { type: String, default: "" },
    phone: { type: String, default: "", index: true },
    customerName: { type: String, default: "" },
    source: { type: String, enum: INCIDENT_SOURCES, default: "system" },
    status: { type: String, enum: INCIDENT_STATUSES, default: "open", index: true },
    assignee: { type: Schema.Types.ObjectId, ref: "User", default: null },
    notes: { type: [noteSchema], default: [] },
    occurrences: { type: Number, default: 1 },
    lastSeenAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
    dedupeKey: { type: String, required: true },
    openKey: { type: String, default: null },
  },
  { timestamps: true },
);

incidentSchema.index(
  { openKey: 1 },
  { unique: true, partialFilterExpression: { openKey: { $type: "string" } } },
);
incidentSchema.index({ status: 1, severityRank: -1, lastSeenAt: -1 });

export const Incident =
  mongoose.models.Incident || mongoose.model<IIncident>("Incident", incidentSchema);
