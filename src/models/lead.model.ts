import mongoose, { Schema, Types } from "mongoose";

export interface ILeadItem {
  productId: Types.ObjectId;
  variantId: string | null;
  title: string;
  quantity: number;
}

export interface ILead {
  phone: string;
  firstName: string;
  items: ILeadItem[];
  converted: boolean;
  orderId: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const leadItemSchema = new Schema<ILeadItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    variantId: { type: String, default: null },
    title: { type: String, default: "" },
    quantity: { type: Number, default: 1 },
  },
  { _id: false },
);

const leadSchema = new Schema<ILead>(
  {
    phone: { type: String, required: true, index: true },
    firstName: { type: String, default: "" },
    items: { type: [leadItemSchema], default: [] },
    converted: { type: Boolean, default: false, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
  },
  { timestamps: true },
);

export const Lead = mongoose.models.Lead || mongoose.model<ILead>("Lead", leadSchema);

/** Al crear un pedido con ese teléfono, el carrito deja de estar abandonado. */
export async function markLeadConverted(
  phone: string,
  orderId: Types.ObjectId | string,
): Promise<void> {
  await Lead.updateMany({ phone, converted: false }, { $set: { converted: true, orderId } });
}
