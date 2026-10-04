import type { BotProduct } from "./catalog";
import type { Extractor } from "./extractor";
import type { BotPaymentMethod } from "./intents";
import type { LocationIndex, Place } from "./location";

/**
 * Tipos compartidos de la máquina de estados del bot. Todo lo externo (Mongo,
 * Gemini, Cloudinary, Payphone) entra por `BotDeps`: las pruebas corren sin red.
 */

export type Stage =
  | "idle"
  | "choosing"
  | "variant"
  | "quantity"
  | "name"
  | "phone"
  | "city"
  | "city_choice"
  | "address"
  | "reference"
  | "extras"
  | "payment"
  | "bank"
  | "confirm"
  | "ordered";

export interface CartLine {
  productId: string;
  variantId: string | null;
  title: string;
  variantName: string;
  quantity: number;
  /** Centavos, siempre del quote del servidor. */
  unitPrice: number;
  total: number;
}

/** Producto que se está eligiendo (falta la variante o la cantidad). */
export interface PendingItem {
  productId: string;
  variantId: string | null;
  quantity: number | null;
}

export interface BotState {
  stage: Stage;
  cart: CartLine[];
  /** Opciones numeradas que el bot acaba de mostrar (para "la 2"). */
  options: Array<{ productId: string; title: string }>;
  pending: PendingItem | null;
  /** Cantidades ofrecidas en el paso "quantity", en el orden mostrado. */
  quantityOptions: number[];
  firstName: string;
  lastName: string;
  /** 09XXXXXXXX: el de WhatsApp o el que escribió el cliente. */
  phone: string;
  provinceId: number;
  province: string;
  cityId: number;
  city: string;
  cityOptions: Place[];
  street: string;
  reference: string;
  referenceAsked: boolean;
  idNumber: string;
  email: string;
  extrasAsked: boolean;
  paymentMethod: BotPaymentMethod | null;
  /** Formas de pago en el orden mostrado. */
  paymentOptions: BotPaymentMethod[];
  /** Índice en settings.bankAccounts (-1 = sin elegir). */
  bankIndex: number;
  optOut: boolean;
  orderId: string;
  orderNumber: string;
  lastQuestion: string;
}

export const createInitialState = (): BotState => ({
  stage: "idle",
  cart: [],
  options: [],
  pending: null,
  quantityOptions: [],
  firstName: "",
  lastName: "",
  phone: "",
  provinceId: 0,
  province: "",
  cityId: 0,
  city: "",
  cityOptions: [],
  street: "",
  reference: "",
  referenceAsked: false,
  idNumber: "",
  email: "",
  extrasAsked: false,
  paymentMethod: null,
  paymentOptions: [],
  bankIndex: -1,
  optOut: false,
  orderId: "",
  orderNumber: "",
  lastQuestion: "",
});

/**
 * Rutas de la respuesta. Las Rules de BuilderBot van por las que decide /brain
 * (`DECISIONS` en decide.ts); estas dicen qué pasó en el turno.
 */
export type Route =
  | "conversation"
  | "catalog"
  | "confirmOrder"
  | "checkoutCard"
  | "checkoutTransfer"
  | "checkoutCod"
  | "awaitingReceipt"
  | "receiptReceived"
  | "searchOrder"
  | "human";

/** Compatibilidad con los flujos de Boloncity/Megaprinter. */
export type Intent =
  "conversar" | "menu" | "dudas" | "consultar_pedido" | "orden_creada" | "comprobante_recibido";

export interface TurnResult {
  state: BotState;
  reply: string;
  route: Route;
  intent: Intent;
  step: Stage;
  decision: string;
  orderNumber?: string;
  paymentLink?: string;
  paymentMethod?: BotPaymentMethod | null;
  /** Centavos. */
  total?: number | null;
}

export interface TurnInput {
  message: string;
  mediaUrl?: string;
  /** Llegó un archivo pero BuilderBot no mandó su URL (tipo según el evento). */
  mediaWithoutUrl?: boolean;
  mediaEvent?: "video" | "audio" | "file";
  history?: string;
}

export interface QuoteItem {
  productId: string;
  variantId: string | null;
  quantity: number;
}

export interface QuoteSummary {
  subtotal: number;
  shippingFee: number;
  surcharge: number;
  total: number;
  surcharges: Record<BotPaymentMethod, number>;
  items: Array<{
    productId: string;
    variantId: string | null;
    title: string;
    variantName: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
}

export type QuoteOutcome = { ok: true; quote: QuoteSummary } | { ok: false; message: string };

export interface BankOption {
  bank: string;
  /** Clave del catálogo de bancos: con ella se reconoce "te pago por Pichincha". */
  bankCode?: string;
  type: string;
  number: string;
  holder: string;
  idNumber: string;
}

export interface CreatedOrder {
  orderId: string;
  orderNumber: string;
  total: number;
  paymentLink: string;
}

export type CreateOutcome = { ok: true; order: CreatedOrder } | { ok: false; message: string };

/** Archivo que mandó el cliente, ya analizado. */
export type MediaOutcome =
  | {
      status: "stored";
      orderNumber: string;
      total: number;
      detectedAmount: number | null;
      isReceipt: boolean | null;
    }
  | { status: "no_order" }
  | {
      status: "image";
      kind: "product" | "other";
      description: string;
      searchQuery: string;
      productIds: string[];
      exactMatch: boolean;
      pendingOrderNumber?: string;
    }
  | { status: "video" | "audio" | "unsupported" | "error" };

export interface OrderSummary {
  id: string;
  number: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  total: number;
  guide: string;
  carrier: string;
  paymentLink: string;
}

export interface CardCheck {
  outcome: "already_paid" | "paid_now" | "pending" | "rejected" | "review" | "error";
  orderNumber: string;
  total: number;
  paymentLink: string;
}

export interface BotDeps {
  loadCatalog: () => Promise<BotProduct[]>;
  loadLocations: () => Promise<LocationIndex>;
  extract: Extractor;
  /** Precio real con `checkout.service` (ofertas por cantidad, envío y recargos). */
  quote: (items: QuoteItem[], method: BotPaymentMethod) => Promise<QuoteOutcome>;
  createOrder: (state: BotState) => Promise<CreateOutcome>;
  receiveMedia: (orderId: string, mediaUrl: string) => Promise<MediaOutcome>;
  /** Verifica con Payphone el pago con tarjeta del pedido del chat (o el último del teléfono). */
  checkCardPayment: (orderId: string) => Promise<CardCheck | null>;
  /** Pedidos del teléfono del chat, o el pedido con ese número si es de este teléfono. */
  findOrders: (orderNumber?: string) => Promise<OrderSummary[]>;
  /** Carrito abandonado: como el checkout de la web. Nunca bloquea. */
  saveLead: (state: BotState) => void;
  banks: BankOption[];
  cardEnabled: boolean;
  supportPhone: string;
  storeUrl: string;
  /** 09XXXXXXXX del WhatsApp, vacío si viene oculto (@lid). */
  whatsappPhone: string;
}
