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
