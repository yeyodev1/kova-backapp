import mongoose, { Schema } from "mongoose";

export interface IBankAccount {
  bank: string;
  type: string;
  number: string;
  holder: string;
  idNumber: string;
}

export interface ISettings {
  key: string;
  codSurcharge: number;
  transferSurcharge: number;
  shippingFee: number;
  freeShippingFrom: number;
  announcement: string;
  whatsapp: string;
  bankAccounts: IBankAccount[];
  defaultMarkupPercent: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const bankAccountSchema = new Schema<IBankAccount>(
  {
    bank: { type: String, default: "" },
    type: { type: String, default: "" },
    number: { type: String, default: "" },
    holder: { type: String, default: "" },
    idNumber: { type: String, default: "" },
  },
  { _id: false },
);

const settingSchema = new Schema<ISettings>(
  {
    // Documento único: la clave fija evita que aparezca un segundo singleton.
    key: { type: String, default: "main", unique: true },
    codSurcharge: { type: Number, default: 300 },
    transferSurcharge: { type: Number, default: 150 },
    shippingFee: { type: Number, default: 0 },
    freeShippingFrom: { type: Number, default: 0 },
    announcement: { type: String, default: "Envío a todo Ecuador · Paga al recibir disponible" },
    whatsapp: { type: String, default: "593997011366" },
    bankAccounts: { type: [bankAccountSchema], default: [] },
    defaultMarkupPercent: { type: Number, default: 60 },
  },
  { timestamps: true },
);

export const Setting =
  mongoose.models.Setting || mongoose.model<ISettings>("Setting", settingSchema);

/** Devuelve la configuración y la crea con los valores por defecto si no existe. */
export async function getSettings(): Promise<ISettings> {
  const doc = await Setting.findOneAndUpdate(
    { key: "main" },
    { $setOnInsert: { key: "main" } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return doc as unknown as ISettings;
}
