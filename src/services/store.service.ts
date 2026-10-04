import { activeBankAccounts, getSettings, transfersEnabled } from "../models/setting.model";
import { publicAccount } from "./payments.service";

/** Configuración pública: sin el margen de importación ni metadatos internos. */
export async function publicSettings() {
  const settings = await getSettings();
  const acceptTransfers = transfersEnabled(settings);
  return {
    codSurcharge: settings.codSurcharge,
    transferSurcharge: settings.transferSurcharge,
    shippingFee: settings.shippingFee,
    freeShippingFrom: settings.freeShippingFrom,
    announcement: settings.announcement,
    whatsapp: settings.whatsapp,
    acceptTransfers,
    // Nunca las pausadas; con transferencias apagadas, ninguna.
    bankAccounts: acceptTransfers ? activeBankAccounts(settings).map(publicAccount) : [],
  };
}
