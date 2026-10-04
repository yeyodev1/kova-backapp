import mongoose, { Schema, Types } from "mongoose";

export const PAYMENT_METHODS = ["card", "cod", "transfer"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["pending", "paid", "cod", "failed", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const ORDER_STATUSES = [
  "pending_payment",
  "awaiting_transfer",
  "transfer_review",
  "confirmed",
  "sent_to_dropi",
  "shipped",
  "delivered",
  "returned",
  "cancelled",
  "failed",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface IOrderItem {
  product: Types.ObjectId;
  variantId: string | null;
  title: string;
  variantName: string;
  image: string;
  quantity: number;
  unitPrice: number;
  total: number;
  /** Copia de los ids de Dropi al momento de la compra: el producto puede cambiar después. */
  dropiId: number | null;
  dropiVariationId: number | null;
}

export interface IOrderHistory {
  status: string;
  note: string;
  at: Date;
}

export interface IOrder {
  _id: Types.ObjectId;
  number: string;
  customer: { firstName: string; lastName: string; phone: string; email: string; idNumber: string };
  address: {
    provinceId: number;
    province: string;
    cityId: number;
    city: string;
    street: string;
    reference: string;
  };
  items: IOrderItem[];
  subtotal: number;
  shippingFee: number;
  surcharge: number;
  total: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  status: OrderStatus;
  transfer: { receiptUrl: string; uploadedAt: Date | null; confirmedAt: Date | null };
  dropi: {
    orderId: number | null;
    status: string;
    guide: string;
    carrier: string;
    error: string;
    lastSyncAt: Date | null;
    /** Candado para no crear dos veces el mismo pedido en Dropi. */
    lockedAt: Date | null;
  };
  payphone: { clientTransactionId: string; transactionId: string; response: unknown };
  utm: Record<string, string>;
  notes: string;
  /** true cuando ya se descontó stock y se sumó soldCount. */
  stockApplied: boolean;
  history: IOrderHistory[];
  createdAt?: Date;
  updatedAt?: Date;
}

const itemSchema = new Schema<IOrderItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    variantId: { type: String, default: null },
    title: { type: String, default: "" },
    variantName: { type: String, default: "" },
    image: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    dropiId: { type: Number, default: null },
    dropiVariationId: { type: Number, default: null },
  },
  { _id: false },
);

const historySchema = new Schema<IOrderHistory>(
  {
    status: { type: String, default: "" },
    note: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder>(
  {
    number: { type: String, required: true, unique: true },
    customer: {
      firstName: { type: String, default: "" },
      lastName: { type: String, default: "" },
      phone: { type: String, default: "", index: true },
      email: { type: String, default: "" },
      idNumber: { type: String, default: "" },
    },
    address: {
      provinceId: { type: Number, default: 0 },
      province: { type: String, default: "" },
      cityId: { type: Number, default: 0 },
      city: { type: String, default: "" },
      street: { type: String, default: "" },
      reference: { type: String, default: "" },
    },
    items: { type: [itemSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    shippingFee: { type: Number, default: 0 },
    surcharge: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: "pending" },
    status: { type: String, enum: ORDER_STATUSES, default: "pending_payment", index: true },
    transfer: {
      receiptUrl: { type: String, default: "" },
      uploadedAt: { type: Date, default: null },
      confirmedAt: { type: Date, default: null },
    },
    dropi: {
      orderId: { type: Number, default: null },
      status: { type: String, default: "" },
      guide: { type: String, default: "" },
      carrier: { type: String, default: "" },
      error: { type: String, default: "" },
      lastSyncAt: { type: Date, default: null },
      lockedAt: { type: Date, default: null },
    },
    payphone: {
      clientTransactionId: { type: String, default: "" },
      transactionId: { type: String, default: "" },
      response: { type: Schema.Types.Mixed, default: null },
    },
    utm: { type: Schema.Types.Mixed, default: {} },
    notes: { type: String, default: "" },
    stockApplied: { type: Boolean, default: false },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

orderSchema.index({ createdAt: -1 });
orderSchema.index({ "payphone.clientTransactionId": 1 });
orderSchema.index({ "dropi.orderId": 1 });

export const Order = mongoose.models.Order || mongoose.model<IOrder>("Order", orderSchema);

/** Vista del cliente: sin respuesta de Payphone, bitácora interna ni candados. */
export function toPublicOrder(order: any): Record<string, any> {
  const plain = typeof order?.toObject === "function" ? order.toObject() : { ...order };
  delete plain.payphone;
  delete plain.history;
  delete plain.utm;
  delete plain.stockApplied;
  delete plain.__v;
  if (plain.dropi) {
    const { lockedAt, ...dropi } = plain.dropi;
    plain.dropi = dropi;
  }
  plain.items = (plain.items || []).map((item: any) => {
    const { dropiId, dropiVariationId, ...rest } = item;
    return rest;
  });
  return plain;
}
