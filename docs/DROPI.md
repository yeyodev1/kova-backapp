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

No se intenta saltar el bloqueo (nada de scraping ni de usar la sesión de la web de Dropi): la única vía es
la lista blanca de la integración.

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
