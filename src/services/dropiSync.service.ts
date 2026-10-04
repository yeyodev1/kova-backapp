import { isValidObjectId } from "mongoose";
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
import { reportIncident, resolveIncidents } from "./incidents.service";

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

export function plainText(html: string, max: number): string {
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
  return buildVariant(
    {
      dropiVariationId: Number(variation?.id) || null,
      name:
        Object.values(attributes).join(" / ") ||
        String(variation?.sku || `Variante ${variation?.id}`),
      attributes,
      stock: dropiService.variationStock(variation),
      sku: String(variation?.sku || ""),
      costPrice: dropiService.toCents(variation?.sale_price),
      suggestedPrice: dropiService.toCents(variation?.suggested_price),
    },
    markupPercent,
  );
}

export interface VariantInput {
  dropiVariationId: number | null;
  name: string;
  attributes?: Record<string, string>;
  stock: number;
  sku?: string;
  costPrice: number;
  suggestedPrice: number;
}

/** Variante con precio de venta calculado igual que al importar desde la API. */
export function buildVariant(input: VariantInput, markupPercent: number) {
  const price = salePrice(input.costPrice, input.suggestedPrice, markupPercent);
  return {
    dropiVariationId: input.dropiVariationId,
    name: input.name,
    attributes: input.attributes ?? {},
    price,
    compareAtPrice: compareAtFor(price),
    stock: input.stock,
    sku: input.sku ?? "",
    costPrice: input.costPrice,
    suggestedPrice: input.suggestedPrice,
  };
}

export async function uniqueSlug(base: string, excludeId?: unknown): Promise<string> {
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
function applyRefresh(product: any, dropi: any, markupPercent: number) {
  const isVariable = String(dropi?.type || "").toUpperCase() === "VARIABLE";
  product.costPrice = dropiService.toCents(dropi?.sale_price);
  product.suggestedPrice = dropiService.toCents(dropi?.suggested_price);
  const variations: any[] = Array.isArray(dropi?.variations) ? dropi.variations : [];

  if (isVariable && variations.length) {
    // Variaciones que el proveedor agregó después: entran con el precio calculado como al importar.
    const known = new Set((product.variants || []).map((v: any) => v.dropiVariationId));
    const fresh = variations.filter((v) => Number(v?.id) && !known.has(Number(v.id)));
    if (fresh.length) {
      product.variants.push(...fresh.map((v) => mapVariation(v, markupPercent)));
      product.type = "VARIABLE";
      if (!product.price) product.price = Math.min(...product.variants.map((v: any) => v.price));
    }
  }

  if (isVariable && product.variants?.length) {
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

/**
 * Acepta el id (`12345`) o un link de producto de Dropi. Los links cambian de forma
 * (`/product-details/12345`, `?id=12345`, con slug...), así que se toma el último
 * número de 3 o más dígitos del path o del query.
 */
export function parseDropiReference(dropiId: unknown, url: unknown): number {
  const direct = Number(dropiId);
  if (
    dropiId !== undefined &&
    dropiId !== null &&
    dropiId !== "" &&
    Number.isInteger(direct) &&
    direct > 0
  ) {
    return direct;
  }
  const text = String(url ?? dropiId ?? "").trim();
  if (!text) throw new CustomError("Indica el ID o el link del producto de Dropi", 400);
  if (/^\d+$/.test(text)) return Number(text);

  let haystack = text;
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    haystack = `${parsed.pathname} ${parsed.search} ${parsed.hash}`;
  } catch {
    // No es URL válida: se busca en el texto tal cual.
  }
  const matches = haystack.match(/\d{3,}/g);
  const id = matches ? Number(matches[matches.length - 1]) : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    throw new CustomError("No encontré el ID del producto en ese link de Dropi", 400);
  }
  return id;
}

export async function markupOr(markupPercent?: number): Promise<number> {
  if (markupPercent !== undefined && Number.isFinite(markupPercent) && markupPercent >= 0) {
    return markupPercent;
  }
  const settings = await getSettings();
  return settings.defaultMarkupPercent;
}

export async function importProduct(dropiId: number, markupPercent?: number) {
  if (!Number.isInteger(dropiId) || dropiId <= 0) {
    throw new CustomError("El id de Dropi no es válido", 400);
  }
  const markup = await markupOr(markupPercent);

  const dropi = await dropiService.getProduct(dropiId);

  const existing = await Product.findOne({ dropiId });
  if (existing) {
    applyRefresh(existing, dropi, markup);
    await existing.save();
    return existing.toObject();
  }

  const isVariable = String(dropi?.type || "").toUpperCase() === "VARIABLE";
  const variations: any[] = Array.isArray(dropi?.variations) ? dropi.variations : [];
  const categories: any[] = Array.isArray(dropi?.categories) ? dropi.categories : [];

  const product = await createDraftProduct(
    {
      dropiId,
      title: String(dropi?.name || `Producto ${dropiId}`).trim(),
      description: sanitizeDescription(dropi?.description),
      images: galleryImages(dropi),
      category: String(categories[0]?.name || "").trim(),
      costPrice: dropiService.toCents(dropi?.sale_price),
      suggestedPrice: dropiService.toCents(dropi?.suggested_price),
      stock: dropiService.productStock(dropi),
      variants: isVariable ? variations.map((v) => mapVariation(v, markup)) : [],
      dropiSupplierId: Number(dropi?.user_id ?? dropi?.user?.id) || null,
    },
    markup,
  );

  return product.toObject();
}

/**
 * Stock para productos cargados a mano o desde "Enviar a Kova": Dropi dibuja el stock en canvas y
 * no lo podemos leer, así que sin dato el producto nacería agotado y no se podría vender.
 */
export const UNKNOWN_STOCK = 50;

/** Desde aquí empiezan los ids de las ubicaciones locales de respaldo (ver seed-locations). */
export const LOCAL_LOCATION_ID = 900000;

export interface DraftInput {
  dropiId: number;
  title: string;
  /** HTML ya saneado. */
  description: string;
  images: string[];
  category: string;
  costPrice: number;
  suggestedPrice: number;
  /** Stock del producto simple; con variantes se usa la suma de ellas. */
  stock: number;
  variants: ReturnType<typeof buildVariant>[];
  dropiSupplierId?: number | null;
  /** Precio de venta que puso el dueño a mano (centavos). Gana sobre el calculado. */
  price?: number;
}

/**
 * Crea el borrador enlazado a Dropi con las reglas de precio de la tienda: sugerido si deja margen,
 * si no costo × (1 + margen) a .90; tachado +40% y ofertas 1/2/3. Lo usan la importación por API
 * y el botón "Enviar a Kova", para que ambos caminos den el mismo producto.
 */
export async function createDraftProduct(input: DraftInput, markup: number) {
  const { variants } = input;
  // Sin costo, sugerido ni precio manual no hay base: queda en 0 en vez de inventar $0.90.
  const hasBase = input.costPrice > 0 || input.suggestedPrice > 0;
  const price =
    input.price && input.price > 0
      ? input.price
      : variants.length
        ? Math.min(...variants.map((v) => v.price))
        : hasBase
          ? salePrice(input.costPrice, input.suggestedPrice, markup)
          : 0;
  const stock = variants.length ? variants.reduce((acc, v) => acc + v.stock, 0) : input.stock;

  return Product.create({
    slug: await uniqueSlug(input.title),
    title: input.title,
    shortDescription: plainText(input.description, 160),
    description: input.description,
    images: input.images,
    category: input.category,
    price,
    compareAtPrice: price ? compareAtFor(price) : 0,
    type: variants.length ? "VARIABLE" : "SIMPLE",
    variants,
    offers: price ? defaultOffers(price) : [],
    stock,
    isPublished: false,
    dropiId: input.dropiId,
    dropiSupplierId: input.dropiSupplierId ?? null,
    costPrice: input.costPrice,
    suggestedPrice: input.suggestedPrice,
    lastSyncedAt: new Date(),
  });
}

/** Re-sincroniza un producto enlazado: stock, costo y variantes nuevas. */
export async function syncProduct(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Producto no encontrado", 404);
  const product = await Product.findById(id);
  if (!product) throw new CustomError("Producto no encontrado", 404);
  if (!product.dropiId) {
    throw new CustomError(
      "Este producto no está enlazado con Dropi. Agrega su ID de Dropi y guarda antes de sincronizar.",
      400,
    );
  }
  const dropi = await dropiService.getProduct(product.dropiId);
  applyRefresh(product, dropi, await markupOr());
  await product.save();
  return product.toObject();
}

/** Refresca stock y costo de los importados, empezando por los más viejos. */
export async function syncProducts() {
  const started = Date.now();
  const markup = await markupOr();
  const products = await Product.find({ dropiId: { $exists: true, $ne: null } }).sort({
    lastSyncedAt: 1,
  });
  let updated = 0;
  let failed = 0;

  for (const product of products) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    try {
      const dropi = await dropiService.getProduct(product.dropiId);
      applyRefresh(product, dropi, markup);
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

  // Con datos reales de Dropi se van las ubicaciones locales de respaldo (seed:locations),
  // así el checkout no muestra cada provincia dos veces.
  if (provinces.length) {
    await Location.deleteMany({ dropiId: { $gte: LOCAL_LOCATION_ID } });
  }

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
  const errors: string[] = [];

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
      if (order.dropi.guide) {
        void resolveIncidents(order._id, ["order_stuck"], "Resuelta sola: Dropi asignó la guía.");
      }
      updated++;
    } catch (error: any) {
      failed++;
      errors.push(`${order.number}: ${error?.message || "error desconocido"}`);
      console.error(`[dropi-sync] pedido ${order.number}:`, error?.message);
    }
    await sleep(PAUSE_MS);
  }

  // Una sola tarjeta para la sincronización: si Dropi está caído fallan todos a la vez.
  if (failed) {
    await reportIncident({
      type: "dropi_error",
      severity: "medium",
      title: `No se pudo sincronizar ${failed} pedido${failed === 1 ? "" : "s"} con Dropi`,
      detail: `Estados y guías sin actualizar.\n${errors.slice(0, 10).join("\n")}`,
      key: "sync-orders",
    });
  }

  return { total: orders.length, updated, failed };
}
