import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { ORDER_STATUSES, Order, PAYMENT_METHODS } from "../models/order.model";
import { Product } from "../models/product.model";
import { escapeRegex } from "../utils/regex";

/**
 * Exportación de pedidos para cargarlos a mano en Dropi. Sale en CSV con `;` y BOM porque
 * así lo abre bien Excel en español (con `,` mete todo en una sola columna).
 */

const SEPARATOR = ";";
const MAX_ORDERS = 1000;
/** Ecuador continental no tiene horario de verano: UTC-5 fijo. */
const OFFSET_MS = 5 * 60 * 60 * 1000;

const PAYMENT_LABELS: Record<string, string> = {
  card: "Tarjeta",
  cod: "Contra entrega",
  transfer: "Transferencia",
};

const HEADERS = [
  "Número de pedido",
  "Fecha",
  "Nombre",
  "Apellido",
  "Celular",
  "Cédula",
  "Correo",
  "Provincia",
  "Ciudad",
  "Dirección",
  "Referencia",
  "ID producto Dropi",
  "ID variación Dropi",
  "Producto",
  "Variante",
  "Cantidad",
  "Precio unitario",
  "Total del pedido",
  "Método de pago",
  "Cobrar al entregar",
  "Valor a recaudar",
  "Notas",
];

function dollars(cents: number): string {
  return (Number(cents || 0) / 100).toFixed(2);
}

function ecDateTime(date: Date | undefined): string {
  if (!date) return "";
  return new Date(new Date(date).getTime() - OFFSET_MS)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

/** "2026-10-03" en hora de Ecuador → instante UTC. `endOfDay` incluye todo ese día. */
function parseEcDate(value: unknown, endOfDay: boolean): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new CustomError("Las fechas van en formato AAAA-MM-DD", 400);
  }
  const start = new Date(`${raw}T00:00:00.000Z`).getTime() + OFFSET_MS;
  if (Number.isNaN(start)) throw new CustomError("Fecha no válida", 400);
  return new Date(endOfDay ? start + 24 * 60 * 60 * 1000 - 1 : start);
}

function cell(value: unknown): string {
  let text = String(value ?? "")
    .replace(/\r?\n/g, " ")
    .trim();
  // Evita que Excel ejecute fórmulas escritas por el cliente en notas o dirección.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (text.includes(SEPARATOR) || text.includes('"')) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Celular y cédula empiezan en 0: Excel los convierte en número y se come el cero.
 * Como fórmula de texto se ven y se copian completos.
 */
function keepZeros(value: string): string {
  const digits = String(value || "").trim();
  return digits ? `="${digits.replace(/"/g, "")}"` : "";
}

function buildFilter(query: Record<string, unknown>) {
  const ids = String(query.ids ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length) {
    const valid = ids.filter((id) => isValidObjectId(id));
    if (!valid.length) throw new CustomError("Los pedidos seleccionados no son válidos", 400);
    return { _id: { $in: valid.slice(0, MAX_ORDERS) } };
  }

  const filter: Record<string, unknown> = {};
  const status = String(query.status ?? "").trim() || "confirmed";
  if (status !== "all") {
    if (!(ORDER_STATUSES as readonly string[]).includes(status)) {
      throw new CustomError("Estado de pedido no válido", 400);
    }
    filter.status = status;
    // Por defecto: los listos para Dropi que todavía no se crearon allá.
    if (status === "confirmed") filter["dropi.orderId"] = null;
  }
  const method = String(query.paymentMethod ?? "");
  if (method && (PAYMENT_METHODS as readonly string[]).includes(method))
    filter.paymentMethod = method;

  const from = parseEcDate(query.from, false);
  const to = parseEcDate(query.to, true);
  if (from || to) {
    filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  }

  const q = String(query.q ?? "")
    .trim()
    .slice(0, 80);
  if (q) {
    const regex = { $regex: escapeRegex(q), $options: "i" };
    filter.$or = [
      { number: regex },
      { "customer.phone": regex },
      { "customer.firstName": regex },
      { "customer.lastName": regex },
      { "customer.email": regex },
    ];
  }
  return filter;
}

/** Productos enlazados a Dropi después de la compra: completa los ids que el pedido no copió. */
async function currentDropiIds(orders: any[]) {
  const productIds = new Set<string>();
  for (const order of orders) {
    for (const item of order.items) if (!item.dropiId) productIds.add(String(item.product));
  }
  if (!productIds.size) return new Map<string, any>();
  const products = await Product.find({ _id: { $in: [...productIds] } })
    .select("dropiId variants._id variants.dropiVariationId")
    .lean();
  return new Map(products.map((p: any) => [String(p._id), p]));
}

export async function exportOrdersCsv(query: Record<string, unknown>) {
  const filter = buildFilter(query);
  const orders: any[] = await Order.find(filter)
    .sort({ createdAt: 1 })
    .limit(MAX_ORDERS)
    .select("-payphone -history -utm")
    .lean();
  const products = await currentDropiIds(orders);

  const lines = [HEADERS.map(cell).join(SEPARATOR)];
  for (const order of orders) {
    const isCod = order.paymentMethod === "cod";
    for (const item of order.items) {
      const product = products.get(String(item.product));
      const dropiId = item.dropiId ?? product?.dropiId ?? "";
      const variationId =
        item.dropiVariationId ??
        product?.variants?.find((v: any) => String(v._id) === String(item.variantId))
          ?.dropiVariationId ??
        "";
      lines.push(
        [
          cell(order.number),
          cell(ecDateTime(order.createdAt)),
          cell(order.customer.firstName),
          cell(order.customer.lastName),
          keepZeros(order.customer.phone),
          keepZeros(order.customer.idNumber),
          cell(order.customer.email),
          cell(order.address.province),
          cell(order.address.city),
          cell(order.address.street),
          cell(order.address.reference),
          cell(dropiId),
          cell(variationId),
          cell(item.title),
          cell(item.variantName),
          cell(item.quantity),
          cell(dollars(item.unitPrice)),
          cell(dollars(order.total)),
          cell(PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod),
          cell(isCod ? "SÍ" : "NO"),
          cell(dollars(isCod ? order.total : 0)),
          cell(order.notes),
        ].join(SEPARATOR),
      );
    }
  }

  const stamp = new Date(Date.now() - OFFSET_MS).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return {
    filename: `kova-pedidos-dropi-${stamp}.csv`,
    content: `﻿${lines.join("\r\n")}\r\n`,
    orders: orders.length,
  };
}
