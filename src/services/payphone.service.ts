import axios from "axios";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";

const CONFIRM_URL = "https://paymentbox.payphonetodoesposible.com/api/confirm";
const SALE_URL = "https://pay.payphonetodoesposible.com/api/Sale/client";

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

export interface PayphoneSale {
  found: boolean;
  statusCode?: number;
  transactionStatus?: string;
  transactionId?: number;
  error?: string;
}

/**
 * Estado de una venta por clientTransactionId. Sirve cuando el cliente cierra la
 * pestaña de pago y escribe "ya pagué" en WhatsApp: no hay redirección a
 * /pay-response, así que se pregunta a Payphone. Nunca lanza.
 */
export async function getSale(clientTransactionId: string): Promise<PayphoneSale> {
  if (!isPayphoneConfigured()) return { found: false, error: "Payphone no está configurado" };
  try {
    const response = await axios.get(`${SALE_URL}/${encodeURIComponent(clientTransactionId)}`, {
      headers: { Authorization: `Bearer ${env.PAYPHONE_TOKEN}` },
      timeout: 8000,
      validateStatus: (status) => status < 500,
    });
    const data: any = Array.isArray(response.data) ? response.data[0] : response.data;
    if (
      response.status >= 400 ||
      !data ||
      typeof data !== "object" ||
      data.errorCode !== undefined
    ) {
      return { found: false, error: data?.message || `Payphone respondió ${response.status}` };
    }
    return {
      found: true,
      statusCode: Number(data.statusCode) || undefined,
      transactionStatus: data.transactionStatus,
      transactionId: Number(data.transactionId) || undefined,
    };
  } catch (error: any) {
    return { found: false, error: error?.message || "Payphone no respondió" };
  }
}

/** Qué hacer con lo que dice la consulta, sin tocar la base. */
export function decideFromSale(sale: PayphoneSale): "pending" | "rejected" | "confirm" {
  if (!sale.found) return "pending";
  const declined =
    sale.statusCode === PAYPHONE_CANCELED || /cancel/i.test(sale.transactionStatus || "");
  if (declined && !sale.transactionId) return "rejected";
  if (!sale.transactionId) return "pending";
  const approved = sale.statusCode === PAYPHONE_APPROVED || sale.transactionStatus === "Approved";
  if (approved) return "confirm";
  return declined ? "rejected" : "pending";
}
