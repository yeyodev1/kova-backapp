# Integración con Dropi Ecuador

Dropi no publica un portal de documentación. Lo que sigue sale de las dos fuentes oficiales que existen
y de pruebas contra la API real.

## Fuentes

- **PDF oficial "Integrations: Core Dropi" (2024):** https://es.scribd.com/document/804372978/Integrations-Core-Dropi-2
- **PDF "Documentación API de Dropi" (versión anterior):** https://es.scribd.com/document/683043719/Documentacion-de-Dropi-docx-7
- **Plugin oficial de WooCommerce (Dropify), código en producción:** https://wordpress.org/plugins/wc-dropi-integration/
  (ver `clasess/Constants.php`, `clasess/models/OrdersModel.php`, `clasess/models/ProductsModel.php`)
- Soporte técnico: chat dentro de app.dropi.ec.

## Conexión

- Base: `https://api.dropi.ec/integrations` (`DROPI_API_URL`).
- Header: `dropi-integration-key: <token>` (`DROPI_INTEGRATION_KEY`).
- El token se crea en app.dropi.ec → **Mis Integraciones** → Agregar (tipo WooCommerce). No vence.
  Lleva dentro la URL de la tienda (`integration_url`), que debe ser `https://kovashopper.com`.

### Acceso por IP (probado el 2026-10-03)

Con un token válido, la API responde `401 {"message":"Access denied","ip":"<ip de origen>"}`.
Dropi habilita por lista blanca de IP y dominio: hay que pedírselo a soporte con el dominio y la **IP fija de salida**
del servidor. Vercel serverless sale por IPs que cambian, así que en producción hace falta una IP de salida estática
(Vercel Static IPs, o un servidor con IP fija como proxy hacia Dropi).

## Cómo habilitar el acceso

El panel (Importar de Dropi) muestra el estado real con `GET /api/admin/dropi/status`: IP bloqueada,
URL registrada en el token y el texto listo para mandarle a soporte.

1. En app.dropi.ec → **Mis Integraciones**, abre la integración de la tienda y revisa si tiene un campo de
   **IPs permitidas** o de **URL de la tienda**. Si lo tiene, completa ahí; si no, lo hace soporte.
2. La URL de la integración debe ser `https://kovashopper.com`. El token actual dice `https://kovashopper.ec`
   (campo `integration_url` del JWT): si soporte valida por dominio, hay que corregirla o crear la integración
   de nuevo con la URL correcta y cambiar `DROPI_INTEGRATION_KEY`.
3. El token trae `ip_url: []`: la lista de IPs permitidas está vacía. Pide a soporte (chat en app.dropi.ec)
   que agregue la **IP fija de salida del servidor**. El panel muestra la IP que Dropi ve y bloquea; ojo, en
   local es la IP de tu internet, no la de producción.
4. Producción (Vercel) no tiene IP de salida fija: activa Vercel Static IPs o pasa las llamadas a Dropi por un
   servidor con IP fija, y esa es la IP que se registra.
5. Cuando Dropi la habilite, en el panel toca **Probar de nuevo**: el estado pasa a "Conectado a Dropi" y el
   buscador e importador se activan sin más cambios.

No se intenta saltar el bloqueo: el servidor nunca le habla a Dropi fuera de la integración ni usa la sesión de
la web de Dropi. Mientras tanto, la vía principal para traer productos es el botón de abajo.

## Traer productos sin API: botón "Enviar a Kova"

Un favorito (bookmarklet) que el dueño arrastra a su barra de favoritos desde **Importar de Dropi**. Él navega
app.dropi.ec con su propia sesión, abre un producto o una página del catálogo y toca el favorito: se abre
`/admin/dropi/traer` en Kova con lo que había en pantalla para elegir qué importar, ajustar margen e importarlo
(`POST /api/admin/dropi/clip`), enlazado por su ID de Dropi.

Límites (a propósito):

- Solo **lee el DOM visible** de la página que el usuario ya tiene abierta, cuando él toca el botón, una página a la vez.
- No pide ni guarda credenciales de Dropi, no llama a APIs internas de Dropi, no navega ni hace clics por su cuenta.
- El servidor tampoco llama a Dropi: recibe los datos ya leídos y los valida como entrada no confiable.
- Los datos viajan del navegador al panel con `postMessage`; el panel solo acepta mensajes de `https://*.dropi.ec`
  y `https://*.dropi.co` (y `http://localhost:*` en desarrollo).

Código: `kova-frontapp/src/utils/dropiClipper.ts` (bookmarklet y heurísticas), vista `AdminDropiClipView.vue`.

### Catálogo (`/dashboard/search`): selectores reales

Tomados del HTML guardado del catálogo (Angular, 78 tarjetas) el 2026-10-03:

| Dato | Selector |
|---|---|
| Tarjeta e **ID de Dropi** | `app-card-product[data-cy^="catalog-product-card-"]`; el id es el número de `data-cy="catalog-product-card-139710"` (fuente principal y confiable) |
| Imagen | `img.card-image__img` (`currentSrc \|\| src`), ignorando `.error-img` (placeholder `no-image.jpg`). En vivo viene de los CDN `d39ru7awumhhs2` / `d1s927u3m6o0kl` / `d9kz1bfy19fz0.cloudfront.net` |
| Título | `h3.tittle-product` (así, con doble t) |
| Categoría | primer `div` con texto dentro de `.category-stock` (ej. "Hogar") |
| Proveedor | `.provider-name` (solo se muestra en el panel) |
| Precio proveedor, sugerido y stock | **no están en el DOM**: Dropi los dibuja en `<canvas>` (`.price-provider canvas`, `.price-suggested canvas`, `.stock-container canvas`) |

**Decisión sobre los precios en canvas:** Dropi los dibuja como imagen a propósito para que no se copien.
No se leen de ninguna forma (ni pixeles, ni OCR, ni `toDataURL`): sería saltarse una protección deliberada.
En `/admin/dropi/traer` el dueño escribe el **costo del proveedor** que ve en pantalla (y, si quiere, el sugerido
y el stock). Con costo, el precio de venta se calcula con el margen; sin costo puede escribir el precio de venta
directo (`price` en el body). Si no pone ninguno, el producto entra como borrador **sin precio** (precio 0, sin
ofertas) y el resultado lo avisa; no se inventa un precio.

El clipper toma solo las tarjetas que están en el DOM en ese momento: Dropi carga más al bajar, así que hay que
bajar antes de tocar el favorito. Se envían hasta 60 por vez.

### Detalle y otras páginas: heurística genérica

Todavía no tenemos el HTML real de la ficha de producto. Mientras tanto:

| Dato | Cómo se detecta |
|---|---|
| Tipo de página | Detalle si la URL tiene un id de 3+ dígitos (`/product-details/12345`) |
| ID | último número de 3+ dígitos de la URL; en tarjetas sin `data-cy`, el del `href` o un texto "ID: 12345" / "#12345" |
| Imágenes | `img` con `cloudfront.net`, `dropi`, `/storage` o `amazonaws` en el src, de 80 px o más, sin logos ni íconos, sin repetir; se excluyen las de productos relacionados |
| Precios | solo si están como **texto**: `$ 12,50`, `$12.50`, `12.50 USD`; la etiqueta anterior decide ("sugerido" → sugerido; "proveedor"/"costo"/"precio" → costo; "saldo"/"cartera"/"envío" se ignoran) |
| Título | `h1`, o clase con `name`/`title`/`nombre`, o el texto más grande |
| Stock | `stock ... 20` o "20 unidades disponibles" (solo texto) |
| Descripción | bloque con más texto cuyo encabezado o clase menciona "descrip"; el backend lo sanea |

Lo que no se detecte se corrige a mano en el panel (título, ID, costo, sugerido, stock). Para afinar la ficha:
guardar su HTML real ("Guardar página como…") y ajustar `dropiClipper.ts` igual que con el catálogo.

Nunca se manda nada de la sesión de Dropi (cookies, localStorage, tokens): solo los campos del producto.

Al actualizar un producto ya enlazado, el clip refresca costo, sugerido, stock e imágenes (si no tenía), igual
que la sincronización por API: no pisa precio, textos, ofertas ni publicado.

## Pedidos a mano (mientras la API esté bloqueada)

Los pedidos no llegan solos a Dropi. En el panel:

1. **Un pedido:** en el detalle, tarjeta Dropi → **Copiar datos para Dropi**. Pega el bloque como guía mientras
   llenas el pedido en app.dropi.ec (cliente, dirección, productos con su ID de Dropi y variación, y valor a
   recaudar si es contra entrega). Luego **Ya lo creé en Dropi** con el ID del pedido de Dropi (y la guía si ya la tienes).
2. **Varios pedidos:** en Pedidos → **Exportar para Dropi (Excel)**. Descarga un CSV (abre directo en Excel) con
   una fila por producto y todos los datos. Por defecto trae los `confirmed` que aún no tienen ID de Dropi;
   respeta los filtros de la lista o los pedidos marcados.
   Dropi tiene **carga masiva** en **Mis pedidos → Carga masiva**: ahí se descarga **su propia plantilla**.
   Las columnas de esa plantilla cambian según la cuenta, así que el CSV no intenta imitarla: trae todos los
   datos con nombres claros (Nombre, Apellido, Celular, Cédula, Provincia, Ciudad, Dirección, Referencia,
   ID producto Dropi, ID variación Dropi, Cantidad, Cobrar al entregar, Valor a recaudar...) para copiar columna
   por columna a la plantilla de Dropi y subirla.
3. Después de subirlos, marca cada pedido con **Ya lo creé en Dropi** y, cuando haya guía, actualízala en
   **Envío** (enviado, entregado, devuelto). El cliente lo ve en `/rastrear`.

Rutas: `GET /api/admin/orders/export`, `POST /api/admin/orders/:id/dropi-manual`, `PUT /api/admin/orders/:id/shipping`
(ver `docs/API.md`).

## Mantenerse al día

- Importar: `POST /api/admin/dropi/import` con el id o el link del producto. Guarda todo en Mongo como borrador.
- Un producto: `POST /api/admin/products/:id/sync-dropi` (botón "Sincronizar con Dropi" en el editor).
- Todos: cron `GET /api/cron/dropi-products` cada 6 horas. Ambos refrescan stock, costo y sugerido, y agregan
  las variaciones nuevas que haya publicado el proveedor sin pisar textos, precios ni imágenes editados.

## Endpoints usados

| Uso | Método y ruta |
|---|---|
| Buscar productos | `POST /products/index` `{ pageSize, startData, keywords, active, integration, ... }` |
| Detalle de producto | `GET /products/v2/{id}` |
| Provincias | `GET /department` |
| Ciudades | `POST /trajectory/bycity` `{ department_id, rate_type }` |
| Crear orden | `POST /orders/myorders` |
| Estado de orden | `GET /orders/myorders/{id}` |
| Cancelar (no documentado) | `PUT /orders/myorders/{id}` `{ status: "CANCELADO" }` |

Crear orden: `rate_type` es `"CON RECAUDO"` para contra entrega (Dropi cobra `total_order` al cliente) y
`"SIN RECAUDO"` para tarjeta y transferencia, que ya se cobraron. `variation_id` es obligatorio en productos `VARIABLE`.

No hay webhooks documentados: el estado de los pedidos se sincroniza por cron (`/api/cron/dropi-orders`).

## Por validar con acceso habilitado

- Si las provincias y ciudades de Ecuador se envían por nombre o por id.
- Si `total_order` acepta decimales en dólares.
- El endpoint de cancelación.
