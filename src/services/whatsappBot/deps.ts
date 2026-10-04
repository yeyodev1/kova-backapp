import { isValidObjectId } from "mongoose";
import { env } from "../../config/env";
import { Location } from "../../models/location.model";
import { Order } from "../../models/order.model";
import { Product } from "../../models/product.model";
import { getSettings } from "../../models/setting.model";
import { normalizeEcPhone } from "../../utils/phone";
import { buildQuote, saveLead } from "../checkout.service";
import { geminiEnabled } from "../gemini.service";
import { attachReceipt, createOrder, isReceiptType, settleCardPayment } from "../order.service";
import { isPayphoneConfigured } from "../payphone.service";
import type { BotProduct } from "./catalog";
import { chosenBank } from "./checkout";
import { aiExtract, heuristicExtract } from "./extractor";
import type { LocationIndex } from "./location";
import {
  describeImage,
  downloadMedia,
  mediaKindFromMime,
  probeMediaKind,
  readReceipt,
} from "./media";
import type {
  BotDeps,
  BotState,
  CardCheck,
  CreateOutcome,
  MediaOutcome,
  OrderSummary,
  QuoteOutcome,
} from "./types";

/**
 * Dependencias reales del router: Mongo y los servicios de Kova. Reutiliza
 * checkout.service (precios) y order.service (crear pedido, comprobante,
 * Payphone): el bot no tiene lógica de pedidos propia.
 */

export const storeUrl = () => env.PUBLIC_WEB_URL.replace(/\/$/, "");
export const payLink = (token: string) => `${storeUrl()}/pagar/${token}`;

let catalogCache: { at: number; products: BotProduct[] } | null = null;

export async function loadCatalog(): Promise<BotProduct[]> {
  if (catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.products;
  const docs: any[] = await Product.find({ isPublished: true })
    .select(
      "slug title shortDescription category price compareAtPrice type variants offers benefits stock soldCount",
    )
    .sort({ soldCount: -1 })
    .limit(300)
    .lean();
  const products: BotProduct[] = [];
  for (const doc of docs) {
    const variants =
      doc.type === "VARIABLE"
        ? (doc.variants || [])
            .filter((v: any) => v.stock > 0 && v.price > 0)
            .map((v: any) => ({
              id: String(v._id),
              name: v.name || "Opción",
              price: v.price,
              stock: v.stock,
            }))
        : [];
    if (doc.type === "VARIABLE" && doc.variants?.length && !variants.length) continue;
    const stock = variants.length
      ? variants.reduce((sum: number, v: any) => sum + v.stock, 0)
      : doc.stock;
    const price = variants.length ? Math.min(...variants.map((v: any) => v.price)) : doc.price;
    if (!stock || stock <= 0 || !price) continue;
    products.push({
      id: String(doc._id),
      slug: doc.slug,
      name: doc.title,
      price,
      compareAtPrice: doc.compareAtPrice || 0,
      category: doc.category || "",
      type: doc.type === "VARIABLE" && variants.length ? "VARIABLE" : "SIMPLE",
      variants,
      offers: (doc.offers || [])
        .filter((o: any) => o.quantity >= 1 && o.unitPrice > 0)
        .map((o: any) => ({ quantity: o.quantity, unitPrice: o.unitPrice, label: o.label || "" })),
      stock,
      description: [doc.shortDescription, ...(doc.benefits || [])]
        .filter(Boolean)
        .join(". ")
        .slice(0, 400),
    });
  }
  catalogCache = { at: Date.now(), products };
  return products;
}

let locationCache: { at: number; index: LocationIndex } | null = null;

export async function loadLocations(): Promise<LocationIndex> {
  if (locationCache && Date.now() - locationCache.at < 10 * 60_000) return locationCache.index;
  const docs: any[] = await Location.find({}).select("kind dropiId name provinceId").lean();
  const index: LocationIndex = {
    provinces: docs
      .filter((d) => d.kind === "province")
      .map((d) => ({ id: d.dropiId, name: d.name })),
    cities: docs
      .filter((d) => d.kind === "city")
      .map((d) => ({ id: d.dropiId, name: d.name, provinceId: d.provinceId })),
  };
  // Sin ubicaciones no se cachea: pueden sincronizarse en cualquier momento.
  if (index.provinces.length) locationCache = { at: Date.now(), index };
  return index;
}

async function quote(
  items: Array<{ productId: string; variantId: string | null; quantity: number }>,
  method: "card" | "transfer" | "cod",
): Promise<QuoteOutcome> {
  try {
    const result = await buildQuote(items, method);
    return {
      ok: true,
      quote: {
        subtotal: result.subtotal,
        shippingFee: result.shippingFee,
        surcharge: result.surcharge,
        total: result.total,
        surcharges: result.surcharges,
        items: result.items.map((item) => ({
          productId: item.product,
          variantId: item.variantId,
          title: item.title,
          variantName: item.variantName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          total: item.total,
        })),
      },
    };
  } catch (error: any) {
    if (error?.status && error.status < 500) return { ok: false, message: error.message };
    throw error;
  }
}

async function createBotOrder(state: BotState, deps: BotDeps): Promise<CreateOutcome> {
  try {
    const result: any = await createOrder(
      {
        items: state.cart.map((line) => ({
          productId: line.productId,
          variantId: line.variantId,
          quantity: line.quantity,
        })),
        paymentMethod: state.paymentMethod,
        customer: {
          firstName: state.firstName,
          lastName: state.lastName,
          phone: state.phone,
          email: state.email,
          idNumber: state.idNumber,
        },
        address: {
          provinceId: state.provinceId,
          province: state.province,
          cityId: state.cityId,
          city: state.city,
          street: state.street,
          reference: state.reference,
        },
      },
      { channel: "whatsapp_bot", transferBank: chosenBank(state, deps)?.bank || "" },
    );
    const order = result.order;
    return {
      ok: true,
      order: {
        orderId: String(order._id),
        orderNumber: order.number,
        total: order.total,
        paymentLink: order.payToken ? payLink(order.payToken) : "",
      },
    };
  } catch (error: any) {
    if (error?.status && error.status < 500) return { ok: false, message: error.message };
    throw error;
  }
}

/** Pedido por transferencia que espera comprobante: el del chat o el último del teléfono. */
async function transferOrderFor(phone: string, orderId: string) {
  const open = {
    paymentMethod: "transfer",
    status: { $in: ["awaiting_transfer", "transfer_review"] },
  };
  if (orderId && isValidObjectId(orderId)) {
    const order = await Order.findOne({ _id: orderId, ...open });
    if (order) return order;
  }
  if (!phone) return null;
  return Order.findOne({ ...open, "customer.phone": phone }).sort({ status: 1, createdAt: -1 });
}

/**
 * Archivo del cliente. La IA mira primero QUÉ es: solo un comprobante se guarda
 * en el pedido por transferencia; una foto de producto se cruza con el catálogo.
 */
async function receiveMedia(
  phone: string,
  orderId: string,
  mediaUrl: string,
): Promise<MediaOutcome> {
  try {
    const probed = await probeMediaKind(mediaUrl);
    if (probed) return { status: probed };
    let file;
    try {
      file = await downloadMedia(mediaUrl);
    } catch (error: any) {
      if (/maxContentLength/i.test(String(error?.message))) return { status: "video" };
      throw error;
    }
    const kind = mediaKindFromMime(file.mimeType);
    if (kind) return { status: kind };
    if (!isReceiptType(file.mimeType)) return { status: "unsupported" };

    const order: any = await transferOrderFor(phone, orderId);
    const store = async (): Promise<MediaOutcome> => {
      if (!order) return { status: "no_order" };
      const reading = await readReceipt(file, { total: order.total, orderNumber: order.number });
      const note = reading
        ? `Comprobante por WhatsApp. Lectura automática (no verificada): ${reading.summary || "sin resumen"}${reading.detectedAmount !== null ? ` · monto $${(reading.detectedAmount / 100).toFixed(2)}` : ""}${reading.detectedReference ? ` · ref ${reading.detectedReference}` : ""}`
        : "Comprobante por WhatsApp";
      await attachReceipt(order, file.buffer, file.mimeType, note);
      return {
        status: "stored",
        orderNumber: order.number,
        total: order.total,
        detectedAmount: reading?.detectedAmount ?? null,
        isReceipt: reading?.isReceipt ?? null,
      };
    };

    // Un PDF se trata como comprobante. Sin IA disponible también (lo revisa una persona).
    if (!file.mimeType.startsWith("image/")) return store();
    const insight = await describeImage(file, await loadCatalog());
    if (!insight || insight.kind === "receipt") return store();
    return {
      status: "image",
      kind: insight.kind,
      description: insight.description,
      searchQuery: insight.searchQuery,
      productIds: insight.productIds,
      exactMatch: insight.exactMatch,
      pendingOrderNumber: order?.number,
    };
  } catch (error: any) {
    console.error("[whatsapp-bot] no se pudo procesar el archivo:", error?.message || error);
    return { status: "error" };
  }
}

/** "pagado": verifica con Payphone el pedido de tarjeta del chat o el último pendiente del teléfono. */
async function checkCardPayment(phone: string, orderId: string): Promise<CardCheck | null> {
  const card = { paymentMethod: "card" };
  const order: any =
    (orderId &&
      isValidObjectId(orderId) &&
      (await Order.findOne({ _id: orderId, ...card }).lean())) ||
    (phone
      ? await Order.findOne({
          ...card,
          "customer.phone": phone,
          status: { $in: ["pending_payment", "failed", "confirmed"] },
        })
          .sort({ createdAt: -1 })
          .lean()
      : null);
  if (!order) return null;
  const outcome = await settleCardPayment(String(order._id));
  if (outcome === "not_applicable") return null;
  return {
    outcome,
    orderNumber: order.number,
    total: order.total,
    paymentLink: order.payToken ? payLink(order.payToken) : "",
  };
}

/** Pedidos de este teléfono. Un KV- de otro teléfono no se muestra (privacidad). */
async function findOrders(phone: string, number?: string): Promise<OrderSummary[]> {
  if (!phone) return [];
  const filter: Record<string, unknown> = { "customer.phone": phone };
  if (number) filter.number = number.toUpperCase();
  const orders: any[] = await Order.find(filter).sort({ createdAt: -1 }).limit(5).lean();
  return orders.map((order) => ({
    id: String(order._id),
    number: order.number,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    total: order.total,
    guide: order.dropi?.guide || "",
    carrier: order.dropi?.carrier || "",
    paymentLink:
      order.paymentMethod === "card" &&
      ["pending_payment", "failed"].includes(order.status) &&
      order.payToken
        ? payLink(order.payToken)
        : "",
  }));
}

/**
 * `sessionPhone`: 09XXXXXXXX o "lid:…". `knownPhone`: el que dio el cliente si
 * WhatsApp ocultó el número.
 */
export async function buildDeps(sessionPhone: string, knownPhone = ""): Promise<BotDeps> {
  const whatsappPhone = normalizeEcPhone(sessionPhone) || "";
  const phone = whatsappPhone || normalizeEcPhone(knownPhone) || "";
  const settings = await getSettings();
  const deps: BotDeps = {
    loadCatalog,
    loadLocations,
    extract: geminiEnabled() ? aiExtract : heuristicExtract,
    quote,
    createOrder: (state) => createBotOrder(state, deps),
    receiveMedia: (orderId, mediaUrl) => receiveMedia(phone, orderId, mediaUrl),
    checkCardPayment: (orderId) => checkCardPayment(phone, orderId),
    findOrders: (number) => findOrders(phone, number),
    saveLead: (state) => {
      const leadPhone = normalizeEcPhone(state.phone);
      if (!leadPhone || !state.cart.length) return;
      void saveLead({
        phone: leadPhone,
        firstName: state.firstName,
        items: state.cart.map((line) => ({
          productId: line.productId,
          variantId: line.variantId,
          quantity: line.quantity,
        })),
      }).catch((error: any) =>
        console.error("[whatsapp-bot] no se pudo guardar el carrito:", error?.message),
      );
    },
    banks: (settings.bankAccounts || [])
      .filter((account) => account.number)
      .map((account) => ({ ...account })),
    cardEnabled: isPayphoneConfigured(),
    supportPhone: env.BOT_SUPPORT_PHONE,
    storeUrl: storeUrl(),
    whatsappPhone,
  };
  return deps;
}
