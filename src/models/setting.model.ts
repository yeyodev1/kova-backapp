import mongoose, { Schema, Types } from "mongoose";
import { guessBankCode } from "../services/banks";

// "Transaccional" es como Banco Pichincha llama a su cuenta básica.
export const BANK_ACCOUNT_TYPES = ["Ahorros", "Corriente", "Transaccional"] as const;

export interface IBankAccount {
  _id?: Types.ObjectId | string;
  bank: string;
  /** Clave del catálogo de `services/banks.ts` ("pichincha") u "otro". */
  bankCode?: string;
  type: string;
  number: string;
  holder: string;
  idNumber: string;
  /** Pausada = no se muestra en la web, ni en correos, ni en el bot. */
  active?: boolean;
  logoUrl?: string;
}

export interface ISettings {
  key: string;
  codSurcharge: number;
  transferSurcharge: number;
  shippingFee: number;
  freeShippingFrom: number;
  announcement: string;
  whatsapp: string;
  /** Interruptor general: apagado, ni la web ni el bot ofrecen transferencia. */
  acceptTransfers?: boolean;
  bankAccounts: IBankAccount[];
  defaultMarkupPercent: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const bankAccountSchema = new Schema<IBankAccount>(
  {
    bank: { type: String, default: "" },
    bankCode: { type: String, default: "otro" },
    type: { type: String, default: "" },
    number: { type: String, default: "" },
    holder: { type: String, default: "" },
    idNumber: { type: String, default: "" },
    active: { type: Boolean, default: true },
    logoUrl: { type: String, default: "" },
  },
  // Cada cuenta lleva _id: el panel la edita, pausa y borra por id.
  { _id: true },
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
    // Sin default: si falta, `getSettings` lo calcula una vez (migración suave).
    acceptTransfers: { type: Boolean },
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
  return migrateTransfers(doc as unknown as ISettings);
}

/**
 * Documentos viejos: cuentas sin _id, estado ni banco del catálogo, y sin el
 * interruptor. Las transferencias quedan activas solo si ya había cuentas.
 */
async function migrateTransfers(settings: ISettings): Promise<ISettings> {
  const accounts = settings.bankAccounts || [];
  const stale =
    settings.acceptTransfers === undefined ||
    accounts.some((a) => !a._id || a.active === undefined || !a.bankCode);
  if (!stale) return settings;

  const bankAccounts = accounts.map((a) => ({
    ...a,
    _id: a._id || new Types.ObjectId(),
    bankCode: a.bankCode || guessBankCode(a.bank),
    active: a.active ?? true,
    logoUrl: a.logoUrl || "",
  }));
  const acceptTransfers =
    settings.acceptTransfers ?? bankAccounts.some((a) => a.active && a.number);
  await Setting.updateOne({ key: "main" }, { $set: { bankAccounts, acceptTransfers } });
  return { ...settings, bankAccounts, acceptTransfers };
}

/** Cuentas que el cliente puede ver: activas y con número. */
export const activeBankAccounts = (settings: ISettings): IBankAccount[] =>
  (settings.bankAccounts || []).filter((a) => a.active !== false && a.number);

/** Transferencia disponible: interruptor encendido y al menos una cuenta activa. */
export const transfersEnabled = (settings: ISettings): boolean =>
  Boolean(settings.acceptTransfers) && activeBankAccounts(settings).length > 0;
