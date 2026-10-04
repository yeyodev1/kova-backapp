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
| GET | `/admin/dropi/status` | `?refresh=1` → `{ configured, connected, message, blockedIp, integrationUrl, urlMismatch, checkedAt }`. Una sola llamada liviana a Dropi (`GET /department`), cacheada 60 s (`refresh=1` la salta, máximo cada 10 s). `blockedIp` = IP que Dropi reporta en su `401 Access denied`. `integrationUrl` sale del payload del token (decodificado sin verificar firma); el token nunca se devuelve. `urlMismatch` = la integración no está registrada con `kovashopper.com` |
| GET | `/admin/dropi/products` | `?q&page&limit` → busca en el catálogo de Dropi: `{ items: [{ dropiId, name, type, costPrice, suggestedPrice, stock, image, imported: boolean }], total }` |
| POST | `/admin/dropi/import` | `{ dropiId?, url?, markupPercent? }` → crea/actualiza `Product` (borrador) con imágenes, variantes, stock, precio = sugerido o costo × (1+markup). Acepta el id (`12345`) o un link de producto de Dropi (`.../product-details/12345`, `?id=12345`): se toma el último número de 3+ dígitos del path/query. 400 si no hay id |
| POST | `/admin/dropi/clip` | Botón **Enviar a Kova** (ver `docs/DROPI.md`). `{ products: ClipProduct[], markupPercent? }`, máx 60 → `{ results: [{ dropiId, productId, title, status: "created" \| "updated" \| "error", message? }] }`. No llama a Dropi: guarda lo que el dueño leyó en su propia sesión. Un producto con error no frena a los demás (400 solo si `products` no es lista, está vacía o pasa de 60, o el margen no está entre 0 y 1000) |
| GET | `/admin/dropi/linked` | `?ids=1,2,3` (máx 60) → `{ items: [{ dropiId, productId, title, isPublished }] }`: cuáles ya están en la tienda, para marcar "Ya importado" antes de importar |
| POST | `/admin/dropi/sync-products` | refresca stock y costo de todos los importados |
| POST | `/admin/dropi/sync-locations` | descarga provincias y ciudades de Dropi a Mongo |
| POST | `/admin/dropi/sync-orders` | refresca estado/guía de órdenes `sent_to_dropi`/`shipped` |
| GET | `/admin/products` | `?q&page&published` → `Paginated<Product>` (con campos admin) |
| POST | `/admin/products` | crear producto manual (201). `title` obligatorio; opcionales `slug, shortDescription, description, category, images, price, compareAtPrice, costPrice, dropiId`. Slug único, `isPublished:false`, ofertas 1/2/3 u si hay precio |
| GET/PUT/DELETE | `/admin/products/:id` | editar precio, ofertas, textos, beneficios, FAQs, publicar, destacar. Enlace con Dropi: `dropiId` (entero o `null` para desenlazar; 409 si otro producto ya lo usa), `costPrice` (centavos) y por variante `variants[].dropiVariationId` / `variants[].costPrice` |
| POST | `/admin/products/:id/sync-dropi` | re-sincroniza un producto enlazado con su `dropiId`: stock, costo, sugerido y variantes nuevas (entran con el margen por defecto). 400 si no está enlazado. Responde el `Product` actualizado (`lastSyncedAt` nuevo) |
| POST | `/admin/products/:id/images` | multipart `image` → Cloudinary, agrega a `images` |
| GET | `/admin/orders` | `?status&paymentMethod&q&page` → `Paginated<Order>` |
| GET | `/admin/orders/:id` | `Order` |
| POST | `/admin/orders/:id/confirm-transfer` | marca pagado y crea en Dropi |
| POST | `/admin/orders/:id/send-to-dropi` | reintento manual. Completa `dropiId`/`dropiVariationId` de los items con los del producto actual (productos enlazados después de la compra); 400 si alguno sigue sin enlazar |
| POST | `/admin/orders/:id/cancel` | cancela (y en Dropi si ya existe) |
| GET | `/admin/orders/export` | `?status&from&to&ids&paymentMethod&q` → archivo CSV para cargar en Dropi (ver abajo). Sin filtros: `confirmed` sin `dropi.orderId` |
| POST | `/admin/orders/:id/dropi-manual` | `{ dropiOrderId?: number, guide?: string, carrier?: string }` → el pedido ya se creó a mano en app.dropi.ec. Solo desde `confirmed`/`sent_to_dropi`. Queda `sent_to_dropi` (o `shipped` si trae guía), guarda `dropi.*`, limpia `dropi.error` y anota "Creado en Dropi manualmente" en el historial. 409 si el id de Dropi ya está en otro pedido. Responde `Order` |
| PUT | `/admin/orders/:id/shipping` | `{ guide?, carrier?, status?: "shipped" \| "delivered" \| "returned" }` → envío a mano (no hay sincronización automática). Transiciones: `shipped` desde `confirmed`/`sent_to_dropi` (exige guía); `delivered` desde `confirmed`/`sent_to_dropi`/`shipped`; `returned` desde `sent_to_dropi`/`shipped`/`delivered`. Agregar guía sin `status` a un pedido que no salía lo pasa a `shipped`. `delivered` en contra entrega pone `paymentStatus: "paid"`. Responde `Order` |
| GET | `/admin/leads` | `Paginated<Lead>` carritos abandonados (no convertidos) |
| GET/PUT | `/admin/settings` | `Settings` completo |

### Pedidos a Dropi a mano

Mientras la API de Dropi esté bloqueada, los pedidos **no** se crean solos en Dropi: quedan `confirmed` con
`dropi.error`. El flujo es: copiar datos o exportar → crear en app.dropi.ec → `dropi-manual` → `shipping`.

`GET /admin/orders/export` responde `text/csv; charset=utf-8` con BOM, separador `;` y
`Content-Disposition: attachment; filename="kova-pedidos-dropi-AAAAMMDDHHMM.csv"` (header `X-Orders-Count`).
Una fila por producto. Columnas: Número de pedido, Fecha (hora Ecuador), Nombre, Apellido, Celular, Cédula,
Correo, Provincia, Ciudad, Dirección, Referencia, ID producto Dropi, ID variación Dropi, Producto, Variante,
Cantidad, Precio unitario, Total del pedido, Método de pago, Cobrar al entregar (`SÍ`/`NO`), Valor a recaudar
(total si es contra entrega, `0.00` si no), Notas. Montos en **dólares con punto decimal** (`12.50`).
Celular y cédula salen como `="0991234567"` para que Excel no borre el cero inicial.
Query: `status` (un `OrderStatus` o `all`), `from`/`to` (`AAAA-MM-DD`, hora Ecuador), `ids` (ids separados por
coma: ignora los demás filtros), `paymentMethod`, `q`. Máximo 1000 pedidos.

### `POST /admin/dropi/clip`

```ts
interface ClipProduct {
  dropiId: number;              // entero > 0, obligatorio
  title: string;                // 2..200
  images: string[];             // solo https, máx 12, sin duplicados (las demás se descartan)
  costPrice?: number;           // centavos, entero ≥ 0 (precio proveedor)
  suggestedPrice?: number;      // centavos, entero ≥ 0
  price?: number;               // centavos, precio de venta manual (solo productos nuevos; gana sobre el calculado)
  description?: string;         // HTML, se pasa por sanitize-html
  stock?: number;               // entero ≥ 0
  category?: string;
  variants?: { name: string; dropiVariationId?: number | null; costPrice?: number; stock?: number }[];
  sourceUrl?: string;           // link de la página de Dropi (solo https)
}
```

- **Nuevo** `dropiId` → borrador (`isPublished: false`) con las mismas reglas que `/admin/dropi/import`
  (`createDraftProduct`): precio = sugerido si es mayor al costo, si no costo × (1 + margen) redondeado a .90;
  tachado +40%; ofertas 1/2/3 u; slug único. Con variantes: precio de cada una con su costo (o el del producto).
  Si viene `price` se usa ese. Sin costo, sugerido ni `price` queda con precio 0, sin tachado ni ofertas, y el
  resultado trae `message: "Quedó sin precio: ponle precio antes de publicar"`. (Dropi dibuja los precios del
  catálogo en canvas: el costo lo escribe el dueño en el panel.)
- **Existente** → solo costo, sugerido, stock (y el de variantes con el mismo `dropiVariationId`), imágenes si no
  tenía y `lastSyncedAt`. Nunca toca precio, textos, ofertas ni publicado.

### Productos manuales y enlace con Dropi

Mientras la API de Dropi no esté habilitada, el panel crea productos a mano y guarda su **ID de Dropi**
(el de la ficha del producto en Dropi). Con ese ID el producto entra en `sync-products` (stock y costo) y
sus pedidos se crean en Dropi como los de un producto importado.

Si Dropi rechaza por IP, cualquier endpoint que le pegue responde 502 con
`"Dropi bloquea la IP <ip>. Pide a soporte de Dropi que la agregue a tu integración."`.

## Cron (Vercel, `Bearer CRON_SECRET`)

- `GET /api/cron/dropi-orders` cada hora: sincroniza estados y guías de Dropi.
- `GET /api/cron/dropi-products` cada 6 horas: refresca stock y costo.
