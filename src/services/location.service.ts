import { Location } from "../models/location.model";
import { isDropiConfigured } from "./dropi.service";
import { syncLocations } from "./dropiSync.service";

/** Evita que cada visita al checkout dispare otra descarga si Dropi falla. */
const RETRY_AFTER_MS = 10 * 60 * 1000;
let lastAttempt = 0;
let syncing: Promise<unknown> | null = null;

/** Primera visita con la colección vacía: se descargan de Dropi una vez. */
async function ensureLocations() {
  if (await Location.exists({ kind: "province" })) return;
  if (!isDropiConfigured()) return;
  if (!syncing && Date.now() - lastAttempt > RETRY_AFTER_MS) {
    lastAttempt = Date.now();
    syncing = syncLocations()
      .catch((error) =>
        console.error("[locations] no se pudieron descargar de Dropi:", error?.message),
      )
      .finally(() => {
        syncing = null;
      });
  }
  if (syncing) await syncing;
}

export async function getProvinces() {
  await ensureLocations();
  const list = await Location.find({ kind: "province" })
    .collation({ locale: "es" })
    .sort({ name: 1 })
    .lean();
  return list.map((p: any) => ({ id: p.dropiId, name: p.name }));
}

export async function getCities(provinceId: number) {
  await ensureLocations();
  const list = await Location.find({ kind: "city", provinceId })
    .collation({ locale: "es" })
    .sort({ name: 1 })
    .lean();
  return list.map((c: any) => ({ id: c.dropiId, name: c.name, provinceId: c.provinceId }));
}
