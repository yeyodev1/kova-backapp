import { getSettings } from "../models/setting.model";

/** Configuración pública: sin el margen de importación ni metadatos internos. */
export async function publicSettings() {
  const settings = await getSettings();
  return {
    codSurcharge: settings.codSurcharge,
    transferSurcharge: settings.transferSurcharge,
    shippingFee: settings.shippingFee,
    freeShippingFrom: settings.freeShippingFrom,
    announcement: settings.announcement,
    whatsapp: settings.whatsapp,
    bankAccounts: settings.bankAccounts || [],
  };
}
