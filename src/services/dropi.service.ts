import axios, { AxiosInstance, Method } from "axios";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";

/**
 * Cliente de la API de integraciones de Dropi Ecuador.
 *
 * Fuentes: plugin oficial de WooCommerce (wc-dropi-integration / "Dropify") y
 * el PDF "Integrations: Core Dropi" (2024).
 *
 * Confirmado en esas fuentes:
 * - Header `dropi-integration-key` y la forma `{ isSuccess, status, message, objects, count }`.
 * - POST /products/index (catálogo), GET /products/v2/{id} (detalle), GET /department,
 *   POST /trajectory/bycity, POST /orders/myorders (crear) y GET /orders/myorders/{id}.
 * - Imágenes: urlS3 vía CloudFront, si no `api.dropi.ec/` + url.
 *
 * Pendiente de validar con la cuenta real:
 * - Si `state`/`city` del pedido se mandan como nombre (así lo hace el plugin) y si en EC
 *   coinciden exactamente con los de /department y /trajectory/bycity.
 * - Si `total_order` y `price` aceptan decimales en dólares (Dropi Colombia usa pesos enteros).
 * - El endpoint de cancelación (PUT /orders/myorders/{id} con status CANCELADO) no está documentado.
 * - Si `client_email` vacío es aceptado (por eso se manda un correo de la tienda como respaldo).
 */

export interface DropiResponse<T = any> {
  isSuccess?: boolean;
  status?: number;
  message?: string;
  objects: T;
  count?: number;
}

const CDN_URL = "https://d39ru7awumhhs2.cloudfront.net/";
const API_ASSETS_URL = "https://api.dropi.ec/";

let client: AxiosInstance | null = null;

export function isDropiConfigured(): boolean {
  return !!env.DROPI_INTEGRATION_KEY;
}

function getClient(): AxiosInstance {
  if (!isDropiConfigured()) {
    throw new CustomError("Dropi no está configurado: falta DROPI_INTEGRATION_KEY", 503);
  }
  if (!client) {
    client = axios.create({
      baseURL: env.DROPI_API_URL.replace(/\/+$/, ""),
      timeout: 25000,
      headers: {
        "dropi-integration-key": env.DROPI_INTEGRATION_KEY,
        "Content-Type": "application/json;charset=UTF-8",
        Accept: "application/json",
      },
    });
  }
  return client;
}

async function request<T = any>(
  method: Method,
  path: string,
  data?: unknown,
): Promise<DropiResponse<T>> {
  const http = getClient();
  try {
    const response = await http.request<DropiResponse<T>>({ method, url: path, data });
    const body = response.data;
    if (body && body.isSuccess === false) {
      console.error(`[dropi] ${method} ${path} rechazado:`, body.message, body.objects ?? "");
      throw new CustomError(`Dropi: ${body.message || "rechazó la solicitud"}`, 502, body);
    }
    return body;
  } catch (error: any) {
    if (error instanceof CustomError) throw error;
    // Solo se loguea status y cuerpo: el config de axios trae el header con la llave.
    const status = error?.response?.status;
    const payload = error?.response?.data;
    console.error(
      `[dropi] ${method} ${path} falló (${status ?? error?.code ?? "sin respuesta"}):`,
      payload ?? error?.message,
    );
    if (payload?.ip && /access denied/i.test(String(payload?.message || ""))) {
      throw new CustomError(
        `Dropi bloquea la IP ${payload.ip}. Pide a soporte de Dropi que la agregue a tu integración.`,
        502,
        { status, blockedIp: String(payload.ip) },
      );
    }
    const message =
      (payload && typeof payload === "object" && (payload.message || payload.error)) ||
      (error?.code === "ECONNABORTED" ? "tiempo de espera agotado" : "no respondió");
    throw new CustomError(`Dropi: ${message}`, 502, { status, payload });
  }
}

// ── Diagnóstico de la conexión ──────────────────────────────────────────────

export interface DropiProbe {
  ok: boolean;
  status: number | null;
  message: string;
  /** IP de origen que Dropi reporta cuando rechaza por lista blanca. */
  ip: string | null;
}

/**
 * Llamada liviana para saber si Dropi nos deja entrar. No lanza: el panel necesita
 * el cuerpo del 401 ("Access denied" + ip) para explicar el bloqueo.
 */
export async function probeConnection(): Promise<DropiProbe> {
  try {
    const response = await getClient().get<DropiResponse>("/department");
    const body = response.data;
    if (body && body.isSuccess === false) {
      return { ok: false, status: response.status, message: String(body.message || ""), ip: null };
    }
    return { ok: true, status: response.status, message: "", ip: null };
  } catch (error: any) {
    if (error instanceof CustomError) throw error;
    const payload = error?.response?.data;
    const message =
      (payload && typeof payload === "object" && String(payload.message || payload.error || "")) ||
      (error?.code === "ECONNABORTED" ? "tiempo de espera agotado" : "no respondió");
    const ip = payload && typeof payload === "object" && payload.ip ? String(payload.ip) : null;
    return { ok: false, status: error?.response?.status ?? null, message, ip };
  }
}

/**
 * Lee el payload del token de integración (JWT) sin verificar la firma: solo se usan
 * datos públicos como `integration_url`. El token nunca sale del servidor.
 */
export function integrationTokenPayload(): Record<string, any> | null {
  const part = env.DROPI_INTEGRATION_KEY.split(".")[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/** Dropi Ecuador maneja dólares con decimales; acá todo va en centavos. */
export function toCents(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Centavos → dólares con 2 decimales, como número. */
export function toDollars(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

export function dropiImageUrl(item: any): string {
  if (!item) return "";
  if (item.urlS3) return CDN_URL + encodeURI(String(item.urlS3).replace(/^\/+/, ""));
  if (item.url) {
    const url = String(item.url);
    if (/^https?:\/\//i.test(url)) return url;
    return API_ASSETS_URL + encodeURI(url.replace(/^\/+/, ""));
  }
  return "";
}

/** Suma el stock de las bodegas de un producto simple. */
export function productStock(product: any): number {
  const warehouses = Array.isArray(product?.warehouse_product) ? product.warehouse_product : [];
  if (warehouses.length) {
    return warehouses.reduce((acc: number, w: any) => acc + (Number(w?.stock) || 0), 0);
  }
  return Number(product?.stock) || 0;
}

export function variationStock(variation: any): number {
  const warehouses = Array.isArray(variation?.warehouse_product_variation)
    ? variation.warehouse_product_variation
    : [];
  if (warehouses.length) {
    return warehouses.reduce((acc: number, w: any) => acc + (Number(w?.stock) || 0), 0);
  }
  return Number(variation?.stock) || 0;
}

/** Estado de Dropi → estado nuestro. El texto original se guarda aparte. */
export function mapDropiStatus(
  raw: string,
): "delivered" | "returned" | "cancelled" | "shipped" | "sent_to_dropi" {
  const status = String(raw || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (status.includes("ENTREGADO")) return "delivered";
  if (status.includes("DEVOLU")) return "returned";
  if (status.includes("CANCELADO") || status.includes("RECHAZADO")) return "cancelled";
  const shipped = [
    "GUIA_GENERADA",
    "GUIA GENERADA",
    "EN TRANSITO",
    "EN REPARTO",
    "DESPACHADA",
    "EN BODEGA",
  ];
  if (shipped.some((s) => status.includes(s))) return "shipped";
  return "sent_to_dropi";
}

// ── Catálogo ────────────────────────────────────────────────────────────────

export async function listProducts(params: {
  keywords?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ objects: any[]; count: number }> {
  const pageSize = Math.min(Math.max(params.pageSize || 20, 1), 50);
  const page = Math.max(params.page || 1, 1);
  const body = await request<any[]>("POST", "/products/index", {
    pageSize,
    startData: (page - 1) * pageSize,
    no_count: false,
    order_by: "id",
    order_type: "desc",
    keywords: params.keywords || "",
    active: true,
    integration: true,
    privated_product: false,
    favorite: false,
  });
  const objects = Array.isArray(body?.objects) ? body.objects : [];
  return { objects, count: Number(body?.count) || objects.length };
}

export async function getProduct(id: number): Promise<any> {
  const body = await request<any>("GET", `/products/v2/${id}`);
  const product = Array.isArray(body?.objects) ? body.objects[0] : body?.objects;
  if (!product) throw new CustomError("Dropi no devolvió el producto", 404);
  return product;
}

// ── Ubicaciones ─────────────────────────────────────────────────────────────

export async function getProvinces(): Promise<any[]> {
  const body = await request<any[]>("GET", "/department");
  return Array.isArray(body?.objects) ? body.objects : [];
}

export async function getCities(departmentId: number): Promise<any[]> {
  const body = await request<any>("POST", "/trajectory/bycity", {
    department_id: departmentId,
    rate_type: "CON RECAUDO",
  });
  const objects = body?.objects;
  if (Array.isArray(objects)) return objects;
  // Algunas versiones envuelven la lista en { cities: [...] }.
  if (Array.isArray(objects?.cities)) return objects.cities;
  return [];
}

// ── Órdenes ─────────────────────────────────────────────────────────────────

export interface DropiOrderPayload {
  calculate_costs_and_shiping: boolean;
  state: string;
  city: string;
  client_email: string;
  name: string;
  surname: string;
  dir: string;
  notes: string;
  payment_method_id: number;
  phone: string;
  rate_type: "CON RECAUDO" | "SIN RECAUDO";
  type: "FINAL_ORDER";
  total_order: number;
  shop_order_id: string;
  dni: string;
  products: { id: number; price: number; variation_id: number | null; quantity: number }[];
}

export async function createOrder(
  payload: DropiOrderPayload,
): Promise<{ id: number; status: string }> {
  const body = await request<any>("POST", "/orders/myorders", payload);
  const created = Array.isArray(body?.objects) ? body.objects[0] : body?.objects;
  const id = Number(created?.id);
  if (!id) throw new CustomError("Dropi no devolvió el id del pedido", 502, body);
  return { id, status: String(created?.status || "") };
}

export async function getOrder(
  id: number,
): Promise<{ status: string; guide: string; carrier: string; raw: any }> {
  const body = await request<any>("GET", `/orders/myorders/${id}`);
  const order = Array.isArray(body?.objects) ? body.objects[0] : body?.objects;
  const carrier = order?.shipping_company ?? order?.distribution_company ?? "";
  return {
    status: String(order?.status || ""),
    guide: String(order?.shipping_guide || ""),
    carrier: String(typeof carrier === "object" ? carrier?.name || "" : carrier || ""),
    raw: order,
  };
}

export async function cancelOrder(id: number): Promise<void> {
  await request("PUT", `/orders/myorders/${id}`, { status: "CANCELADO" });
}
