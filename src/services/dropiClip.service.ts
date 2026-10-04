import { CustomError } from "../errors/customError.error";
import { Product } from "../models/product.model";
import {
  buildVariant,
  createDraftProduct,
  markupOr,
  sanitizeDescription,
} from "./dropiSync.service";

/**
 * "Enviar a Kova": productos que el dueño lee de su propia sesión en app.dropi.ec con el
 * bookmarklet y manda al panel. El servidor no le habla a Dropi: solo valida lo que llega
 * (viene de un DOM ajeno, se trata como entrada no confiable) y lo guarda con las mismas
 * reglas que la importación por API.
 */

export const MAX_CLIP_PRODUCTS = 60;
const MAX_IMAGES = 12;
const MAX_VARIANTS = 50;
const MAX_DESCRIPTION = 20000;
/** Tope de cordura para montos y stock que vienen de leer texto de una página. */
const MAX_INT = 100_000_000;

export interface ClipVariant {
  name: string;
  dropiVariationId: number | null;
  costPrice: number;
  stock?: number;
}

export interface ClipProduct {
  dropiId: number;
  title: string;
  images: string[];
  costPrice?: number;
  suggestedPrice?: number;
  /** Precio de venta manual: Dropi dibuja los precios en canvas y a veces no hay costo. */
  price?: number;
  description?: string;
  stock?: number;
  category?: string;
  variants: ClipVariant[];
  sourceUrl?: string;
}

export interface ClipResult {
  dropiId: number | null;
  productId: string | null;
  title: string;
  status: "created" | "updated" | "error";
  message?: string;
}

function optionalInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_INT) {
    throw new CustomError(`${field} debe ser un entero mayor o igual a 0`, 400);
  }
  return n;
}

function text(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function httpsImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const urls: string[] = [];
  for (const raw of value) {
    const candidate = String(raw ?? "").trim();
    if (candidate.length > 2000) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && !urls.includes(url.href)) urls.push(url.href);
    } catch {
      // URL inválida: se descarta sin romper el resto del producto.
    }
    if (urls.length >= MAX_IMAGES) break;
  }
  return urls;
}

function cleanVariants(value: unknown): ClipVariant[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_VARIANTS).flatMap((raw: any, i) => {
    const name = text(raw?.name, 120);
    if (!name) return [];
    const variationId = Number(raw?.dropiVariationId);
    return [
      {
        name,
        dropiVariationId: Number.isInteger(variationId) && variationId > 0 ? variationId : null,
        costPrice: optionalInt(raw?.costPrice, `Costo de la variante ${i + 1}`) ?? 0,
        stock: optionalInt(raw?.stock, `Stock de la variante ${i + 1}`),
      },
    ];
  });
}

/** Valida y limpia un producto recibido. Lanza CustomError con el motivo en español. */
export function cleanClipProduct(raw: any): ClipProduct {
  if (!raw || typeof raw !== "object") throw new CustomError("Producto vacío", 400);
  const dropiId = Number(raw.dropiId);
  if (!Number.isInteger(dropiId) || dropiId <= 0) {
    throw new CustomError("Falta el ID de Dropi (entero mayor a 0)", 400);
  }
  const title = text(raw.title, 1000);
  if (title.length < 2 || title.length > 200) {
    throw new CustomError("El título debe tener entre 2 y 200 caracteres", 400);
  }

  const description =
    raw.description === undefined || raw.description === null
      ? undefined
      : sanitizeDescription(String(raw.description).slice(0, MAX_DESCRIPTION));
  const sourceUrl = text(raw.sourceUrl, 500);

  return {
    dropiId,
    title,
    images: httpsImages(raw.images),
    costPrice: optionalInt(raw.costPrice, "El costo"),
    suggestedPrice: optionalInt(raw.suggestedPrice, "El precio sugerido"),
    price: optionalInt(raw.price, "El precio de venta"),
    description: description || undefined,
    stock: optionalInt(raw.stock, "El stock"),
    category: text(raw.category, 80) || undefined,
    variants: cleanVariants(raw.variants),
    sourceUrl: /^https:\/\//i.test(sourceUrl) ? sourceUrl : undefined,
  };
}

function toVariants(clip: ClipProduct, markup: number) {
  return clip.variants.map((v) =>
    buildVariant(
      {
        dropiVariationId: v.dropiVariationId,
        name: v.name,
        stock: v.stock ?? 0,
        // Sin costo propio, la variante hereda el del producto para no quedar a $0.
        costPrice: v.costPrice || clip.costPrice || 0,
        suggestedPrice: 0,
      },
      markup,
    ),
  );
}

/**
 * Producto ya enlazado: solo se refresca lo que viene de Dropi (costo, sugerido, stock, imágenes
 * si no tenía). Precio, textos, ofertas y publicado son de la tienda y no se tocan.
 */
function applyClipRefresh(product: any, clip: ClipProduct) {
  if (clip.costPrice !== undefined) product.costPrice = clip.costPrice;
  if (clip.suggestedPrice !== undefined) product.suggestedPrice = clip.suggestedPrice;

  let touchedVariants = false;
  for (const variant of product.variants || []) {
    const match = clip.variants.find(
      (v) => v.dropiVariationId !== null && v.dropiVariationId === variant.dropiVariationId,
    );
    if (!match) continue;
    if (match.costPrice) variant.costPrice = match.costPrice;
    if (match.stock !== undefined) {
      variant.stock = match.stock;
      touchedVariants = true;
    }
  }

  if (touchedVariants) {
    product.stock = product.variants.reduce((acc: number, v: any) => acc + (v.stock || 0), 0);
  } else if (clip.stock !== undefined && !product.variants?.length) {
    product.stock = clip.stock;
  }

  if (!product.images?.length && clip.images.length) product.images = clip.images;
  product.lastSyncedAt = new Date();
}

async function upsertClip(clip: ClipProduct, markup: number): Promise<ClipResult> {
  const existing = await Product.findOne({ dropiId: clip.dropiId });
  if (existing) {
    applyClipRefresh(existing, clip);
    await existing.save();
    return {
      dropiId: clip.dropiId,
      productId: String(existing._id),
      title: existing.title,
      status: "updated",
    };
  }

  const product = await createDraftProduct(
    {
      dropiId: clip.dropiId,
      title: clip.title,
      description: clip.description ?? "",
      images: clip.images,
      category: clip.category ?? "",
      costPrice: clip.costPrice ?? 0,
      suggestedPrice: clip.suggestedPrice ?? 0,
      stock: clip.stock ?? 0,
      variants: toVariants(clip, markup),
      price: clip.price,
    },
    markup,
  );
  return {
    dropiId: clip.dropiId,
    productId: String(product._id),
    title: product.title,
    status: "created",
    ...(product.price ? {} : { message: "Quedó sin precio: ponle precio antes de publicar" }),
  };
}

/** Crea o actualiza por `dropiId`. Un producto con error no frena a los demás. */
export async function importClip(products: unknown, markupPercent?: number) {
  if (!Array.isArray(products) || !products.length) {
    throw new CustomError("No llegaron productos para importar", 400);
  }
  if (products.length > MAX_CLIP_PRODUCTS) {
    throw new CustomError(`Máximo ${MAX_CLIP_PRODUCTS} productos por envío`, 400);
  }
  if (
    markupPercent !== undefined &&
    (!Number.isFinite(markupPercent) || markupPercent < 0 || markupPercent > 1000)
  ) {
    throw new CustomError("El margen debe estar entre 0 y 1000%", 400);
  }
  const markup = await markupOr(markupPercent);

  const results: ClipResult[] = [];
  for (const raw of products as any[]) {
    const fallbackId = Number(raw?.dropiId);
    const fallback = {
      dropiId: Number.isInteger(fallbackId) && fallbackId > 0 ? fallbackId : null,
      productId: null,
      title: text(raw?.title, 200),
    };
    try {
      results.push(await upsertClip(cleanClipProduct(raw), markup));
    } catch (error: any) {
      // Choque de índice único: otro envío creó el mismo dropiId justo antes.
      const message =
        error?.code === 11000
          ? "Otro producto ya usa ese ID de Dropi"
          : error instanceof CustomError
            ? error.message
            : "No se pudo guardar el producto";
      if (!(error instanceof CustomError)) console.error("[dropi-clip]", error?.message);
      results.push({ ...fallback, status: "error", message });
    }
  }
  return { results };
}

/** Cuáles de estos ids de Dropi ya están en la tienda, para marcarlos antes de importar. */
export async function linkedProducts(rawIds: unknown) {
  const ids = String(rawIds ?? "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, MAX_CLIP_PRODUCTS);
  if (!ids.length) return { items: [] };
  const found = await Product.find({ dropiId: { $in: ids } })
    .select("dropiId title isPublished")
    .lean();
  return {
    items: found.map((p: any) => ({
      dropiId: p.dropiId,
      productId: String(p._id),
      title: p.title,
      isPublished: !!p.isPublished,
    })),
  };
}
