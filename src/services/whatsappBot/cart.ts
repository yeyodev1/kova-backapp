import { BotProduct, formatCents, productLine } from "./catalog";
import { askNext } from "./checkout";
import { extractChoice, extractQuantity, normalize } from "./intents";
import { reply } from "./reply";
import { cartText } from "./texts";
import type { BotDeps, BotState, TurnResult } from "./types";

/**
 * ELEGIR PRODUCTO: opciones numeradas → variante (si es VARIABLE) → cantidad
 * con las ofertas del producto → carrito. Los precios siempre salen del quote
 * del servidor (checkout.service), nunca de lo que se mostró antes.
 */

export function showOptions(
  state: BotState,
  products: BotProduct[],
  decision: string,
  intro?: string,
): TurnResult {
  state.options = products.map((product) => ({ productId: product.id, title: product.name }));
  state.stage = "choosing";
  const list = products.map((product, index) => productLine(product, index + 1)).join("\n");
  const ask =
    products.length === 1
      ? "Te lo agrego al pedido? 🛒 Respóndeme *sí* o *1*"
      : "Cuál te agrego? 🛒 Respóndeme con el número";
  return reply(
    state,
    `${intro || "Mira lo que tengo para ti 👇✨"}\n\n${list}\n\n${ask}`,
    decision,
  );
}

const stockOf = (product: BotProduct, variantId: string | null) =>
  variantId ? product.variants.find((v) => v.id === variantId)?.stock || 0 : product.stock;

/** Recalcula el carrito con el quote real. Devuelve el error del servidor si algo ya no está disponible. */
export async function refreshCart(state: BotState, deps: BotDeps): Promise<string | null> {
  if (!state.cart.length) return null;
  const outcome = await deps.quote(
    state.cart.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
    })),
    "card",
  );
  if (!outcome.ok) return outcome.message;
  state.cart = outcome.quote.items.map((item) => ({ ...item }));
  return null;
}

/** Empieza a configurar un producto elegido. `quantity` si el cliente ya dijo cuántos. */
export async function chooseProduct(
  state: BotState,
  product: BotProduct,
  deps: BotDeps,
  decision: string,
  quantity: number | null = null,
  message = "",
): Promise<TurnResult> {
  state.options = [];
  // "el parlante gris": la variante viene en el mismo mensaje.
  const value = ` ${normalize(message)} `;
  const variant = product.variants.find((item) => value.includes(` ${normalize(item.name)} `));
  state.pending = { productId: product.id, variantId: variant?.id || null, quantity };
  return continuePending(state, deps, decision);
}

async function quantityOffers(product: BotProduct, variantId: string | null, deps: BotDeps) {
  const stock = stockOf(product, variantId);
  const quantities = [...new Set(product.offers.map((offer) => offer.quantity))]
    .filter((quantity) => quantity >= 1 && quantity <= Math.min(stock, 10))
    .sort((a, b) => a - b)
    .slice(0, 4);
  if (quantities.length < 2) return [];
  const priced: Array<{ quantity: number; total: number; label: string }> = [];
  for (const quantity of quantities) {
    const outcome = await deps.quote([{ productId: product.id, variantId, quantity }], "card");
    if (!outcome.ok) continue;
    const label = product.offers.find((offer) => offer.quantity === quantity)?.label || "";
    priced.push({ quantity, total: outcome.quote.subtotal, label });
  }
  return priced.length >= 2 ? priced : [];
}

export async function continuePending(
  state: BotState,
  deps: BotDeps,
  decision: string,
  prefix = "",
): Promise<TurnResult> {
  const pending = state.pending!;
  const catalog = await deps.loadCatalog();
  const product = catalog.find((item) => item.id === pending.productId);
  const join = (text: string) => (prefix ? `${prefix}\n\n${text}` : text);
  if (!product) {
    state.pending = null;
    state.stage = "idle";
    return reply(
      state,
      "Uy, ese producto se acaba de agotar 😕 Dime qué otra cosa buscas y te muestro opciones.",
      `${decision}:agotado`,
    );
  }

  if (product.type === "VARIABLE" && product.variants.length && !pending.variantId) {
    if (product.variants.length === 1) pending.variantId = product.variants[0].id;
    else {
      state.stage = "variant";
      const list = product.variants
        .map(
          (variant, index) => `*${index + 1}.* ${variant.name} — *${formatCents(variant.price)}*`,
        )
        .join("\n");
      return reply(
        state,
        join(
          `*${product.name}* viene en estas opciones 👇\n${list}\n\nCuál prefieres? Respóndeme con el número 😊`,
        ),
        `${decision}:variante`,
      );
    }
  }

  if (!pending.quantity) {
    const offers = await quantityOffers(product, pending.variantId, deps);
    if (offers.length) {
      state.stage = "quantity";
      state.quantityOptions = offers.map((offer) => offer.quantity);
      const unit = offers.find((offer) => offer.quantity === 1)?.total || 0;
      const list = offers
        .map((offer, index) => {
          const saving = unit ? unit * offer.quantity - offer.total : 0;
          const extra = [saving > 0 ? `ahorras ${formatCents(saving)}` : "", offer.label]
            .filter(Boolean)
            .join(" · ");
          return `*${index + 1}.* ${offer.quantity} ${offer.quantity === 1 ? "unidad" : "unidades"} — *${formatCents(offer.total)}*${extra ? ` (${extra})` : ""}`;
        })
        .join("\n");
      return reply(
        state,
        join(
          `Cuántas quieres? 🔥 Mientras más llevas, más ahorras:\n${list}\n\nRespóndeme con el número 😊`,
        ),
        `${decision}:cantidad`,
      );
    }
    pending.quantity = 1;
  }

  const quantity = Math.min(pending.quantity, Math.max(stockOf(product, pending.variantId), 1), 10);
  const previous = JSON.parse(JSON.stringify(state.cart));
  const existing = state.cart.find(
    (line) => line.productId === product.id && line.variantId === pending.variantId,
  );
  if (existing) existing.quantity = quantity;
  else {
    state.cart.push({
      productId: product.id,
      variantId: pending.variantId,
      title: product.name,
      variantName: "",
      quantity,
      unitPrice: 0,
      total: 0,
    });
  }
  state.pending = null;
  state.quantityOptions = [];
  const error = await refreshCart(state, deps);
  if (error) {
    state.cart = previous;
    state.stage = state.cart.length ? state.stage : "idle";
    return reply(
      state,
      `Uy, ${error.charAt(0).toLowerCase()}${error.slice(1)} 😕 Elige otra opción o dime qué otra cosa buscas.`,
      `${decision}:sin_stock`,
    );
  }
  deps.saveLead(state);
  const line = state.cart.find(
    (item) => item.productId === product.id && item.variantId === pending.variantId,
  )!;
  const added = `Agregué *${line.quantity} × ${line.title}${line.variantName ? ` (${line.variantName})` : ""}* ✅`;
  const others =
    state.cart.length > 1
      ? `\n\nTu carrito:\n${cartText(state.cart)}`
      : ` — ${formatCents(line.total)}`;
  return askNext(state, deps, decision, `${added}${others}`);
}

/** Respuesta en los pasos "variant" y "quantity". null si el mensaje no es para ese paso. */
export async function handlePendingStep(
  state: BotState,
  message: string,
  deps: BotDeps,
): Promise<TurnResult | null> {
  const pending = state.pending;
  if (!pending) return null;
  const catalog = await deps.loadCatalog();
  const product = catalog.find((item) => item.id === pending.productId);
  if (!product) return continuePending(state, deps, "R5");

  if (state.stage === "variant") {
    const value = normalize(message);
    const choice = extractChoice(message, product.variants.length);
    const variant = choice
      ? product.variants[choice - 1]
      : product.variants.find((item) => value.includes(normalize(item.name)));
    if (!variant) return null;
    pending.variantId = variant.id;
    // "el negro, 2 unidades": la cantidad viene en el mismo mensaje.
    if (!pending.quantity && /unidad|\bx\s?\d/.test(value))
      pending.quantity = extractQuantity(message);
    return continuePending(state, deps, `R5:variante_${product.variants.indexOf(variant) + 1}`);
  }

  if (state.stage === "quantity") {
    const stock = stockOf(product, pending.variantId);
    const explicit = /unidad|\bx\s?\d/.test(normalize(message)) ? extractQuantity(message) : null;
    const choice = extractChoice(message, state.quantityOptions.length);
    let quantity = explicit || (choice ? state.quantityOptions[choice - 1] : null);
    // "5" cuando solo se ofrecieron 3 opciones: es la cantidad.
    if (!quantity) {
      const raw = extractQuantity(message);
      if (raw && raw > state.quantityOptions.length) quantity = raw;
    }
    if (!quantity) return null;
    if (quantity > Math.min(stock, 10)) {
      return reply(
        state,
        `De esa opción me quedan ${Math.min(stock, 10)} unidades 🙏 Cuántas te separo?`,
        "R5:cantidad_sin_stock",
      );
    }
    pending.quantity = quantity;
    return continuePending(state, deps, `R5:cantidad_${quantity}`);
  }
  return null;
}
