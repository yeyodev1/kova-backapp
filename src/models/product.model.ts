import mongoose, { Schema, Types } from "mongoose";

export const PRODUCT_TYPES = ["SIMPLE", "VARIABLE"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export interface IProductVariant {
  _id: Types.ObjectId;
  dropiVariationId: number | null;
  name: string;
  attributes: Record<string, string>;
  price: number;
  compareAtPrice: number;
  stock: number;
  sku: string;
  /** Solo admin: costo y sugerido de la variación en Dropi. */
  costPrice: number;
  suggestedPrice: number;
}

export interface IProductOffer {
  quantity: number;
  unitPrice: number;
  label: string;
  isDefault: boolean;
}

export interface IProductFaq {
  question: string;
  answer: string;
}

export interface IProduct {
  _id: Types.ObjectId;
  slug: string;
  title: string;
  shortDescription: string;
  description: string;
  images: string[];
  category: string;
  price: number;
  compareAtPrice: number;
  type: ProductType;
  variants: IProductVariant[];
  offers: IProductOffer[];
  benefits: string[];
  faqs: IProductFaq[];
  stock: number;
  isPublished: boolean;
  isFeatured: boolean;
  soldCount: number;
  // Nunca null: el índice sparse solo ignora documentos sin el campo.
  dropiId?: number;
  dropiSupplierId: number | null;
  costPrice: number;
  suggestedPrice: number;
  lastSyncedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const variantSchema = new Schema<IProductVariant>({
  dropiVariationId: { type: Number, default: null },
  name: { type: String, default: "" },
  attributes: { type: Schema.Types.Mixed, default: {} },
  price: { type: Number, default: 0 },
  compareAtPrice: { type: Number, default: 0 },
  stock: { type: Number, default: 0 },
  sku: { type: String, default: "" },
  costPrice: { type: Number, default: 0 },
  suggestedPrice: { type: Number, default: 0 },
});

const offerSchema = new Schema<IProductOffer>(
  {
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    label: { type: String, default: "" },
    isDefault: { type: Boolean, default: false },
  },
  { _id: false },
);

const faqSchema = new Schema<IProductFaq>(
  {
    question: { type: String, default: "" },
    answer: { type: String, default: "" },
  },
  { _id: false },
);

const productSchema = new Schema<IProduct>(
  {
    slug: { type: String, required: true, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    shortDescription: { type: String, default: "" },
    description: { type: String, default: "" },
    images: { type: [String], default: [] },
    category: { type: String, default: "", index: true },
    price: { type: Number, default: 0 },
    compareAtPrice: { type: Number, default: 0 },
    type: { type: String, enum: PRODUCT_TYPES, default: "SIMPLE" },
    variants: { type: [variantSchema], default: [] },
    offers: { type: [offerSchema], default: [] },
    benefits: { type: [String], default: [] },
    faqs: { type: [faqSchema], default: [] },
    stock: { type: Number, default: 0 },
    isPublished: { type: Boolean, default: false, index: true },
    isFeatured: { type: Boolean, default: false, index: true },
    soldCount: { type: Number, default: 0 },
    // sparse: los productos creados a mano no tienen dropiId y no chocan entre sí.
    dropiId: { type: Number, unique: true, sparse: true },
    dropiSupplierId: { type: Number, default: null },
    costPrice: { type: Number, default: 0 },
    suggestedPrice: { type: Number, default: 0 },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

productSchema.index({ isPublished: 1, soldCount: -1 });

export const Product =
  mongoose.models.Product || mongoose.model<IProduct>("Product", productSchema);

const ADMIN_FIELDS = [
  "dropiId",
  "dropiSupplierId",
  "costPrice",
  "suggestedPrice",
  "lastSyncedAt",
  "__v",
] as const;

/** Quita los campos que solo ve administración (costos, ids de Dropi). */
export function toPublicProduct(product: any): Record<string, any> {
  const plain = typeof product?.toObject === "function" ? product.toObject() : { ...product };
  for (const field of ADMIN_FIELDS) delete plain[field];
  plain.variants = (plain.variants || []).map((v: any) => {
    const { costPrice, suggestedPrice, ...rest } = v;
    return rest;
  });
  return plain;
}
