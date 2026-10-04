import axios from "axios";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";

const CONFIRM_URL = "https://paymentbox.payphonetodoesposible.com/api/confirm";

export const PAYPHONE_APPROVED = 3;
export const PAYPHONE_CANCELED = 2;

export function isPayphoneConfigured(): boolean {
  return !!(env.PAYPHONE_TOKEN && env.PAYPHONE_STORE_ID);
}

export function getPayphoneConfig(): { token: string; storeId: string } {
  if (!isPayphoneConfigured()) {
    throw new CustomError("El pago con tarjeta no está disponible por ahora", 503);
  }
  return { token: env.PAYPHONE_TOKEN, storeId: env.PAYPHONE_STORE_ID };
}

/**
 * Confirma una transacción de la Cajita. Hay que llamarlo dentro de los 5 minutos
 * o Payphone reversa el cobro. Devuelve la respuesta completa para guardarla.
 */
export async function confirm(id: number | string, clientTransactionId: string): Promise<any> {
  const { token } = getPayphoneConfig();
  try {
    const { data } = await axios.post(
      CONFIRM_URL,
      { id: Number(id), clientTxId: clientTransactionId },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 },
    );
    return data;
  } catch (error: any) {
    const payload = error?.response?.data;
    console.error("[payphone] confirm falló:", error?.response?.status, payload ?? error?.message);
    throw new CustomError(
      `No pudimos confirmar el pago con Payphone${payload?.message ? `: ${payload.message}` : ""}`,
      502,
      payload,
    );
  }
}
