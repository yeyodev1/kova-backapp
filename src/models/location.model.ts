import mongoose, { Schema } from "mongoose";

export const LOCATION_KINDS = ["province", "city"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export interface ILocation {
  kind: LocationKind;
  dropiId: number;
  name: string;
  /** Solo ciudades: dropiId de la provincia. */
  provinceId: number | null;
  /** Respuesta original de Dropi, por si la creación de órdenes pide otro campo. */
  raw: unknown;
  createdAt?: Date;
  updatedAt?: Date;
}

const locationSchema = new Schema<ILocation>(
  {
    kind: { type: String, enum: LOCATION_KINDS, required: true },
    dropiId: { type: Number, required: true },
    name: { type: String, required: true, trim: true },
    provinceId: { type: Number, default: null },
    raw: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

locationSchema.index({ kind: 1, dropiId: 1 }, { unique: true });
locationSchema.index({ kind: 1, provinceId: 1 });

export const Location =
  mongoose.models.Location || mongoose.model<ILocation>("Location", locationSchema);
