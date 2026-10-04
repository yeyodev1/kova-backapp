import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Lead } from "../models/lead.model";
import { ORDER_STATUSES, Order, PAYMENT_METHODS } from "../models/order.model";
import { Product } from "../models/product.model";
import { getSettings, Setting } from "../models/setting.model";
import { escapeRegex } from "../utils/regex";
import { slugify } from "../utils/slugify";
import { uploadBuffer } from "./cloudinary.service";
import { sanitizeDescription } from "./dropiSync.service";

const TIMEZONE = "America/Guayaquil";
/** Ecuador continental no tiene horario de verano: UTC-5 fijo. */
const OFFSET_MS = 5 * 60 * 60 * 1000;
/** Estados que no cuentan como venta: intentos de tarjeta sin pagar o fallidos. */
const NOT_SALES = ["pending_payment", "failed", "cancelled"];

function paging(query: { page?: unknown; limit?: unknown }, defaultLimit = 20) {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function paginated<T>(items: T[], total: number, page: number, limit: number) {
  return { items, total, page, pages: Math.max(Math.ceil(total / limit), 1) };
}

/** Inicio del día de hoy en Ecuador, expresado en UTC. */
function startOfTodayEc(): Date {
  const local = new Date(Date.now() - OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() + OFFSET_MS);
}

function ecDateKey(date: Date): string {
  return new Date(date.getTime() - OFFSET_MS).toISOString().slice(0, 10);
}

// ── Dashboard ───────────────────────────────────────────────────────────────

export async function dashboard() {
  const today = startOfTodayEc();
  const weekStart = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);

  const [todayAgg, pendingTransfers, dropiErrors, byStatus, byDay] = await Promise.all([
    Order.aggregate([
      { $match: { createdAt: { $gte: today }, status: { $nin: NOT_SALES } } },
      { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: "$total" } } },
    ]),
    Order.countDocuments({ status: "transfer_review" }),
    Order.countDocuments({
      status: "confirmed",
      "dropi.orderId": null,
      "dropi.error": { $ne: "" },
    }),
    Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: { createdAt: { $gte: weekStart }, status: { $nin: NOT_SALES } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TIMEZONE } },
          orders: { $sum: 1 },
          revenue: { $sum: "$total" },
        },
      },
    ]),
  ]);

  const ordersByStatus: Record<string, number> = Object.fromEntries(
    ORDER_STATUSES.map((s) => [s, 0]),
  );
  for (const row of byStatus) ordersByStatus[row._id] = row.count;

  const days = new Map(byDay.map((d: any) => [d._id, d]));
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const date = ecDateKey(new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000));
    const day: any = days.get(date);
    return { date, orders: day?.orders || 0, revenue: day?.revenue || 0 };
  });

  return {
    ordersToday: todayAgg[0]?.orders || 0,
    revenueToday: todayAgg[0]?.revenue || 0,
    pendingTransfers,
    dropiErrors,
    ordersByStatus,
    last7Days,
  };
}

// ── Pedidos ─────────────────────────────────────────────────────────────────

export async function listOrders(query: Record<string, unknown>) {
  const { page, limit, skip } = paging(query);
  const filter: Record<string, unknown> = {};
  const status = String(query.status ?? "");
  if (status && (ORDER_STATUSES as readonly string[]).includes(status)) filter.status = status;
  const method = String(query.paymentMethod ?? "");
  if (method && (PAYMENT_METHODS as readonly string[]).includes(method))
    filter.paymentMethod = method;
  if (query.dropiError === "1" || query.dropiError === "true") filter["dropi.error"] = { $nin: ["", null] };
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

  const [items, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("-payphone.response")
      .lean(),
    Order.countDocuments(filter),
  ]);
  return paginated(items, total, page, limit);
}

export async function getOrder(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Pedido no encontrado", 404);
  const order = await Order.findById(id).lean();
  if (!order) throw new CustomError("Pedido no encontrado", 404);
  return order;
}

// ── Productos ───────────────────────────────────────────────────────────────

export async function listProducts(query: Record<string, unknown>) {
  const { page, limit, skip } = paging(query);
  const filter: Record<string, unknown> = {};
  const q = String(query.q ?? "")
    .trim()
    .slice(0, 80);
  if (q) filter.title = { $regex: escapeRegex(q), $options: "i" };
  if (query.published === "1" || query.published === "true") filter.isPublished = true;
  if (query.published === "0" || query.published === "false") filter.isPublished = false;

  const [items, total] = await Promise.all([
    Product.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);
  return paginated(items, total, page, limit);
}

async function findProductOr404(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Producto no encontrado", 404);
  const product = await Product.findById(id);
  if (!product) throw new CustomError("Producto no encontrado", 404);
  return product;
}

export async function getProduct(id: string) {
  const product = await findProductOr404(id);
  return product.toObject();
}

function cents(value: unknown, field: string, allowZero = false): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
    throw new CustomError(`${field} debe ser un monto en centavos mayor a cero`, 400);
  }
  return n;
}

function stringList(value: unknown, field: string, max = 20): string[] {
  if (!Array.isArray(value)) throw new CustomError(`${field} debe ser una lista`, 400);
  return value
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, max);
}

export async function updateProduct(id: string, body: any) {
  const product = await findProductOr404(id);
  const input = body ?? {};

  if (input.title !== undefined) {
    const title = String(input.title).trim();
    if (!title) throw new CustomError("El título no puede quedar vacío", 400);
    product.title = title.slice(0, 200);
  }
  // El slug solo cambia si se pide: cambiarlo rompe links ya compartidos en anuncios.
  if (input.slug !== undefined) {
    const slug = slugify(String(input.slug));
    if (!slug) throw new CustomError("El slug no es válido", 400);
    if (await Product.exists({ slug, _id: { $ne: product._id } })) {
      throw new CustomError("Ya existe otro producto con ese slug", 409);
    }
    product.slug = slug;
  }
  if (input.shortDescription !== undefined)
    product.shortDescription = String(input.shortDescription).slice(0, 300);
  if (input.description !== undefined) product.description = sanitizeDescription(input.description);
  if (input.category !== undefined) product.category = String(input.category).trim().slice(0, 80);
  if (input.images !== undefined) product.images = stringList(input.images, "Las imágenes", 30);
  if (input.benefits !== undefined) product.benefits = stringList(input.benefits, "Los beneficios");
  if (input.faqs !== undefined) {
    if (!Array.isArray(input.faqs)) throw new CustomError("Las preguntas deben ser una lista", 400);
    product.faqs = input.faqs
      .map((f: any) => ({
        question: String(f?.question ?? "").trim(),
        answer: String(f?.answer ?? "").trim(),
      }))
      .filter((f: any) => f.question && f.answer)
      .slice(0, 20);
  }
  if (input.isPublished !== undefined) product.isPublished = Boolean(input.isPublished);
  if (input.isFeatured !== undefined) product.isFeatured = Boolean(input.isFeatured);
  if (input.price !== undefined) product.price = cents(input.price, "El precio");
  if (input.compareAtPrice !== undefined)
    product.compareAtPrice = cents(input.compareAtPrice, "El precio tachado", true);

  if (input.variants !== undefined) {
    if (!Array.isArray(input.variants))
      throw new CustomError("Las variantes deben ser una lista", 400);
    for (const change of input.variants) {
      const variant = product.variants.find((v: any) => String(v._id) === String(change?._id));
      if (!variant) continue;
      if (change.name !== undefined) variant.name = String(change.name).trim().slice(0, 120);
      if (change.price !== undefined)
        variant.price = cents(change.price, "El precio de la variante");
      if (change.compareAtPrice !== undefined) {
        variant.compareAtPrice = cents(
          change.compareAtPrice,
          "El precio tachado de la variante",
          true,
        );
      }
    }
  }

  if (input.offers !== undefined) {
    if (!Array.isArray(input.offers)) throw new CustomError("Las ofertas deben ser una lista", 400);
    const offers = input.offers.slice(0, 6).map((o: any) => {
      const quantity = Number(o?.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        throw new CustomError("La cantidad de cada oferta debe estar entre 1 y 10", 400);
      }
      return {
        quantity,
        unitPrice: cents(o?.unitPrice, "El precio de la oferta"),
        label: String(o?.label ?? "")
          .trim()
          .slice(0, 40),
        isDefault: Boolean(o?.isDefault),
      };
    });
    if (new Set(offers.map((o: any) => o.quantity)).size !== offers.length) {
      throw new CustomError("No repitas la misma cantidad en dos ofertas", 400);
    }
    offers.sort((a: any, b: any) => a.quantity - b.quantity);
    // Exactamente una oferta preseleccionada.
    const defaultIndex = Math.max(
      offers.findIndex((o: any) => o.isDefault),
      0,
    );
    offers.forEach((o: any, i: number) => (o.isDefault = i === defaultIndex));
    product.offers = offers;
  }

  if (product.type === "VARIABLE" && product.variants.length) {
    product.price = Math.min(...product.variants.map((v: any) => v.price || Infinity));
    if (!Number.isFinite(product.price)) product.price = 0;
  }
  if (product.isPublished && (!product.price || product.price <= 0)) {
    throw new CustomError("Ponle un precio mayor a cero antes de publicar", 400);
  }

  await product.save();
  return product.toObject();
}

export async function deleteProduct(id: string) {
  const product = await findProductOr404(id);
  await product.deleteOne();
  return { ok: true };
}

export async function addProductImage(id: string, file?: Express.Multer.File) {
  const product = await findProductOr404(id);
  if (!file) throw new CustomError("Adjunta una imagen", 400);
  if (!file.mimetype.startsWith("image/"))
    throw new CustomError("El archivo debe ser una imagen", 400);
  const { url } = await uploadBuffer(file.buffer, "kova/products");
  product.images.push(url);
  await product.save();
  return product.toObject();
}

// ── Carritos abandonados ────────────────────────────────────────────────────

export async function listLeads(query: Record<string, unknown>) {
  const { page, limit, skip } = paging(query);
  const filter = { converted: false };
  const [items, total] = await Promise.all([
    Lead.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Lead.countDocuments(filter),
  ]);

  // El lead solo guarda ids: el panel necesita nombre e imagen para escribirle al cliente.
  const productIds = [...new Set(items.flatMap((l: any) => l.items.map((i: any) => String(i.productId))))];
  const products = await Product.find({ _id: { $in: productIds } })
    .select("title images variants._id variants.name")
    .lean();
  const byId = new Map(products.map((p: any) => [String(p._id), p]));
  const enriched = items.map((lead: any) => ({
    ...lead,
    items: lead.items.map((item: any) => {
      const product: any = byId.get(String(item.productId));
      const variant = product?.variants?.find((v: any) => String(v._id) === String(item.variantId));
      return {
        ...item,
        title: product?.title ?? item.title ?? "Producto",
        image: product?.images?.[0] ?? "",
        variantName: variant?.name ?? "",
      };
    }),
  }));
  return paginated(enriched, total, page, limit);
}

// ── Configuración ───────────────────────────────────────────────────────────

const INT_FIELDS = [
  "codSurcharge",
  "transferSurcharge",
  "shippingFee",
  "freeShippingFrom",
  "defaultMarkupPercent",
] as const;

export async function getAdminSettings() {
  const settings: any = await getSettings();
  const { _id, key, __v, createdAt, updatedAt, ...rest } = settings;
  return rest;
}

export async function updateSettings(body: any) {
  const input = body ?? {};
  const update: Record<string, unknown> = {};

  for (const field of INT_FIELDS) {
    if (input[field] === undefined) continue;
    const n = Number(input[field]);
    if (!Number.isInteger(n) || n < 0) {
      throw new CustomError(`${field} debe ser un número entero mayor o igual a cero`, 400);
    }
    update[field] = n;
  }
  if (input.announcement !== undefined)
    update.announcement = String(input.announcement).trim().slice(0, 200);
  if (input.whatsapp !== undefined) {
    const whatsapp = String(input.whatsapp).replace(/\D/g, "");
    if (whatsapp && (whatsapp.length < 10 || whatsapp.length > 15)) {
      throw new CustomError(
        "El WhatsApp debe tener entre 10 y 15 dígitos, con código de país",
        400,
      );
    }
    update.whatsapp = whatsapp;
  }
  if (input.bankAccounts !== undefined) {
    if (!Array.isArray(input.bankAccounts))
      throw new CustomError("Las cuentas deben ser una lista", 400);
    update.bankAccounts = input.bankAccounts.slice(0, 10).map((a: any) => ({
      bank: String(a?.bank ?? "")
        .trim()
        .slice(0, 80),
      type: String(a?.type ?? "")
        .trim()
        .slice(0, 40),
      number: String(a?.number ?? "")
        .trim()
        .slice(0, 40),
      holder: String(a?.holder ?? "")
        .trim()
        .slice(0, 120),
      idNumber: String(a?.idNumber ?? "")
        .trim()
        .slice(0, 20),
    }));
  }

  await getSettings();
  await Setting.updateOne({ key: "main" }, { $set: update });
  return getAdminSettings();
}
