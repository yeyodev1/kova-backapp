import mongoose, { Schema } from "mongoose";

export const BOT_EVENT_KINDS = ["decision", "turn", "error", "human_request"] as const;
export type BotEventKind = (typeof BOT_EVENT_KINDS)[number];

/**
 * Bitácora del bot de WhatsApp: una fila por llamada de BuilderBot. Sirve al
 * panel para ver qué decidió /brain, qué respondió cada flujo, cuánto tardó y
 * qué falló. `human_request` marca a un cliente que pidió una persona.
 */
export interface IBotEvent {
  phone: string;
  endpoint: string;
  kind: BotEventKind;
  route: string;
  decision: string;
  step: string;
  message: string;
  reply: string;
  mediaUrl: string;
  orderNumber: string;
  duplicated: boolean;
  error: string;
  durationMs: number;
  createdAt?: Date;
}

const botEventSchema = new Schema<IBotEvent>(
  {
    phone: { type: String, required: true },
    // brain, conversation, catalog, checkout, search-order, human, media.
    endpoint: { type: String, required: true },
    kind: { type: String, enum: BOT_EVENT_KINDS, required: true },
    route: { type: String, default: "" },
    decision: { type: String, default: "" },
    step: { type: String, default: "" },
    message: { type: String, default: "" },
    reply: { type: String, default: "" },
    mediaUrl: { type: String, default: "" },
    orderNumber: { type: String, default: "" },
    duplicated: { type: Boolean, default: false },
    error: { type: String, default: "" },
    durationMs: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

botEventSchema.index({ phone: 1, createdAt: -1 });
botEventSchema.index({ kind: 1, createdAt: -1 });
// Se conserva 30 días (este índice también sirve para ordenar por fecha).
botEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const BotEvent =
  mongoose.models.BotEvent || mongoose.model<IBotEvent>("BotEvent", botEventSchema);
