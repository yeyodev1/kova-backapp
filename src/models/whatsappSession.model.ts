import mongoose, { Schema } from "mongoose";

/**
 * Conversación del bot de WhatsApp por teléfono. El estado del pedido vive
 * aquí (no en el `{history}` de BuilderBot): así el backend decide cada paso.
 */
export interface IWhatsappSessionMessage {
  role: "user" | "assistant";
  content: string;
  mediaUrl?: string;
  createdAt: Date;
}

export interface IWhatsappSession {
  /** 09XXXXXXXX, o "lid:<dígitos>" cuando WhatsApp oculta el número. */
  phone: string;
  state: any;
  history: IWhatsappSessionMessage[];
  lastMessageHash: string;
  lastMessageAt: Date | null;
  lastResponse: any;
  turnLockUntil: Date | null;
  /** Mientras no venza, /brain responde `silenced` y BuilderBot no contesta. */
  silencedUntil: Date | null;
  humanRequestedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const messageSchema = new Schema<IWhatsappSessionMessage>(
  {
    role: { type: String, enum: ["user", "assistant"] },
    content: { type: String, default: "" },
    // Foto o PDF que mandó el cliente (para verla desde el panel).
    mediaUrl: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const whatsappSessionSchema = new Schema<IWhatsappSession>(
  {
    phone: { type: String, required: true, unique: true },
    state: { type: Schema.Types.Mixed, default: null },
    history: { type: [messageSchema], default: [] },
    // Reintentos de BuilderBot: mismo mensaje en menos de 5 s recibe la misma respuesta.
    lastMessageHash: { type: String, default: "" },
    lastMessageAt: { type: Date, default: null },
    lastResponse: { type: Schema.Types.Mixed, default: null },
    // Candado por teléfono: dos burbujas seguidas se procesan en orden.
    turnLockUntil: { type: Date, default: null },
    silencedUntil: { type: Date, default: null },
    humanRequestedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// La conversación se olvida tras 3 días sin mensajes. Los pedidos quedan en
// Order y se encuentran por teléfono.
whatsappSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

export const WhatsappSession =
  mongoose.models.WhatsappSession ||
  mongoose.model<IWhatsappSession>("WhatsappSession", whatsappSessionSchema);
