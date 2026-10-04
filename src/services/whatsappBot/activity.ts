import { BotEvent, BotEventKind } from "../../models/botEvent.model";

export interface BotEventInput {
  phone: string;
  endpoint: string;
  kind: BotEventKind;
  route?: string;
  decision?: string;
  step?: string;
  message?: string;
  reply?: string;
  mediaUrl?: string;
  orderNumber?: string;
  paymentLink?: string;
  duplicated?: boolean;
  error?: string;
  durationMs?: number;
}

/** Registra un paso del bot. Nunca bloquea ni rompe la respuesta a BuilderBot. */
export function logBotEvent(event: BotEventInput) {
  if (!event.phone) return;
  void BotEvent.create({
    ...event,
    message: (event.message || "").slice(0, 1000),
    reply: (event.reply || "").slice(0, 2000),
    error: (event.error || "").slice(0, 500),
  }).catch((error: any) =>
    console.error("[whatsapp-bot] no se pudo registrar la actividad:", error?.message || error),
  );
}
