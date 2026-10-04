import * as dropiService from "./dropi.service";

/** Dominio que Dropi debe tener registrado en la integración. */
const STORE_HOST = "kovashopper.com";
/** Cada consulta pega a Dropi: se guarda el resultado un minuto. */
const CACHE_MS = 60_000;
/** "Probar de nuevo" salta la caché, pero no más seguido que esto. */
const MIN_REFRESH_MS = 10_000;

export interface DropiStatus {
  configured: boolean;
  connected: boolean;
  message: string;
  blockedIp: string | null;
  integrationUrl: string | null;
  urlMismatch: boolean;
  checkedAt: string;
}

let cached: { at: number; value: DropiStatus } | null = null;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

async function check(): Promise<DropiStatus> {
  const checkedAt = new Date().toISOString();

  if (!dropiService.isDropiConfigured()) {
    return {
      configured: false,
      connected: false,
      message:
        "Falta DROPI_INTEGRATION_KEY en el servidor. Créala en Dropi → Mis Integraciones y agrégala al backend.",
      blockedIp: null,
      integrationUrl: null,
      urlMismatch: false,
      checkedAt,
    };
  }

  const payload = dropiService.integrationTokenPayload();
  const integrationUrl = payload?.integration_url ? String(payload.integration_url) : null;
  const urlMismatch = !!integrationUrl && hostOf(integrationUrl) !== STORE_HOST;
  const urlNote = urlMismatch
    ? ` Ojo: la integración está registrada con ${integrationUrl}, no con https://${STORE_HOST}.`
    : "";

  const probe = await dropiService.probeConnection();

  let message: string;
  if (probe.ok) {
    message = "Conectado a Dropi.";
  } else if (/access denied/i.test(probe.message) || probe.status === 401 || probe.status === 403) {
    message = probe.ip
      ? `Dropi bloquea la IP ${probe.ip}. Pide a soporte de Dropi que la agregue a tu integración.`
      : "Dropi rechazó el acceso. Pide a soporte de Dropi que habilite tu integración.";
  } else {
    message = `Dropi no respondió bien (${probe.status ?? "sin respuesta"}): ${probe.message}`;
  }

  return {
    configured: true,
    connected: probe.ok,
    message: message + urlNote,
    blockedIp: probe.ok ? null : probe.ip,
    integrationUrl,
    urlMismatch,
    checkedAt,
  };
}

export async function getStatus(refresh = false): Promise<DropiStatus> {
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < (refresh ? MIN_REFRESH_MS : CACHE_MS)) return cached.value;
  const value = await check();
  cached = { at: Date.now(), value };
  return value;
}
