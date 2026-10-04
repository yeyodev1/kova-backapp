import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Lead } from "../models/lead.model";
import { PAYMENT_METHODS, PaymentMethod } from "../models/order.model";
import { Product } from "../models/product.model";
import { getSettings, ISettings, transfersEnabled } from "../models/setting.model";
import { normalizeEcPhone } from "../utils/phone";

export const MAX_UNITS_PER_LINE = 10;
const MAX_LINES = 20;

export interface CartItemInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

/** Línea calculada en el servidor. Incluye ids de Dropi para crear el pedido después. */
export interface QuoteLine {
  product: string;
  variantId: string | null;
  title: string;
  variantName: string;
  image: string;
  quantity: number;
  unitPrice: number;
  total: number;
  dropiId: number | null;
  dropiVariationId: number | null;
}

export interface QuoteResult {
  subtotal: number;
  shippingFee: number;
  surcharge: number;
  total: number;
  items: QuoteLine[];
  surcharges: Record<PaymentMethod, number>;
  /** Formas de pago que se pueden elegir hoy (transferencia depende del panel). */
  available: Record<PaymentMethod, boolean>;
}

export const TRANSFERS_OFF =
  "Por ahora no recibimos transferencias. Elige tarjeta o contra entrega";

export function parsePaymentMethod(value: unknown, fallback?: PaymentMethod): PaymentMethod {
  if ((value === undefined || value === null || value === "") && fallback) return fallback;
  if (!PAYMENT_METHODS.includes(value as PaymentMethod)) {
    throw new CustomError("Elige un método de pago válido", 400);
  }
  return value as PaymentMethod;
}

export function parseCartItems(raw: unknown): CartItemInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CustomError("Tu carrito está vacío", 400);
  }
  if (raw.length > MAX_LINES) throw new CustomError("Demasiados productos en el carrito", 400);
  return raw.map((item: any) => {
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new CustomError("La cantidad debe ser un número entero mayor a cero", 400);
    }
    if (quantity > MAX_UNITS_PER_LINE) {
      throw new CustomError(`Máximo ${MAX_UNITS_PER_LINE} unidades por producto`, 400);
    }
    const productId = String(item?.productId ?? "");
    if (!isValidObjectId(productId)) throw new CustomError("Producto no válido", 400);
    const variantId = item?.variantId ? String(item.variantId) : null;
    return { productId, variantId, quantity };
  });
}

export function availableMethods(settings: ISettings): Record<PaymentMethod, boolean> {
  return { card: true, cod: true, transfer: transfersEnabled(settings) };
}

export function surchargesFor(settings: ISettings): Record<PaymentMethod, number> {
  return {
    card: 0,
    cod: settings.codSurcharge || 0,
    transfer: settings.transferSurcharge || 0,
  };
}

/**
 * Precio unitario según la oferta por cantidad. Si la cantidad supera la oferta
 * más grande se aplica esa. En variantes con precio distinto al base se aplica
 * el mismo porcentaje de descuento de la oferta.
 */
function unitPriceFor(product: any, basePrice: number, quantity: number): number {
  const offers: any[] = (product.offers || []).filter(
    (o: any) => o.quantity >= 1 && o.unitPrice > 0,
  );
  if (!offers.length) return basePrice;
  const largest = offers.reduce((a, b) => (b.quantity > a.quantity ? b : a));
  const offer =
    offers.find((o) => o.quantity === quantity) || (quantity > largest.quantity ? largest : null);
  if (!offer) return basePrice;
  if (!product.price || basePrice === product.price) return offer.unitPrice;
  return Math.round((basePrice * offer.unitPrice) / product.price);
}

export async function buildQuote(rawItems: unknown, rawMethod: unknown): Promise<QuoteResult> {
  const cart = parseCartItems(rawItems);
  const paymentMethod = parsePaymentMethod(rawMethod, "card");
  const settings = await getSettings();
  const available = availableMethods(settings);
  if (!available[paymentMethod]) throw new CustomError(TRANSFERS_OFF, 400);

  const ids = Array.from(new Set(cart.map((i) => i.productId)));
  const products = await Product.find({ _id: { $in: ids } }).lean();
  const byId = new Map(products.map((p: any) => [String(p._id), p]));

  const items: QuoteLine[] = cart.map((line) => {
    const product: any = byId.get(line.productId);
    if (!product || !product.isPublished) {
      throw new CustomError("Uno de los productos ya no está disponible", 400);
    }

    let variant: any = null;
    if (product.type === "VARIABLE" && product.variants?.length) {
      if (!line.variantId) throw new CustomError(`Elige una opción de ${product.title}`, 400);
      variant = product.variants.find((v: any) => String(v._id) === line.variantId);
      if (!variant)
        throw new CustomError(`La opción elegida de ${product.title} ya no existe`, 400);
    }

    const stock = variant ? variant.stock : product.stock;
    if (!stock || stock <= 0) throw new CustomError(`Producto agotado: ${product.title}`, 400);
    if (line.quantity > stock) {
      throw new CustomError(`Solo quedan ${stock} unidades de ${product.title}`, 400);
    }

    const basePrice = variant ? variant.price : product.price;
    if (!basePrice || basePrice <= 0) {
      throw new CustomError(`${product.title} no tiene precio disponible`, 400);
    }
    const unitPrice = unitPriceFor(product, basePrice, line.quantity);

    return {
      product: String(product._id),
      variantId: variant ? String(variant._id) : null,
      title: product.title,
      variantName: variant?.name || "",
      image: product.images?.[0] || "",
      quantity: line.quantity,
      unitPrice,
      total: unitPrice * line.quantity,
      dropiId: product.dropiId ?? null,
      dropiVariationId: variant?.dropiVariationId ?? null,
    };
  });

  const subtotal = items.reduce((acc, i) => acc + i.total, 0);
  const freeShipping = settings.freeShippingFrom > 0 && subtotal >= settings.freeShippingFrom;
  const shippingFee = freeShipping ? 0 : settings.shippingFee || 0;
  const surcharges = surchargesFor(settings);
  const surcharge = surcharges[paymentMethod];

  return {
    subtotal,
    shippingFee,
    surcharge,
    total: subtotal + shippingFee + surcharge,
    items,
    surcharges,
    available,
  };
}

/** POST /checkout/quote: misma cuenta que el pedido, sin ids internos de Dropi. */
export async function quote(rawItems: unknown, rawMethod: unknown) {
  const result = await buildQuote(rawItems, rawMethod);
  return {
    ...result,
    items: result.items.map(({ dropiId, dropiVariationId, ...item }) => item),
  };
}

/** Guarda (o actualiza) el carrito abandonado de un teléfono para recuperarlo por WhatsApp. */
export async function saveLead(input: { phone?: unknown; firstName?: unknown; items?: unknown }) {
  const phone = normalizeEcPhone(input.phone);
  if (!phone) throw new CustomError("Escribe un celular válido (09XXXXXXXX)", 400);

  const rawItems = Array.isArray(input.items) ? input.items.slice(0, MAX_LINES) : [];
  const valid = rawItems.filter((i: any) => isValidObjectId(String(i?.productId ?? "")));
  const products = await Product.find({ _id: { $in: valid.map((i: any) => String(i.productId)) } })
    .select("title")
    .lean();
  const titles = new Map(products.map((p: any) => [String(p._id), p.title]));

  const items = valid
    .filter((i: any) => titles.has(String(i.productId)))
    .map((i: any) => ({
      productId: String(i.productId),
      variantId: i?.variantId ? String(i.variantId) : null,
      title: titles.get(String(i.productId)) || "",
      quantity: Math.min(Math.max(Number(i?.quantity) || 1, 1), MAX_UNITS_PER_LINE),
    }));

  const firstName = String(input.firstName ?? "")
    .trim()
    .slice(0, 60);
  const update: Record<string, unknown> = { items };
  if (firstName) update.firstName = firstName;

  await Lead.findOneAndUpdate(
    { phone, converted: false },
    { $set: update, $setOnInsert: { phone } },
    { upsert: true },
  );
  return { ok: true };
}
