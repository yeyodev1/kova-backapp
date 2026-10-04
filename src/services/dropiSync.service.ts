import sanitizeHtml from "sanitize-html";
import { CustomError } from "../errors/customError.error";
import { Location } from "../models/location.model";
import { Order } from "../models/order.model";
import { Product } from "../models/product.model";
import { getSettings } from "../models/setting.model";
import { slugify } from "../utils/slugify";
import { sleep } from "../utils/sleep";
import { compareAtFor, defaultOffers, salePrice } from "../utils/pricing";
import * as dropiService from "./dropi.service";

/** Pausa entre llamadas en serie: Dropi corta por rate limit con ráfagas. */
const PAUSE_MS = 300;
/** Vercel corta a los 60 s; se deja margen para responder. */
const TIME_BUDGET_MS = 45000;

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
  allowedAttributes: {
    a: ["href", "target", "rel"],
    img: ["src", "alt"],
  },
  allowedSchemes: ["https", "http"],
};

export function sanitizeDescription(html: unknown): string {
  return sanitizeHtml(String(html ?? ""), SANITIZE_OPTIONS).trim();
}

function plainText(html: string, max: number): string {
  const text = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function galleryImages(product: any): string[] {
  const gallery: any[] = Array.isArray(product?.gallery) ? [...product.gallery] : [];
  // La imagen principal va primero: es la que se ve en la tarjeta.
  gallery.sort((a, b) => Number(!!b?.main) - Number(!!a?.main));
  const urls = gallery.map(dropiService.dropiImageUrl).filter(Boolean);
  return Array.from(new Set(urls));
}

function attributeName(av: any, index: number): string {
  return String(
    av?.attribute_name ??
      av?.attribute?.description ??
      av?.attribute?.name ??
      av?.name ??
      `Opción ${index + 1}`,
  ).trim();
}

function attributeValue(av: any): string {
  return String(av?.value ?? av?.description ?? av?.attribute_value ?? "").trim();
}

function mapVariation(variation: any, markupPercent: number) {
  const values: any[] = Array.isArray(variation?.attribute_values)
    ? variation.attribute_values
    : [];
  const attributes: Record<string, string> = {};
  values.forEach((av, i) => {
    const value = attributeValue(av);
    if (value) attributes[attributeName(av, i)] = value;
  });
  const costPrice = dropiService.toCents(variation?.sale_price);
  const suggestedPrice = dropiService.toCents(variation?.suggested_price);
  const price = salePrice(costPrice, suggestedPrice, markupPercent);
  return {
    dropiVariationId: Number(variation?.id) || null,
    name:
      Object.values(attributes).join(" / ") ||
      String(variation?.sku || `Variante ${variation?.id}`),
    attributes,
    price,
    compareAtPrice: compareAtFor(price),
    stock: dropiService.variationStock(variation),
    sku: String(variation?.sku || ""),
    costPrice,
    suggestedPrice,
  };
}

async function uniqueSlug(base: string, excludeId?: unknown): Promise<string> {
  const root = slugify(base) || "producto";
  let candidate = root;
  for (let i = 2; ; i++) {
    const filter: Record<string, unknown> = { slug: candidate };
    if (excludeId) filter._id = { $ne: excludeId };
    if (!(await Product.exists(filter))) return candidate;
    candidate = `${root}-${i}`;
  }
}

/**
 * Lo que manda Dropi y se puede refrescar sin pisar lo que editó la tienda:
 * stock, costos, sugeridos y (solo si no hay) imágenes.
 */
function applyRefresh(product: any, dropi: any) {
  const isVariable = String(dropi?.type || "").toUpperCase() === "VARIABLE";
  product.costPrice = dropiService.toCents(dropi?.sale_price);
  product.suggestedPrice = dropiService.toCents(dropi?.suggested_price);

  if (isVariable && product.variants?.length) {
    const variations: any[] = Array.isArray(dropi?.variations) ? dropi.variations : [];
    for (const variant of product.variants) {
      const match = variations.find((v) => Number(v?.id) === variant.dropiVariationId);
      if (!match) {
        // La variación ya no existe en Dropi: se agota para que nadie la compre.
        variant.stock = 0;
        continue;
      }
      variant.stock = dropiService.variationStock(match);
      variant.costPrice = dropiService.toCents(match?.sale_price);
      variant.suggestedPrice = dropiService.toCents(match?.suggested_price);
    }
    product.stock = product.variants.reduce((acc: number, v: any) => acc + (v.stock || 0), 0);
  } else {
    product.stock = dropiService.productStock(dropi);
  }

  if (!product.images?.length) product.images = galleryImages(dropi);
  product.lastSyncedAt = new Date();
}

// ── Catálogo ────────────────────────────────────────────────────────────────

export async function searchCatalog(q: string, page = 1, limit = 20) {
  const { objects, count } = await dropiService.listProducts({
    keywords: q,
    page,
    pageSize: limit,
  });
  const ids = objects.map((p) => Number(p?.id)).filter(Boolean);
  const imported = await Product.find({ dropiId: { $in: ids } })
    .select("dropiId")
    .lean();
  const importedIds = new Set(imported.map((p: any) => p.dropiId));

  const items = objects.map((p) => {
    const variations: any[] = Array.isArray(p?.variations) ? p.variations : [];
    const stock =
      String(p?.type).toUpperCase() === "VARIABLE" && variations.length
        ? variations.reduce((acc, v) => acc + dropiService.variationStock(v), 0)
        : dropiService.productStock(p);
    return {
      dropiId: Number(p?.id),
      name: String(p?.name || ""),
      type: String(p?.type || "SIMPLE").toUpperCase() === "VARIABLE" ? "VARIABLE" : "SIMPLE",
      costPrice: dropiService.toCents(p?.sale_price),
      suggestedPrice: dropiService.toCents(p?.suggested_price),
      stock,
      image: galleryImages(p)[0] || "",
      imported: importedIds.has(Number(p?.id)),
    };
  });

  return { items, total: count };
}

export async function importProduct(dropiId: number, markupPercent?: number) {
  if (!Number.isInteger(dropiId) || dropiId <= 0) {
    throw new CustomError("El id de Dropi no es válido", 400);
  }
  const settings = await getSettings();
  const markup =
    markupPercent !== undefined && Number.isFinite(markupPercent) && markupPercent >= 0
      ? markupPercent
      : settings.defaultMarkupPercent;

  const dropi = await dropiService.getProduct(dropiId);

  const existing = await Product.findOne({ dropiId });
  if (existing) {
    applyRefresh(existing, dropi);
    await existing.save();
    return existing.toObject();
  }

  const isVariable = String(dropi?.type || "").toUpperCase() === "VARIABLE";
  const costPrice = dropiService.toCents(dropi?.sale_price);
  const suggestedPrice = dropiService.toCents(dropi?.suggested_price);

  const variations: any[] = Array.isArray(dropi?.variations) ? dropi.variations : [];
  const variants = isVariable ? variations.map((v) => mapVariation(v, markup)) : [];

  const price = variants.length
    ? Math.min(...variants.map((v) => v.price))
    : salePrice(costPrice, suggestedPrice, markup);
  const stock = variants.length
    ? variants.reduce((acc, v) => acc + v.stock, 0)
    : dropiService.productStock(dropi);

  const description = sanitizeDescription(dropi?.description);
  const title = String(dropi?.name || `Producto ${dropiId}`).trim();
  const categories: any[] = Array.isArray(dropi?.categories) ? dropi.categories : [];

  const product = await Product.create({
    slug: await uniqueSlug(title),
    title,
    shortDescription: plainText(description, 160),
    description,
    images: galleryImages(dropi),
    category: String(categories[0]?.name || "").trim(),
    price,
    compareAtPrice: compareAtFor(price),
    type: variants.length ? "VARIABLE" : "SIMPLE",
    variants,
    offers: defaultOffers(price),
    stock,
    isPublished: false,
    dropiId,
    dropiSupplierId: Number(dropi?.user_id ?? dropi?.user?.id) || null,
    costPrice,
    suggestedPrice,
    lastSyncedAt: new Date(),
  });

  return product.toObject();
}

/** Refresca stock y costo de los importados, empezando por los más viejos. */
export async function syncProducts() {
  const started = Date.now();
  const products = await Product.find({ dropiId: { $exists: true } }).sort({ lastSyncedAt: 1 });
  let updated = 0;
  let failed = 0;

  for (const product of products) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    try {
      const dropi = await dropiService.getProduct(product.dropiId);
      applyRefresh(product, dropi);
      await product.save();
      updated++;
    } catch (error: any) {
      failed++;
      console.error(`[dropi-sync] producto ${product.dropiId}:`, error?.message);
    }
    await sleep(PAUSE_MS);
  }

  return { total: products.length, updated, failed, pending: products.length - updated - failed };
}

// ── Ubicaciones ─────────────────────────────────────────────────────────────

export async function syncLocations() {
  const provinces = await dropiService.getProvinces();
  let cities = 0;

  for (const province of provinces) {
    const provinceId = Number(province?.id);
    if (!provinceId) continue;
    await Location.updateOne(
      { kind: "province", dropiId: provinceId },
      { $set: { name: String(province?.name || "").trim(), provinceId: null, raw: province } },
      { upsert: true },
    );

    try {
      const list = await dropiService.getCities(provinceId);
      for (const city of list) {
        const cityId = Number(city?.id);
        if (!cityId) continue;
        await Location.updateOne(
          { kind: "city", dropiId: cityId },
          { $set: { name: String(city?.name || "").trim(), provinceId, raw: city } },
          { upsert: true },
        );
        cities++;
      }
    } catch (error: any) {
      console.error(`[dropi-sync] ciudades de ${province?.name}:`, error?.message);
    }
    await sleep(PAUSE_MS);
  }

  return { provinces: provinces.length, cities };
}

// ── Órdenes ─────────────────────────────────────────────────────────────────

/** Refresca estado, guía y transportadora de los pedidos que siguen en camino. */
export async function syncOrders() {
  const started = Date.now();
  const orders = await Order.find({
    "dropi.orderId": { $ne: null },
    status: { $in: ["sent_to_dropi", "shipped"] },
  }).sort({ "dropi.lastSyncAt": 1 });
  let updated = 0;
  let failed = 0;

  for (const order of orders) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    try {
      const remote = await dropiService.getOrder(order.dropi.orderId);
      const nextStatus = dropiService.mapDropiStatus(remote.status);
      if (remote.status) order.dropi.status = remote.status;
      if (remote.guide) order.dropi.guide = remote.guide;
      if (remote.carrier) order.dropi.carrier = remote.carrier;
      order.dropi.lastSyncAt = new Date();
      if (nextStatus !== order.status) {
        order.status = nextStatus;
        order.history.push({ status: nextStatus, note: `Dropi: ${remote.status}`, at: new Date() });
      }
      await order.save();
      updated++;
    } catch (error: any) {
      failed++;
      console.error(`[dropi-sync] pedido ${order.number}:`, error?.message);
    }
    await sleep(PAUSE_MS);
  }

  return { total: orders.length, updated, failed };
}
