import { isValidObjectId } from "mongoose";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { nextOrderNumber } from "../models/counter.model";
import { markLeadConverted } from "../models/lead.model";
import { Location } from "../models/location.model";
import { Order, OrderStatus, toPublicOrder } from "../models/order.model";
import { Product } from "../models/product.model";
import { getSettings } from "../models/setting.model";
import { normalizeEcPhone } from "../utils/phone";
import { buildQuote, parsePaymentMethod } from "./checkout.service";
import { uploadFile } from "./cloudinary.service";
import * as dropiService from "./dropi.service";
import { sendOrderReceivedEmail, sendPaymentConfirmedEmail } from "./email.service";
import * as payphoneService from "./payphone.service";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Si un envío a Dropi quedó colgado, el candado expira y se puede reintentar. */
const DROPI_LOCK_MS = 2 * 60 * 1000;
const RECEIPT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
];

function text(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function historyEntry(status: string, note = "") {
  return { status, note, at: new Date() };
}

async function findOrderOr404(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Pedido no encontrado", 404);
  const order = await Order.findById(id);
  if (!order) throw new CustomError("Pedido no encontrado", 404);
  return order;
}

// ── Validación del pedido ───────────────────────────────────────────────────

function parseCustomer(raw: any) {
  const firstName = text(raw?.firstName, 60);
  const lastName = text(raw?.lastName, 60);
  if (!firstName) throw new CustomError("Escribe tu nombre", 400);
  if (!lastName) throw new CustomError("Escribe tu apellido", 400);

  const phone = normalizeEcPhone(raw?.phone);
  if (!phone) throw new CustomError("Escribe un celular válido de 10 dígitos (09XXXXXXXX)", 400);

  const email = text(raw?.email, 120).toLowerCase();
  if (email && !EMAIL.test(email)) throw new CustomError("El correo no es válido", 400);

  const idNumber = text(raw?.idNumber, 20).replace(/\s/g, "");
  return { firstName, lastName, phone, email, idNumber };
}

async function parseAddress(raw: any) {
  const street = text(raw?.street, 200);
  const reference = text(raw?.reference, 200);
  if (!street) throw new CustomError("Escribe la dirección de entrega", 400);

  const provinceId = Number(raw?.provinceId) || 0;
  const cityId = Number(raw?.cityId) || 0;

  // Con ubicaciones cargadas se valida contra Dropi: un nombre mal escrito hace
  // que Dropi rechace el pedido o lo mande a otra ciudad.
  const hasLocations = await Location.exists({ kind: "province" });
  if (hasLocations) {
    const province = await Location.findOne({ kind: "province", dropiId: provinceId }).lean();
    if (!province) throw new CustomError("Elige una provincia válida", 400);
    const city = await Location.findOne({ kind: "city", dropiId: cityId, provinceId }).lean();
    if (!city) throw new CustomError("Elige una ciudad válida", 400);
    return {
      provinceId,
      province: (province as any).name,
      cityId,
      city: (city as any).name,
      street,
      reference,
    };
  }

  const province = text(raw?.province, 80);
  const city = text(raw?.city, 80);
  if (!province) throw new CustomError("Elige una provincia", 400);
  if (!city) throw new CustomError("Elige una ciudad", 400);
  return { provinceId, province, cityId, city, street, reference };
}

function parseUtm(raw: any): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const utm: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 10)) {
    if (/^[a-z_]{1,30}$/i.test(key)) utm[key] = text(value, 200);
  }
  return utm;
}

// ── Efectos de confirmación ─────────────────────────────────────────────────

/** Descuenta stock local y suma soldCount una sola vez por pedido. */
async function applyStock(orderId: unknown) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, stockApplied: false },
    { $set: { stockApplied: true } },
    { new: true },
  );
  if (!order) return;
  for (const item of order.items) {
    const inc: Record<string, number> = { stock: -item.quantity, soldCount: item.quantity };
    if (item.variantId) {
      await Product.updateOne(
        { _id: item.product, "variants._id": item.variantId },
        { $inc: { ...inc, "variants.$.stock": -item.quantity } },
      );
    } else {
      await Product.updateOne({ _id: item.product }, { $inc: inc });
    }
  }
}

/** Devuelve el stock al cancelar. La próxima sincronización con Dropi lo deja exacto. */
async function restoreStock(orderId: unknown) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, stockApplied: true },
    { $set: { stockApplied: false } },
    { new: true },
  );
  if (!order) return;
  for (const item of order.items) {
    const inc: Record<string, number> = { stock: item.quantity, soldCount: -item.quantity };
    if (item.variantId) {
      await Product.updateOne(
        { _id: item.product, "variants._id": item.variantId },
        { $inc: { ...inc, "variants.$.stock": item.quantity } },
      );
    } else {
      await Product.updateOne({ _id: item.product }, { $inc: inc });
    }
  }
}

/** Envía a Dropi sin romper el flujo del cliente: el error queda en el pedido. */
async function trySendToDropi(orderId: unknown) {
  try {
    await sendToDropi(String(orderId));
  } catch (error: any) {
    console.error(`[orders] no se pudo enviar ${orderId} a Dropi:`, error?.message);
  }
}

// ── Crear pedido ────────────────────────────────────────────────────────────

export async function createOrder(input: any) {
  const paymentMethod = parsePaymentMethod(input?.paymentMethod);
  const customer = parseCustomer(input?.customer);
  const address = await parseAddress(input?.address);
  const quote = await buildQuote(input?.items, paymentMethod);

  // Antes de crear nada: un pedido con tarjeta sin Payphone quedaría huérfano.
  const payphoneConfig = paymentMethod === "card" ? payphoneService.getPayphoneConfig() : null;

  const number = await nextOrderNumber();
  const base = {
    number,
    customer,
    address,
    items: quote.items,
    subtotal: quote.subtotal,
    shippingFee: quote.shippingFee,
    surcharge: quote.surcharge,
    total: quote.total,
    paymentMethod,
    notes: text(input?.notes, 500),
    utm: parseUtm(input?.utm),
  };

  let order: any;
  if (paymentMethod === "cod") {
    order = await Order.create({
      ...base,
      status: "confirmed",
      paymentStatus: "cod",
      history: [historyEntry("confirmed", "Pedido contra entrega")],
    });
  } else if (paymentMethod === "transfer") {
    order = await Order.create({
      ...base,
      status: "awaiting_transfer",
      paymentStatus: "pending",
      history: [historyEntry("awaiting_transfer", "Esperando comprobante de transferencia")],
    });
  } else {
    // Único por intento y ≤ 50 caracteres, como exige Payphone.
    const clientTransactionId = `${number}-${Date.now().toString(36)}`.slice(0, 50);
    order = await Order.create({
      ...base,
      status: "pending_payment",
      paymentStatus: "pending",
      payphone: { clientTransactionId, transactionId: "", response: null },
      history: [historyEntry("pending_payment", "Esperando pago con tarjeta")],
    });
  }

  await markLeadConverted(customer.phone, order._id).catch((error) =>
    console.error("[orders] no se pudo marcar el carrito como convertido:", error?.message),
  );

  if (paymentMethod === "cod") {
    await applyStock(order._id);
    await trySendToDropi(order._id);
    order = await Order.findById(order._id);
  }

  if (paymentMethod !== "card") {
    sendOrderReceivedEmail(order).catch(() => {});
  }

  const response: Record<string, unknown> = { order: toPublicOrder(order) };

  if (payphoneConfig) {
    response.payphone = {
      token: payphoneConfig.token,
      storeId: payphoneConfig.storeId,
      clientTransactionId: order.payphone.clientTransactionId,
      amount: order.total,
      amountWithoutTax: order.total,
      currency: "USD",
      reference: `Pedido ${order.number} Kova`,
      email: customer.email,
      phoneNumber: `+593${customer.phone.slice(1)}`,
      // Payphone pide el desglose aunque no se cobre IVA aparte:
      // amount = amountWithoutTax + amountWithTax + tax + service + tip.
      amountWithTax: 0,
      tax: 0,
      service: 0,
      tip: 0,
      // Datos reales del comprador: con cédula o RUC Payphone valida mejor y bloquea menos.
      ...payphoneDocument(customer.idNumber),
      optionalParameter: order.number,
    };
  }

  if (paymentMethod === "transfer") {
    const settings = await getSettings();
    response.bankAccounts = settings.bankAccounts || [];
  }

  return response;
}

// ── Payphone ────────────────────────────────────────────────────────────────

/** 10 dígitos = cédula (1), 13 = RUC (2). Otro formato no se manda para no forzar un tipo falso. */
function payphoneDocument(idNumber: string) {
  if (/^\d{10}$/.test(idNumber)) return { documentId: idNumber, identificationType: 1 };
  if (/^\d{13}$/.test(idNumber)) return { documentId: idNumber, identificationType: 2 };
  return {};
}

export async function confirmPayphone(id: unknown, clientTransactionId: unknown) {
  const txId = text(clientTransactionId, 50);
  const payphoneId = Number(id);
  if (!txId || !payphoneId) throw new CustomError("Faltan los datos de la transacción", 400);

  const order = await Order.findOne({ "payphone.clientTransactionId": txId });
  if (!order) throw new CustomError("Pedido no encontrado", 404);

  // Idempotente: el cliente recarga la página de respuesta más de una vez.
  if (order.paymentStatus === "paid") return { order: toPublicOrder(order), approved: true };
  if (order.status === "cancelled") return { order: toPublicOrder(order), approved: false };

  const data = await payphoneService.confirm(payphoneId, txId);
  const statusCode = Number(data?.statusCode);
  const amountMatches = Number(data?.amount) === order.total;
  const txMatches = !data?.clientTransactionId || data.clientTransactionId === txId;

  if (statusCode === payphoneService.PAYPHONE_APPROVED && amountMatches && txMatches) {
    // Transición atómica: dos confirmaciones simultáneas no envían dos veces a Dropi.
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: { $ne: "paid" } },
      {
        $set: {
          paymentStatus: "paid",
          status: "confirmed",
          "payphone.transactionId": String(payphoneId),
          "payphone.response": data,
        },
        $push: { history: historyEntry("confirmed", "Pago con tarjeta aprobado por Payphone") },
      },
      { new: true },
    );
    if (updated) {
      await applyStock(updated._id);
      await trySendToDropi(updated._id);
      sendPaymentConfirmedEmail(updated).catch(() => {});
    }
    const fresh = await Order.findById(order._id);
    return { order: toPublicOrder(fresh), approved: true };
  }

  order.payphone.transactionId = String(payphoneId);
  order.payphone.response = data;
  if (statusCode === payphoneService.PAYPHONE_APPROVED) {
    // Aprobado pero con monto distinto: no se entrega nada, lo revisa administración.
    order.history.push(
      historyEntry(
        order.status,
        `Payphone aprobó ${data?.amount} pero el pedido es ${order.total}: revisar`,
      ),
    );
  } else if (statusCode === payphoneService.PAYPHONE_CANCELED) {
    order.status = "failed";
    order.paymentStatus = "failed";
    order.history.push(
      historyEntry("failed", data?.message || "Pago cancelado o rechazado en Payphone"),
    );
  } else {
    order.history.push(
      historyEntry(order.status, `Payphone respondió statusCode ${data?.statusCode ?? "?"}`),
    );
  }
  await order.save();
  return { order: toPublicOrder(order), approved: false };
}

// ── Transferencia ───────────────────────────────────────────────────────────

export async function uploadReceipt(number: unknown, phone: unknown, file?: Express.Multer.File) {
  const normalized = normalizeEcPhone(phone);
  const order = await Order.findOne({ number: text(number, 20).toUpperCase() });
  // Mismo 404 si el teléfono no coincide: el número de pedido no basta para tocarlo.
  if (!order || !normalized || order.customer.phone !== normalized) {
    throw new CustomError("Pedido no encontrado", 404);
  }
  if (order.paymentMethod !== "transfer") {
    throw new CustomError("Este pedido no se paga por transferencia", 400);
  }
  if (!["awaiting_transfer", "transfer_review"].includes(order.status)) {
    throw new CustomError("Este pedido ya no recibe comprobantes", 400);
  }
  if (!file) throw new CustomError("Adjunta el comprobante", 400);
  if (!RECEIPT_TYPES.includes(file.mimetype)) {
    throw new CustomError("El comprobante debe ser una imagen o un PDF", 400);
  }

  const { url } = await uploadFile(file.buffer, "kova/receipts");
  order.transfer.receiptUrl = url;
  order.transfer.uploadedAt = new Date();
  order.status = "transfer_review";
  order.history.push(historyEntry("transfer_review", "Comprobante subido por el cliente"));
  await order.save();
  return toPublicOrder(order);
}

export async function confirmTransfer(id: string) {
  const order = await findOrderOr404(id);
  if (order.paymentMethod !== "transfer") {
    throw new CustomError("Este pedido no se paga por transferencia", 400);
  }
  if (order.paymentStatus === "paid") return order.toObject();
  if (!["awaiting_transfer", "transfer_review"].includes(order.status)) {
    throw new CustomError("El pedido no está esperando una transferencia", 400);
  }

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $ne: "paid" } },
    {
      $set: { paymentStatus: "paid", status: "confirmed", "transfer.confirmedAt": new Date() },
      $push: { history: historyEntry("confirmed", "Transferencia confirmada por administración") },
    },
    { new: true },
  );
  if (updated) {
    await applyStock(updated._id);
    await trySendToDropi(updated._id);
    sendPaymentConfirmedEmail(updated).catch(() => {});
  }
  const fresh = await Order.findById(order._id);
  return fresh.toObject();
}

// ── Dropi ───────────────────────────────────────────────────────────────────

/**
 * Los items copian los ids de Dropi al comprar. Si el producto se creó a mano y se
 * enlazó después, se completan ahora con los ids actuales del producto.
 */
async function linkItemsToDropi(order: any) {
  const pending = order.items.filter((item: any) => !item.dropiId);
  if (!pending.length) return;
  const products = await Product.find({ _id: { $in: pending.map((i: any) => i.product) } })
    .select("dropiId variants._id variants.dropiVariationId")
    .lean();
  const byId = new Map(products.map((p: any) => [String(p._id), p]));
  let changed = false;
  for (const item of pending) {
    const product: any = byId.get(String(item.product));
    if (!product?.dropiId) continue;
    item.dropiId = product.dropiId;
    if (item.variantId) {
      const variant = product.variants?.find((v: any) => String(v._id) === String(item.variantId));
      item.dropiVariationId = variant?.dropiVariationId ?? null;
    }
    changed = true;
  }
  if (changed) await order.save();
}

export async function sendToDropi(id: string) {
  const order = await findOrderOr404(id);
  if (order.dropi.orderId) return order.toObject();
  if (order.status !== "confirmed") {
    throw new CustomError("El pedido no está listo para enviarse a Dropi", 400);
  }
  await linkItemsToDropi(order);
  const missing = order.items.find((item: any) => !item.dropiId);
  if (missing) {
    throw new CustomError(
      `El producto ${missing.title} no está enlazado a Dropi: agrega su ID en el panel`,
      400,
    );
  }

  const lock = await Order.findOneAndUpdate(
    {
      _id: order._id,
      "dropi.orderId": null,
      $or: [
        { "dropi.lockedAt": null },
        { "dropi.lockedAt": { $lt: new Date(Date.now() - DROPI_LOCK_MS) } },
      ],
    },
    { $set: { "dropi.lockedAt": new Date() } },
    { new: true },
  );
  if (!lock) throw new CustomError("El pedido ya se está enviando a Dropi", 409);

  const isCod = order.paymentMethod === "cod";
  const payload: dropiService.DropiOrderPayload = {
    calculate_costs_and_shiping: true,
    state: order.address.province,
    city: order.address.city,
    // Dropi pide correo; sin el del cliente se usa el de la tienda.
    client_email: order.customer.email || env.ADMIN_EMAIL,
    name: order.customer.firstName,
    surname: order.customer.lastName,
    dir: [order.address.street, order.address.reference].filter(Boolean).join(" - Ref: "),
    notes: order.notes || "",
    payment_method_id: 1,
    phone: order.customer.phone,
    rate_type: isCod ? "CON RECAUDO" : "SIN RECAUDO",
    type: "FINAL_ORDER",
    // Con recaudo, es lo que cobra la transportadora (incluye recargo y envío).
    total_order: dropiService.toDollars(order.total),
    shop_order_id: order.number,
    dni: order.customer.idNumber || "",
    products: order.items.map((item: any) => ({
      id: item.dropiId,
      price: dropiService.toDollars(item.unitPrice),
      variation_id: item.dropiVariationId ?? null,
      quantity: item.quantity,
    })),
  };

  try {
    const created = await dropiService.createOrder(payload);
    const updated = await Order.findByIdAndUpdate(
      order._id,
      {
        $set: {
          status: "sent_to_dropi",
          "dropi.orderId": created.id,
          "dropi.status": created.status,
          "dropi.error": "",
          "dropi.lastSyncAt": new Date(),
          "dropi.lockedAt": null,
        },
        $push: { history: historyEntry("sent_to_dropi", `Creado en Dropi #${created.id}`) },
      },
      { new: true },
    );
    return updated.toObject();
  } catch (error: any) {
    const message = String(error?.message || "Error desconocido de Dropi");
    await Order.updateOne(
      { _id: order._id },
      {
        $set: { "dropi.error": message, "dropi.lockedAt": null },
        $push: { history: historyEntry(order.status, `Falló el envío a Dropi: ${message}`) },
      },
    );
    throw error;
  }
}

export async function cancelOrder(id: string) {
  const order = await findOrderOr404(id);
  const closed: OrderStatus[] = ["delivered", "returned", "cancelled"];
  if (closed.includes(order.status)) {
    throw new CustomError("Este pedido ya no se puede cancelar", 400);
  }

  if (order.dropi.orderId) {
    try {
      await dropiService.cancelOrder(order.dropi.orderId);
      order.history.push(historyEntry(order.status, "Cancelado también en Dropi"));
    } catch (error: any) {
      // La cancelación local sigue: el admin la termina a mano en el panel de Dropi.
      order.history.push(
        historyEntry(
          order.status,
          `No se pudo cancelar en Dropi (hazlo en su panel): ${error?.message}`,
        ),
      );
    }
  }

  order.status = "cancelled";
  const note =
    order.paymentStatus === "paid"
      ? "Pedido cancelado. Estaba pagado: gestionar reembolso"
      : "Pedido cancelado";
  order.history.push(historyEntry("cancelled", note));
  await order.save();
  await restoreStock(order._id);

  const fresh = await Order.findById(order._id);
  return fresh.toObject();
}

// ── Rastreo ─────────────────────────────────────────────────────────────────

export async function track(number: unknown, phone: unknown) {
  const normalized = normalizeEcPhone(phone);
  const code = text(number, 20).toUpperCase();
  if (!code || !normalized) throw new CustomError("Escribe tu número de pedido y tu celular", 400);

  const order: any = await Order.findOne({ number: code }).lean();
  if (!order || order.customer.phone !== normalized) {
    throw new CustomError("Pedido no encontrado", 404);
  }

  return {
    _id: order._id,
    number: order.number,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    items: order.items.map((item: any) => ({
      title: item.title,
      variantName: item.variantName,
      image: item.image,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total,
    })),
    subtotal: order.subtotal,
    shippingFee: order.shippingFee,
    surcharge: order.surcharge,
    total: order.total,
    customer: { firstName: order.customer.firstName },
    address: { province: order.address.province, city: order.address.city },
    transfer: {
      uploadedAt: order.transfer?.uploadedAt ?? null,
      confirmedAt: order.transfer?.confirmedAt ?? null,
    },
    guide: order.dropi?.guide || "",
    carrier: order.dropi?.carrier || "",
    dropi: {
      status: order.dropi?.status || "",
      guide: order.dropi?.guide || "",
      carrier: order.dropi?.carrier || "",
    },
    createdAt: order.createdAt,
  };
}
