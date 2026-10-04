import { normalize } from "./intents";

/**
 * Catálogo del bot: productos publicados con stock y búsqueda por palabras.
 * Sin Mongo aquí: `deps.ts` inyecta `loadCatalog` para que las pruebas usen un
 * catálogo fijo. Todos los montos en centavos, como en el resto de Kova.
 */

export interface BotVariant {
  id: string;
  name: string;
  price: number;
  stock: number;
}

export interface BotOffer {
  quantity: number;
  unitPrice: number;
  label: string;
}

export interface BotProduct {
  id: string;
  slug: string;
  name: string;
  /** Centavos. En VARIABLE, el de la variante más barata con stock. */
  price: number;
  compareAtPrice: number;
  category: string;
  type: "SIMPLE" | "VARIABLE";
  /** Solo variantes con stock. */
  variants: BotVariant[];
  offers: BotOffer[];
  stock: number;
  description: string;
}

/** Centavos a "$24.90". */
export const formatCents = (cents: number) => `$${(Math.round(cents) / 100).toFixed(2)}`;
export const money = formatCents;

const STOPWORDS = new Set(
  "a al algo alguna alguno buen buena busco con cual cuanto cuesta de del el en es esa ese esta este hay la las lo los me mas necesito para por precio que quiero se si su tiene tienen tienes un una uno unos y o porfa favor hola gracias dame quisiera tambien otra otro otras otros agrega agregame agregar anade sumale ponme venden vendes".split(
    " ",
  ),
);

/** Sinónimos frecuentes en Ecuador -> palabra que suele aparecer en el catálogo. */
const SYNONYMS: Record<string, string> = {
  bocina: "parlante",
  bocinas: "parlante",
  parlantes: "parlante",
  altavoz: "parlante",
  speaker: "parlante",
  licuadoras: "licuadora",
  cargadores: "cargador",
  audifonos: "audifono",
  auriculares: "audifono",
  celular: "celular",
  telefono: "celular",
  lampara: "lampara",
  lamparas: "lampara",
  reloj: "reloj",
  relojes: "reloj",
  smartwatch: "reloj",
};

export function tokens(text: string) {
  return (
    normalize(text)
      .split(" ")
      .map((word) => SYNONYMS[word] || word)
      // Plural simple: "licuadoras" encuentra "licuadora".
      .map((word) => (word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word))
      .filter((word) => word.length > 1 && !STOPWORDS.has(word))
  );
}

function score(product: BotProduct, queryTokens: string[]) {
  const name = normalize(product.name);
  const category = normalize(product.category);
  const rest = normalize(`${product.description} ${product.variants.map((v) => v.name).join(" ")}`);
  let total = 0;
  let matched = 0;
  for (const token of queryTokens) {
    const pattern = new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    if (pattern.test(name)) {
      total += 3;
      matched += 1;
    } else if (pattern.test(category)) {
      total += 2;
      matched += 1;
    } else if (pattern.test(rest)) {
      total += 1;
      matched += 1;
    }
  }
  return { total, matched };
}

/** Productos que mejor coinciden con lo que escribió el cliente. */
export function searchProducts(catalog: BotProduct[], query: string, limit = 5) {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return [];
  return (
    catalog
      .map((product) => ({ product, ...score(product, queryTokens) }))
      .filter((entry) => entry.matched > 0)
      // Con dos palabras o menos deben aparecer todas; con más se tolera que falte una.
      .filter(
        (entry) =>
          entry.matched >= Math.max(1, queryTokens.length - (queryTokens.length > 2 ? 1 : 0)),
      )
      .sort((a, b) => b.total - a.total || a.product.price - b.product.price)
      .slice(0, limit)
      .map((entry) => entry.product)
  );
}

export function productLine(product: BotProduct, index?: number) {
  const prefix = index != null ? `*${index}.* ` : "• ";
  const from =
    product.type === "VARIABLE" && new Set(product.variants.map((v) => v.price)).size > 1;
  const compare =
    product.compareAtPrice > product.price ? ` ~${formatCents(product.compareAtPrice)}~` : "";
  return `${prefix}${product.name} — ${from ? "desde " : ""}*${formatCents(product.price)}*${compare}`;
}

/** Resumen del catálogo por categoría, para "qué tienen" o "catálogo". */
export function catalogOverview(catalog: BotProduct[], storeUrl: string) {
  if (!catalog.length) {
    return `Ahora mismo estoy renovando el catálogo 🙈 Échale un ojo a ${storeUrl}/tienda o escríbeme *asesor* y te ayuda una persona del equipo.`;
  }
  const byCategory = new Map<string, BotProduct[]>();
  for (const product of catalog) {
    const key = product.category || "Otros";
    byCategory.set(key, [...(byCategory.get(key) || []), product]);
  }
  const lines = [...byCategory.entries()].slice(0, 12).map(([category, products]) => {
    const from = Math.min(...products.map((product) => product.price));
    return `• *${category}*: ${products.length} ${products.length === 1 ? "producto" : "productos"} desde ${formatCents(from)}`;
  });
  return [
    "Esto es lo que tenemos en Kova 🛍️",
    "",
    ...lines,
    "",
    `Dime qué buscas (ej. "licuadora", "parlante bluetooth") y te muestro opciones. También puedes ver todo en ${storeUrl}/tienda`,
  ].join("\n");
}
