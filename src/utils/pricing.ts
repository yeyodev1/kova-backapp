/**
 * Redondea un precio en centavos al .90 más cercano (24.90, 19.90...).
 * Precios terminados en .90 convierten mejor que los redondos en tiendas de impulso.
 */
export function roundTo90(cents: number): number {
  const rounded = Math.round((cents - 90) / 100) * 100 + 90;
  return Math.max(rounded, 90);
}

/** Precio de venta: el sugerido de Dropi si deja margen; si no, costo × (1 + margen). */
export function salePrice(
  costCents: number,
  suggestedCents: number,
  markupPercent: number,
): number {
  let price = suggestedCents > costCents ? suggestedCents : costCents * (1 + markupPercent / 100);
  price = roundTo90(Math.round(price));
  // El redondeo hacia abajo nunca debe dejar el precio por debajo del costo.
  while (costCents > 0 && price <= costCents) price += 100;
  return price;
}

/** Precio tachado: +40% para mostrar el ahorro. */
export function compareAtFor(priceCents: number): number {
  return roundTo90(Math.round(priceCents * 1.4));
}

/** Ofertas por cantidad por defecto: 1u normal, 2u -10%, 3u -15%. */
export function defaultOffers(priceCents: number) {
  return [
    { quantity: 1, unitPrice: priceCents, label: "", isDefault: true },
    {
      quantity: 2,
      unitPrice: Math.round(priceCents * 0.9),
      label: "Más vendido",
      isDefault: false,
    },
    {
      quantity: 3,
      unitPrice: Math.round(priceCents * 0.85),
      label: "Mejor precio",
      isDefault: false,
    },
  ];
}
