# Contrato del API de Kova

Fuente de verdad compartida entre `kova-backapp` y `kova-frontapp`. Prefijo: `/api`.
Montos **siempre en centavos USD** (enteros). Errores: `{ message }` en español.
Paginación: `{ items, total, page, pages }`. Auth admin: `Authorization: Bearer <token>` de `/api/auth/login`.

## Modelo de negocio

Tienda de dropshipping en Ecuador conectada a **Dropi Ecuador** (`https://api.dropi.ec/integrations/`).
Los productos se importan desde Dropi, se les pone precio de venta propio y se publican.
Cada pedido termina creado en Dropi, que despacha y cobra (si aplica).

Tres métodos de pago (`paymentMethod`):

| Método | Precio | Flujo | Pedido en Dropi |
|---|---|---|---|
| `card` (Payphone) | precio base | Cajita Payphone → `/orders/confirm` → pagado | se crea al confirmar el pago, `rate_type: "SIN RECAUDO"` |
| `cod` (contra entrega) | precio base + `settings.codSurcharge` | se crea al instante | se crea al instante, `rate_type: "CON RECAUDO"`, `total_order` = total a cobrar |
| `transfer` (transferencia) | precio base + `settings.transferSurcharge` | cliente sube comprobante → admin confirma | se crea cuando el admin confirma, `"SIN RECAUDO"` |

El recargo se calcula **en el servidor** y se muestra al cliente antes de elegir.

## Tipos

```ts
type PaymentMethod = "card" | "cod" | "transfer";

interface ProductVariant {
  _id: string;
  dropiVariationId: number | null;
  name: string;              // "Negro / M"
  attributes: Record<string, string>;
  price: number;             // centavos, precio de venta
  compareAtPrice: number;    // centavos, 0 = sin tachado
  stock: number;
  sku: string;
}

interface ProductOffer {      // ofertas por cantidad (sube el ticket promedio)
  quantity: number;           // 1, 2, 3...
  unitPrice: number;          // centavos por unidad en esa oferta
  label: string;              // "Más vendido", "Ahorra 15%"
  isDefault: boolean;
}

interface Product {
  _id: string;
  slug: string;
  title: string;
  shortDescription: string;
  description: string;        // HTML saneado
  images: string[];           // URLs (Dropi CDN o Cloudinary)
  category: string;
  price: number;              // centavos (de la variante base o producto simple)
  compareAtPrice: number;     // centavos
  type: "SIMPLE" | "VARIABLE";
  variants: ProductVariant[];
  offers: ProductOffer[];
  benefits: string[];         // bullets cortos
  faqs: { question: string; answer: string }[];
  stock: number;              // suma de variantes o stock simple
  isPublished: boolean;
  isFeatured: boolean;
  soldCount: number;          // real, se suma con cada pedido
  // Solo admin:
  dropiId?: number;
  costPrice?: number;         // centavos, sale_price de Dropi
  suggestedPrice?: number;    // centavos, suggested_price de Dropi
  lastSyncedAt?: string;
}

interface Settings {
  codSurcharge: number;        // centavos
  transferSurcharge: number;   // centavos
  shippingFee: number;         // centavos, 0 = envío gratis
  freeShippingFrom: number;    // centavos, 0 = no aplica
  announcement: string;        // barra superior
  whatsapp: string;            // solo dígitos: 593997011366
  bankAccounts: { bank: string; type: string; number: string; holder: string; idNumber: string }[];
  defaultMarkupPercent: number; // margen sugerido al importar de Dropi
}

interface Province { id: number; name: string }
interface City { id: number; name: string; provinceId: number }

interface OrderItem {
  product: string; variantId: string | null;
  title: string; variantName: string; image: string;
  quantity: number; unitPrice: number; total: number;
}

type OrderStatus =
  | "pending_payment"      // card: esperando Payphone
  | "awaiting_transfer"    // transfer: esperando comprobante
  | "transfer_review"      // transfer: comprobante subido, falta revisar
  | "confirmed"            // listo para Dropi (pagado o COD)
  | "sent_to_dropi"        // creado en Dropi
  | "shipped" | "delivered" | "returned"
  | "cancelled" | "failed";

interface Order {
  _id: string;
  number: string;            // "KV-1001"
  customer: { firstName: string; lastName: string; phone: string; email: string; idNumber: string };
  address: { provinceId: number; province: string; cityId: number; city: string; street: string; reference: string };
  items: OrderItem[];
  subtotal: number; shippingFee: number; surcharge: number; total: number;
  paymentMethod: PaymentMethod;
  paymentStatus: "pending" | "paid" | "cod" | "failed" | "refunded";
  status: OrderStatus;
  transfer: { receiptUrl: string; uploadedAt: string | null; confirmedAt: string | null };
  dropi: { orderId: number | null; status: string; guide: string; carrier: string; error: string; lastSyncAt: string | null };
  notes: string;
  createdAt: string;
}
```

## Público

| Método | Ruta | Body / query | Respuesta |
|---|---|---|---|
| GET | `/store/settings` | — | `Settings` sin `defaultMarkupPercent` |
| GET | `/products` | `?page&limit&category&q&featured=1&sort=popular\|price_asc\|price_desc\|new` | `Paginated<Product>` (solo publicados, sin campos admin) |
| GET | `/products/categories` | — | `string[]` |
| GET | `/products/:slug` | — | `Product` + `related: Product[]` (máx 4) |
| GET | `/locations/provinces` | — | `Province[]` (cacheado de Dropi) |
| GET | `/locations/provinces/:id/cities` | — | `City[]` |
| POST | `/checkout/quote` | `{ items: [{ productId, variantId?, quantity }], paymentMethod }` | `{ subtotal, shippingFee, surcharge, total, items: OrderItem[], surcharges: { card, cod, transfer } }` |
| POST | `/checkout/lead` | `{ phone, firstName?, items }` | `{ ok: true }` (carrito abandonado: recuperación por WhatsApp) |
| POST | `/orders` | `{ items, paymentMethod, customer, address, notes?, utm? }` | `{ order: Order, payphone?: { token, storeId, clientTransactionId, amount, amountWithoutTax, currency: "USD", reference, email, phoneNumber } }` |
| POST | `/orders/confirm` | `{ id, clientTransactionId }` | `{ order: Order, approved: boolean }` (idempotente) |
| POST | `/orders/:number/receipt` | multipart `receipt` + `phone` | `Order` (pasa a `transfer_review`) |
| GET | `/orders/track` | `?number&phone` | `Order` reducido (número, estado, items, total, guía, transportadora) |

Reglas de `POST /orders`:
- Recalcula precios desde la base (ignora precios del cliente), valida stock y oferta por cantidad.
- `phone` ecuatoriano: 10 dígitos que empiezan en `09` (normalizar `+593 9...` → `09...`).
- `cod` → crea en Dropi al instante; si Dropi falla, la orden queda `confirmed` con `dropi.error` y el admin reintenta.
- `card` → `pending_payment` + config de la Cajita. `transfer` → `awaiting_transfer` + `settings.bankAccounts` en la respuesta del front.
- Envía correo de confirmación si hay `email` y Resend configurado.

## Admin (`authMiddleware` + `adminMiddleware`, prefijo `/admin`)

| Método | Ruta | Uso |
|---|---|---|
| GET | `/admin/dashboard` | `{ ordersToday, revenueToday, pendingTransfers, dropiErrors, ordersByStatus, last7Days: [{ date, orders, revenue }] }` |
| GET | `/admin/dropi/products` | `?q&page&limit` → busca en el catálogo de Dropi: `{ items: [{ dropiId, name, type, costPrice, suggestedPrice, stock, image, imported: boolean }], total }` |
| POST | `/admin/dropi/import` | `{ dropiId, markupPercent? }` → crea/actualiza `Product` (borrador) con imágenes, variantes, stock, precio = sugerido o costo × (1+markup) |
| POST | `/admin/dropi/sync-products` | refresca stock y costo de todos los importados |
| POST | `/admin/dropi/sync-locations` | descarga provincias y ciudades de Dropi a Mongo |
| POST | `/admin/dropi/sync-orders` | refresca estado/guía de órdenes `sent_to_dropi`/`shipped` |
| GET | `/admin/products` | `?q&page&published` → `Paginated<Product>` (con campos admin) |
| POST | `/admin/products` | crear producto manual (201). `title` obligatorio; opcionales `slug, shortDescription, description, category, images, price, compareAtPrice, costPrice, dropiId`. Slug único, `isPublished:false`, ofertas 1/2/3 u si hay precio |
| GET/PUT/DELETE | `/admin/products/:id` | editar precio, ofertas, textos, beneficios, FAQs, publicar, destacar. Enlace con Dropi: `dropiId` (entero o `null` para desenlazar; 409 si otro producto ya lo usa), `costPrice` (centavos) y por variante `variants[].dropiVariationId` / `variants[].costPrice` |
| POST | `/admin/products/:id/images` | multipart `image` → Cloudinary, agrega a `images` |
| GET | `/admin/orders` | `?status&paymentMethod&q&page` → `Paginated<Order>` |
| GET | `/admin/orders/:id` | `Order` |
| POST | `/admin/orders/:id/confirm-transfer` | marca pagado y crea en Dropi |
| POST | `/admin/orders/:id/send-to-dropi` | reintento manual. Completa `dropiId`/`dropiVariationId` de los items con los del producto actual (productos enlazados después de la compra); 400 si alguno sigue sin enlazar |
| POST | `/admin/orders/:id/cancel` | cancela (y en Dropi si ya existe) |
| GET | `/admin/leads` | `Paginated<Lead>` carritos abandonados (no convertidos) |
| GET/PUT | `/admin/settings` | `Settings` completo |

### Productos manuales y enlace con Dropi

Mientras la API de Dropi no esté habilitada, el panel crea productos a mano y guarda su **ID de Dropi**
(el de la ficha del producto en Dropi). Con ese ID el producto entra en `sync-products` (stock y costo) y
sus pedidos se crean en Dropi como los de un producto importado.

## Cron (Vercel, `Bearer CRON_SECRET`)

- `GET /api/cron/dropi-orders` cada hora: sincroniza estados y guías de Dropi.
- `GET /api/cron/dropi-products` cada 6 horas: refresca stock y costo.
