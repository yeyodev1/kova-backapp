import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Order, OrderStatus } from "../models/order.model";
import { notifyOrder } from "./orderNotifications.service";

/**
 * Flujo manual con Dropi: mientras la API esté bloqueada, el admin crea el pedido en
 * app.dropi.ec y aquí solo deja constancia (id, guía, transportadora y estado de envío).
 */

const SHIPPING_STATUSES = ["shipped", "delivered", "returned"] as const;
type ShippingStatus = (typeof SHIPPING_STATUSES)[number];

/** Desde qué estados se puede llegar a cada estado de envío. */
const SHIPPING_FROM: Record<ShippingStatus, OrderStatus[]> = {
  shipped: ["confirmed", "sent_to_dropi", "shipped"],
  delivered: ["confirmed", "sent_to_dropi", "shipped", "delivered"],
  returned: ["sent_to_dropi", "shipped", "delivered", "returned"],
};

const SHIPPING_LABELS: Record<ShippingStatus, string> = {
  shipped: "enviado",
  delivered: "entregado",
  returned: "devuelto",
};

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: "esperando pago",
  awaiting_transfer: "esperando transferencia",
  transfer_review: "comprobante por revisar",
  confirmed: "confirmado",
  sent_to_dropi: "creado en Dropi",
  shipped: "enviado",
  delivered: "entregado",
  returned: "devuelto",
  cancelled: "cancelado",
  failed: "fallido",
};

/** Estados en los que tiene sentido tocar guía o transportadora. */
const EDITABLE: OrderStatus[] = ["confirmed", "sent_to_dropi", "shipped", "delivered", "returned"];

function historyEntry(status: string, note = "") {
  return { status, note, at: new Date() };
}

function text(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

async function findOrderOr404(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Pedido no encontrado", 404);
  const order = await Order.findById(id);
  if (!order) throw new CustomError("Pedido no encontrado", 404);
  return order;
}

function parseDropiOrderId(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CustomError("El ID de pedido de Dropi debe ser un número entero", 400);
  }
  return n;
}

async function ensureDropiIdFree(orderId: unknown, dropiOrderId: number) {
  const other = await Order.findOne({ _id: { $ne: orderId }, "dropi.orderId": dropiOrderId })
    .select("number")
    .lean<{ number: string }>();
  if (other) {
    throw new CustomError(
      `El pedido de Dropi #${dropiOrderId} ya está asignado a ${other.number}`,
      409,
    );
  }
}

/** POST /admin/orders/:id/dropi-manual */
export async function markCreatedInDropi(id: string, body: any) {
  const order = await findOrderOr404(id);
  if (!["confirmed", "sent_to_dropi"].includes(order.status)) {
    const message =
      order.status === "shipped" || order.status === "delivered" || order.status === "returned"
        ? "Este pedido ya salió: actualiza la guía o el estado desde Envío"
        : "Solo se pueden pasar a Dropi pedidos confirmados (pagados o contra entrega)";
    throw new CustomError(message, 400);
  }

  const dropiOrderId = parseDropiOrderId(body?.dropiOrderId);
  const guide = text(body?.guide, 60);
  const carrier = text(body?.carrier, 60);
  if (dropiOrderId) await ensureDropiIdFree(order._id, dropiOrderId);

  const nextStatus: OrderStatus = guide ? "shipped" : "sent_to_dropi";
  order.status = nextStatus;
  if (dropiOrderId) order.dropi.orderId = dropiOrderId;
  if (guide) order.dropi.guide = guide;
  if (carrier) order.dropi.carrier = carrier;
  order.dropi.error = "";
  order.dropi.lockedAt = null;

  const details = [
    dropiOrderId ? `#${dropiOrderId}` : "",
    guide ? `guía ${guide}` : "",
    carrier ? `(${carrier})` : "",
  ]
    .filter(Boolean)
    .join(" ");
  order.history.push(
    historyEntry(nextStatus, `Creado en Dropi manualmente${details ? ` ${details}` : ""}`),
  );
  await order.save();
  if (nextStatus === "shipped") notifyOrder("shipped", order);
  return order.toObject();
}

/** PUT /admin/orders/:id/shipping — guía, transportadora y estado de envío a mano. */
export async function updateShipping(id: string, body: any) {
  const order = await findOrderOr404(id);
  if (!EDITABLE.includes(order.status)) {
    throw new CustomError("Este pedido no está en envío: no se puede editar la guía", 400);
  }

  const rawStatus = text(body?.status, 20);
  if (rawStatus && !(SHIPPING_STATUSES as readonly string[]).includes(rawStatus)) {
    throw new CustomError("Estado de envío no válido: usa enviado, entregado o devuelto", 400);
  }
  const hasGuide = body && Object.prototype.hasOwnProperty.call(body, "guide");
  const hasCarrier = body && Object.prototype.hasOwnProperty.call(body, "carrier");
  const guide = hasGuide ? text(body.guide, 60) : order.dropi.guide;
  const carrier = hasCarrier ? text(body.carrier, 60) : order.dropi.carrier;

  const previous = order.status;
  let status = rawStatus as ShippingStatus | "";
  // Agregar la guía a un pedido que aún no salía equivale a marcarlo como enviado.
  if (
    !status &&
    guide &&
    !order.dropi.guide &&
    ["confirmed", "sent_to_dropi"].includes(order.status)
  ) {
    status = "shipped";
  }
  if (!status && !hasGuide && !hasCarrier) {
    throw new CustomError("No hay cambios: envía guía, transportadora o estado", 400);
  }

  if (status) {
    if (!SHIPPING_FROM[status].includes(order.status)) {
      throw new CustomError(
        `No se puede marcar como ${SHIPPING_LABELS[status]} un pedido ${STATUS_LABELS[order.status as OrderStatus]}`,
        400,
      );
    }
    if (status === "shipped" && !guide) {
      throw new CustomError("Para marcarlo como enviado escribe el número de guía", 400);
    }
  }

  const notes: string[] = [];
  if (guide !== order.dropi.guide) notes.push(guide ? `Guía ${guide}` : "Guía borrada");
  if (carrier !== order.dropi.carrier)
    notes.push(carrier ? `Transportadora ${carrier}` : "Transportadora borrada");
  order.dropi.guide = guide;
  order.dropi.carrier = carrier;

  if (status && status !== order.status) {
    order.status = status;
    notes.unshift(`Marcado como ${SHIPPING_LABELS[status]} a mano`);
    // Contra entrega: al entregarse, la transportadora ya cobró.
    if (status === "delivered" && order.paymentMethod === "cod") order.paymentStatus = "paid";
  }

  if (notes.length) {
    order.history.push(historyEntry(order.status, notes.join(" · ")));
  }
  await order.save();
  // Solo al cambiar de estado: corregir la guía después no reenvía el correo.
  if (order.status !== previous && (order.status === "shipped" || order.status === "delivered")) {
    notifyOrder(order.status, order);
  }
  return order.toObject();
}
