/**
 * Pruebas del bot de WhatsApp sin red ni Mongo: router real, catálogo y
 * ubicaciones fijas, extractor por reglas y dependencias falsas. Gemini se
 * reemplaza por funciones locales donde hace falta.
 *
 *   pnpm test:bot            (VERBOSE=1 para ver las conversaciones)
 */
import assert from "assert/strict";
import * as gemini from "../services/gemini.service";
import { decideFromSale } from "../services/payphone.service";
import { BotProduct } from "../services/whatsappBot/catalog";
import { decideRoute, DECISIONS } from "../services/whatsappBot/decide";
import {
  aiExtract,
  answerPricesAreReal,
  heuristicExtract,
} from "../services/whatsappBot/extractor";
import {
  builderBotHistory,
  latestUserMessage,
  readMediaUrl,
  toSessionPhone,
} from "../services/whatsappBot/input";
import {
  detectPaymentMethod,
  extractChoice,
  extractQuantity,
  isValidIdNumber,
  orderNumberIn,
  wantsOptOut,
} from "../services/whatsappBot/intents";
import { LocationIndex, matchLocation } from "../services/whatsappBot/location";
import { handleTurn } from "../services/whatsappBot/router";
import {
  BankOption,
  BotDeps,
  BotState,
  CardCheck,
  MediaOutcome,
  OrderSummary,
  QuoteItem,
  TurnResult,
  createInitialState,
} from "../services/whatsappBot/types";
import { keepsData, naturalize } from "../services/whatsappBot/voice";

const CATALOG: BotProduct[] = [
  {
    id: "p1",
    slug: "licuadora-oster",
    name: "Licuadora Oster 600W vaso de vidrio",
    price: 3490,
    compareAtPrice: 4890,
    category: "Cocina",
    type: "SIMPLE",
    variants: [],
    offers: [
      { quantity: 1, unitPrice: 3490, label: "" },
      { quantity: 2, unitPrice: 3141, label: "Más vendido" },
      { quantity: 3, unitPrice: 2967, label: "Mejor precio" },
    ],
    stock: 20,
    description: "Licuadora potente de 600W con vaso de vidrio",
  },
  {
    id: "p2",
    slug: "parlante-bluetooth",
    name: "Parlante Bluetooth portátil 20W",
    price: 2490,
    compareAtPrice: 3490,
    category: "Tecnología",
    type: "VARIABLE",
    variants: [
      { id: "v-negro", name: "Negro", price: 2490, stock: 5 },
      { id: "v-azul", name: "Azul", price: 2690, stock: 3 },
    ],
    offers: [
      { quantity: 1, unitPrice: 2490, label: "" },
      { quantity: 2, unitPrice: 2241, label: "Más vendido" },
    ],
    stock: 8,
    description: "Parlante resistente al agua con 12 horas de batería",
  },
  {
    id: "p3",
    slug: "cargador-usb-c",
    name: "Cargador rápido USB-C 20W",
    price: 1290,
    compareAtPrice: 0,
    category: "Tecnología",
    type: "SIMPLE",
    variants: [],
    offers: [],
    stock: 50,
    description: "Carga rápida para celulares",
  },
];

const LOCATIONS: LocationIndex = {
  provinces: [
    { id: 1, name: "GUAYAS" },
    { id: 2, name: "PICHINCHA" },
    { id: 3, name: "LOJA" },
    { id: 5, name: "EL ORO" },
  ],
  cities: [
    { id: 10, name: "GUAYAQUIL", provinceId: 1 },
    { id: 11, name: "DAULE", provinceId: 1 },
    { id: 20, name: "QUITO", provinceId: 2 },
    { id: 21, name: "SANTA ROSA", provinceId: 2 },
    { id: 30, name: "LOJA", provinceId: 3 },
    { id: 50, name: "MACHALA", provinceId: 5 },
    { id: 51, name: "SANTA ROSA", provinceId: 5 },
  ],
};

const SURCHARGES = { card: 0, transfer: 150, cod: 300 };
const BANK_A: BankOption = {
  bank: "Banco Pichincha",
  type: "ahorros",
  number: "2201234567",
  holder: "Kova S.A.S.",
  idNumber: "0999999999001",
};
const BANK_B: BankOption = {
  bank: "Banco Guayaquil",
  type: "corriente",
  number: "0019876543",
  holder: "Kova S.A.S.",
  idNumber: "0999999999001",
};

/** Misma regla de ofertas que checkout.service (precio por cantidad). */
function fakeQuote(items: QuoteItem[], method: "card" | "transfer" | "cod") {
  const lines = items.map((item) => {
    const product = CATALOG.find((p) => p.id === item.productId);
    if (!product) throw new Error("Uno de los productos ya no está disponible");
    const variant = item.variantId ? product.variants.find((v) => v.id === item.variantId) : null;
    if (product.type === "VARIABLE" && !variant)
      throw new Error(`Elige una opción de ${product.name}`);
    const stock = variant ? variant.stock : product.stock;
    if (item.quantity > stock) throw new Error(`Solo quedan ${stock} unidades de ${product.name}`);
    const base = variant ? variant.price : product.price;
    const largest = product.offers.reduce(
      (a, b) => (b.quantity > (a?.quantity || 0) ? b : a),
      product.offers[0],
    );
    const offer =
      product.offers.find((o) => o.quantity === item.quantity) ||
      (largest && item.quantity > largest.quantity ? largest : null);
    const unitPrice = offer
      ? base === product.price
        ? offer.unitPrice
        : Math.round((base * offer.unitPrice) / product.price)
      : base;
    return {
      productId: product.id,
      variantId: variant?.id || null,
      title: product.name,
      variantName: variant?.name || "",
      quantity: item.quantity,
      unitPrice,
      total: unitPrice * item.quantity,
    };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.total, 0);
  return {
    subtotal,
    shippingFee: 0,
    surcharge: SURCHARGES[method],
    total: subtotal + SURCHARGES[method],
    surcharges: SURCHARGES,
    items: lines,
  };
}

interface Fake {
  deps: BotDeps;
  created: BotState[];
  media: Array<{ orderId: string; url: string }>;
  leads: number;
}

function fakeDeps(
  options: {
    banks?: BankOption[];
    card?: boolean;
    media?: MediaOutcome;
    orders?: OrderSummary[];
    cardCheck?: CardCheck | null;
    whatsappPhone?: string;
  } = {},
): Fake {
  const fake: Fake = { created: [], media: [], leads: 0, deps: null as any };
  fake.deps = {
    loadCatalog: async () => CATALOG,
    loadLocations: async () => LOCATIONS,
    extract: heuristicExtract,
    quote: async (items, method) => {
      try {
        return { ok: true, quote: fakeQuote(items, method) };
      } catch (error: any) {
        return { ok: false, message: error.message };
      }
    },
    createOrder: async (state) => {
      fake.created.push(JSON.parse(JSON.stringify(state)));
      const quote = fakeQuote(state.cart, state.paymentMethod!);
      const n = 1000 + fake.created.length;
      return {
        ok: true,
        order: {
          orderId: `o${fake.created.length}`,
          orderNumber: `KV-${n}`,
          total: quote.total,
          paymentLink:
            state.paymentMethod === "card"
              ? "https://kovashopper.com/pagar/tok123456789012345678901"
              : "",
        },
      };
    },
    receiveMedia: async (orderId, url) => {
      fake.media.push({ orderId, url });
      return (
        options.media || {
          status: "stored",
          orderNumber: "KV-1001",
          total: 3640,
          detectedAmount: 3640,
          isReceipt: true,
        }
      );
    },
    checkCardPayment: async () => (options.cardCheck === undefined ? null : options.cardCheck),
    findOrders: async (number) =>
      (options.orders || []).filter((order) => !number || order.number === number),
    saveLead: () => {
      fake.leads += 1;
    },
    banks: options.banks || [BANK_A],
    cardEnabled: options.card !== false,
    supportPhone: "",
    storeUrl: "https://kovashopper.com",
    whatsappPhone: options.whatsappPhone ?? "0990000001",
  };
  return fake;
}

async function conversation(
  fake: Fake,
  messages: Array<string | { media: string }>,
  initial = createInitialState(),
) {
  let state = initial;
  const results: TurnResult[] = [];
  for (const entry of messages) {
    const input =
      typeof entry === "string" ? { message: entry } : { message: "", mediaUrl: entry.media };
    const result = await handleTurn(state, input, fake.deps);
    if (process.env.VERBOSE)
      console.log(
        `  👤 ${typeof entry === "string" ? entry : "[archivo]"}\n  🤖 ${result.reply.replace(/\n/g, "\n     ")}  [${result.decision} · ${result.step} · ${result.route}]\n`,
      );
    results.push(result);
    state = result.state;
  }
  return results;
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(
      `❌ ${name}\n   ${error instanceof Error ? error.stack?.split("\n").slice(0, 3).join("\n   ") : error}`,
    );
  }
}

const DATA = [
  "Ana Pérez",
  "Guayaquil",
  "Av. 9 de Octubre 123 y Boyacá, ref: frente al parque",
  "no",
];

async function main() {
  await test("compra con tarjeta: oferta de 2 unidades, datos, resumen y link de pago", async () => {
    const fake = fakeDeps({ banks: [BANK_A] });
    const results = await conversation(fake, [
      "hola",
      "busco una licuadora",
      "1",
      "2",
      ...DATA,
      "1",
      "sí",
    ]);
    const [greet, search, offers, added, name, city, address, extras, payment, confirmed] = results;
    assert.match(greet.reply, /bot de \*Kova\*/);
    assert.equal(search.decision, "R8:busqueda");
    assert.equal(offers.step, "quantity");
    assert.match(offers.reply, /2 unidades — \*\$62\.82\* \(ahorras \$6\.98 · Más vendido\)/);
    assert.equal(added.state.cart[0].quantity, 2);
    assert.equal(added.state.cart[0].total, 6282);
    assert.equal(added.step, "name");
    assert.equal(name.step, "city", "el teléfono sale de WhatsApp");
    assert.equal(name.state.lastName, "Pérez");
    assert.equal(city.state.province, "Guayas");
    assert.equal(city.state.cityId, 10);
    assert.equal(address.state.reference, "frente al parque");
    assert.equal(address.step, "extras", "con referencia no la vuelve a pedir");
    assert.equal(extras.step, "payment");
    assert.match(extras.reply, /Tarjeta — \*\$62\.82\* \(el mejor precio\)/);
    assert.match(extras.reply, /Transferencia — \*\$64\.32\* \(\+\$1\.50\)/);
    assert.match(extras.reply, /Contra entrega — \*\$65\.82\* \(\+\$3\.00, pagas al recibir\)/);
    assert.equal(payment.route, "confirmOrder");
    assert.match(payment.reply, /\*Total: \$62\.82\*/);
    assert.match(payment.reply, /Guayaquil, Guayas/);
    assert.equal(confirmed.route, "checkoutCard");
    assert.equal(confirmed.intent, "orden_creada");
    assert.match(confirmed.reply, /kovashopper\.com\/pagar\/tok/);
    assert.equal(fake.created[0].phone, "0990000001");
    assert.ok(fake.leads >= 1, "guarda el carrito abandonado");
  });

  await test("transferencia con dos bancos: pregunta el banco, manda solo esa cuenta y recibe el comprobante", async () => {
    const fake = fakeDeps({ banks: [BANK_A, BANK_B] });
    const results = await conversation(fake, [
      "cargador",
      "1",
      ...DATA,
      "transferencia",
      "2",
      "si",
      { media: "https://files.builderbot.app/tmp/comprobante.jpg" },
    ]);
    const bankAsk = results[6];
    const confirm = results[7];
    const created = results[8];
    const receipt = results[9];
    assert.equal(bankAsk.step, "bank");
    assert.doesNotMatch(bankAsk.reply, /2201234567|0019876543/, "no manda números antes de elegir");
    assert.match(confirm.reply, /Banco Guayaquil/);
    assert.match(confirm.reply, /\*Total: \$14\.40\*/);
    assert.equal(created.route, "checkoutTransfer");
    assert.match(created.reply, /0019876543/);
    assert.doesNotMatch(created.reply, /2201234567/);
    assert.match(created.reply, /comprobante/);
    assert.equal(receipt.route, "receiptReceived");
    assert.equal(fake.media[0].orderId, "o1");
  });

  await test("contra entrega: recargo visible y pedido confirmado", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, ["cargador", "1", ...DATA, "contra entrega", "dale"]);
    const summary = results.at(-2)!;
    const created = results.at(-1)!;
    assert.match(summary.reply, /Recargo contra entrega — \$3\.00/);
    assert.match(summary.reply, /\*Total: \$15\.90\*/);
    assert.equal(created.route, "checkoutCod");
    assert.match(created.reply, /pagas \*\$15\.90\* en efectivo|Pagas \*\$15\.90\*/i);
    assert.equal(fake.created[0].paymentMethod, "cod");
  });

  await test("producto VARIABLE: pide la variante y luego la cantidad", async () => {
    const fake = fakeDeps();
    const results = await conversation(fake, ["parlante", "1", "azul", "1"]);
    assert.equal(results[1].step, "variant");
    assert.match(results[1].reply, /Negro — \*\$24\.90\*/);
    assert.match(results[1].reply, /Azul — \*\$26\.90\*/);
    assert.equal(results[2].step, "quantity");
    assert.equal(results[3].state.cart[0].variantId, "v-azul");
    assert.equal(results[3].state.cart[0].total, 2690);
  });

  await test("'el azul' elige la variante del mismo mensaje", async () => {
    const results = await conversation(fakeDeps(), ["parlante", "el azul"]);
    assert.equal(results[1].step, "quantity");
    assert.equal(results[1].state.pending?.variantId, "v-azul");
  });

  await test("'quiero 2 licuadoras' agrega directo con el precio de oferta", async () => {
    const fake = fakeDeps();
    const [result] = await conversation(fake, ["quiero 2 licuadoras"]);
    assert.equal(result.state.cart[0].quantity, 2);
    assert.equal(result.state.cart[0].total, 6282);
    assert.equal(result.step, "name");
  });

  await test("consulta KV-: estado legible, guía y solo pedidos del teléfono", async () => {
    const orders: OrderSummary[] = [
      {
        id: "a",
        number: "KV-1005",
        status: "shipped",
        paymentMethod: "cod",
        paymentStatus: "cod",
        total: 3790,
        guide: "SER123",
        carrier: "Servientrega",
        paymentLink: "",
      },
    ];
    const fake = fakeDeps({ orders });
    const [byNumber, mine, other] = await conversation(fake, [
      "como va el KV-1005",
      "mi pedido",
      "KV-1999",
    ]);
    assert.equal(byNumber.route, "searchOrder");
    assert.match(byNumber.reply, /KV-1005.*enviado.*Servientrega \*SER123\*/);
    assert.match(mine.reply, /KV-1005/);
    assert.match(other.reply, /No encuentro el pedido \*KV-1999\*/);
  });

  await test("asesor, reclamo y garantía van a human", async () => {
    for (const text of [
      "quiero hablar con un asesor",
      "tengo un reclamo",
      "garantía de mi licuadora",
    ]) {
      const [result] = await conversation(fakeDeps(), [text]);
      assert.equal(result.route, "human", text);
      assert.equal(decideRoute(null, { message: text }).route, "human");
    }
  });

  await test("opt-out: 'no me escribas' se respeta y se confirma", async () => {
    const [result] = await conversation(fakeDeps(), ["no me escribas más"]);
    assert.equal(result.state.optOut, true);
    assert.equal(result.decision, "R0:no_escribir");
    assert.ok(wantsOptOut("stop"));
  });

  await test("fuera de tema (política de Meta): redirige a Kova", async () => {
    const [result] = await conversation(fakeDeps(), ["dame una receta de ceviche"]);
    assert.equal(result.decision, "R8:fuera_de_tema");
    assert.match(result.reply, /Kova/);
  });

  await test("transparencia: '¿eres un bot?' responde que sí y ofrece asesor", async () => {
    const [result] = await conversation(fakeDeps(), ["¿eres un bot o una persona?"]);
    assert.equal(result.decision, "R2:soy_un_bot");
    assert.match(result.reply, /Sí, soy un bot 🤖/);
    assert.match(result.reply, /asesor/);
    assert.equal(decideRoute(null, { message: "hablo con una persona?" }).route, "conversation");
  });

  await test("estilo: ningún mensaje lleva ¿ ni ¡", async () => {
    const results = await conversation(fakeDeps(), [
      "hola",
      "¿tienen licuadoras?",
      "1",
      "1",
      "Ana Pérez",
      "¡Guayaquil!",
    ]);
    for (const result of results) assert.doesNotMatch(result.reply, /[¿¡]/);
  });

  await test("'pagado' con tarjeta: verifica con Payphone y responde según el estado", async () => {
    const base = {
      orderNumber: "KV-1001",
      total: 3490,
      paymentLink: "https://kovashopper.com/pagar/tok",
    };
    const state = {
      ...createInitialState(),
      stage: "ordered" as const,
      paymentMethod: "card" as const,
      orderId: "o1",
      orderNumber: "KV-1001",
    };
    const [paid] = await conversation(
      fakeDeps({ cardCheck: { ...base, outcome: "paid_now" } }),
      ["ya pagué"],
      state,
    );
    assert.equal(paid.decision, "R3:pago_confirmado");
    const [pending] = await conversation(
      fakeDeps({ cardCheck: { ...base, outcome: "pending" } }),
      ["pagado"],
      state,
    );
    assert.match(pending.reply, /pagar\/tok/);
    const [review] = await conversation(
      fakeDeps({ cardCheck: { ...base, outcome: "review" } }),
      ["pagado"],
      state,
    );
    assert.equal(review.route, "human");
  });

  await test("'ya transferí' con pedido por transferencia pide la foto", async () => {
    const state = {
      ...createInitialState(),
      stage: "ordered" as const,
      paymentMethod: "transfer" as const,
      orderId: "o1",
      orderNumber: "KV-1001",
    };
    const [result] = await conversation(fakeDeps(), ["ya transferí"], state);
    assert.equal(result.route, "awaitingReceipt");
  });

  await test("foto que no es comprobante: busca productos parecidos", async () => {
    const fake = fakeDeps({
      media: {
        status: "image",
        kind: "product",
        description: "una licuadora roja",
        searchQuery: "licuadora",
        productIds: [],
        exactMatch: false,
      },
    });
    const [result] = await conversation(fake, [
      { media: "https://files.builderbot.app/tmp/foto.jpg" },
    ]);
    assert.equal(result.decision, "R1:foto_producto_parecido");
    assert.match(result.reply, /Licuadora Oster/);
  });

  await test("ciudad: Guayaquil→Guayas, ambigua pregunta, provincia sola pide ciudad", async () => {
    assert.deepEqual(matchLocation("Guayaquil", LOCATIONS), {
      status: "ok",
      place: { provinceId: 1, province: "Guayas", cityId: 10, city: "Guayaquil" },
    });
    assert.equal(matchLocation("santa rosa", LOCATIONS).status, "ambiguous");
    assert.equal(matchLocation("Santa Rosa, El Oro", LOCATIONS).status, "ok");
    assert.equal(matchLocation("Pichincha", LOCATIONS).status, "province_only");
    const results = await conversation(fakeDeps(), [
      "cargador",
      "1",
      "Ana Pérez",
      "santa rosa",
      "2",
      "Pichincha",
      "Quito",
    ]);
    assert.equal(results[3].step, "city_choice");
    assert.equal(results[4].state.province, "El Oro");
    assert.equal(results[4].state.cityId, 51);
  });

  await test("WhatsApp oculto (@lid): pide el celular y lo valida", async () => {
    const results = await conversation(fakeDeps({ whatsappPhone: "" }), [
      "cargador",
      "1",
      "Luis Mora",
      "123",
      "0991234567",
    ]);
    assert.equal(results[2].step, "phone");
    assert.equal(results[3].decision, "R6:dato_phone_invalido");
    assert.equal(results[4].state.phone, "0991234567");
  });

  await test("cédula y correo opcionales se guardan", async () => {
    const results = await conversation(fakeDeps(), [
      "cargador",
      "1",
      "Ana Pérez",
      "Quito",
      "Av. Amazonas 100",
      "no",
      "0926687856 ana@correo.com",
    ]);
    const last = results.at(-1)!;
    assert.equal(last.state.idNumber, "0926687856");
    assert.equal(last.state.email, "ana@correo.com");
  });

  await test("'no' en el resumen y luego 'la dirección' vuelve a pedirla", async () => {
    const results = await conversation(fakeDeps({ card: false, banks: [] }), [
      "cargador",
      "1",
      ...DATA,
      "no",
      "la dirección",
      "Calle Nueva 456",
      "no",
    ]);
    const summary = results[5];
    assert.equal(summary.route, "confirmOrder", "con un solo método no pregunta la forma de pago");
    assert.equal(results[7].step, "address");
    assert.equal(results.at(-1)!.route, "confirmOrder");
    assert.match(results.at(-1)!.reply, /Calle Nueva 456/);
  });

  await test("/brain decide sin tocar nada y solo devuelve rutas con flujo", () => {
    const confirmCard = {
      ...createInitialState(),
      stage: "confirm" as const,
      paymentMethod: "card" as const,
    };
    const confirmTransfer = { ...confirmCard, paymentMethod: "transfer" as const };
    const confirmCod = { ...confirmCard, paymentMethod: "cod" as const };
    assert.equal(decideRoute(confirmCard, { message: "sí" }).route, "checkoutCard");
    assert.equal(decideRoute(confirmTransfer, { message: "si" }).route, "checkoutTransfer");
    assert.equal(decideRoute(confirmCod, { message: "si" }).route, "conversation");
    assert.equal(
      decideRoute(null, { message: "", mediaUrl: "https://x/y.jpg" }).route,
      "checkoutTransfer",
    );
    assert.equal(decideRoute(null, { message: "catálogo" }).route, "catalog");
    assert.equal(decideRoute(null, { message: "hola", silenced: true }).route, "silenced");
    assert.equal(decideRoute(null, { message: "KV-1001" }).route, "conversation");
    for (const message of ["hola", "asesor", "catalogo", "sí", "mi pedido"]) {
      assert.ok(DECISIONS.includes(decideRoute(confirmCard, { message }).route));
    }
  });

  await test("voz con IA: varía el texto pero conserva datos; si cambia un dato usa el borrador", async () => {
    const draft =
      "Listo, tu pedido *KV-1001* ya está registrado 🎉\n\nPaga *$34.90* aquí 👇\nhttps://kovashopper.com/pagar/abc";
    assert.ok(
      keepsData(
        draft,
        "Perfecto, tu pedido *KV-1001* quedó listo 🎉\n\nPaga *$34.90* aquí 👇\nhttps://kovashopper.com/pagar/abc",
      ),
    );
    assert.ok(
      !keepsData(
        draft,
        "Tu pedido *KV-1001* listo. Paga *$30.00*\nhttps://kovashopper.com/pagar/abc",
      ),
    );
    assert.ok(!keepsData("Sí, soy un bot 🤖", "Sí, soy una persona"));
    assert.ok(
      !keepsData(
        "Cómo prefieres pagar? 💳",
        "Tu pedido KV-1234 casi listo! Cómo prefieres pagar? 💳",
      ),
      "no inventa pedidos",
    );
    const original = gemini.geminiJson;
    try {
      (gemini as any).geminiJson = async () => ({
        message: "¡Hecho! tu pedido *KV-1001* va con *$99.00*\nhttps://kovashopper.com/pagar/abc",
      });
      assert.equal(await naturalize(draft, []), draft, "cambió el monto: se manda el borrador");
      (gemini as any).geminiJson = async () => null;
      assert.equal(await naturalize(draft, []), draft, "si la IA falla, el borrador");
      (gemini as any).geminiJson = async () => ({
        message:
          "¡Ya quedó! tu pedido *KV-1001* está registrado 🎉\n\nPaga *$34.90* aquí 👇\nhttps://kovashopper.com/pagar/abc",
      });
      const voiced = await naturalize(draft, []);
      assert.notEqual(voiced, draft);
      assert.doesNotMatch(voiced, /¡/);
    } finally {
      (gemini as any).geminiJson = original;
    }
  });

  await test("extractor con IA: valida refs, cédula y precios inventados", async () => {
    const original = gemini.geminiJson;
    try {
      (gemini as any).geminiJson = async () => ({
        intent: "pregunta",
        items: [{ ref: 99 }, { ref: 0, quantity: 2 }],
        remove: [],
        searchQuery: "",
        suggestions: [1, 42],
        idNumber: "1234567890",
        email: "no-es-correo",
        paymentMethod: "cod",
        answer: "La licuadora cuesta $10.00 😍",
      });
      const extraction = await aiExtract("cuánto cuesta?", {
        stage: "idle",
        lastQuestion: "",
        cart: [],
        history: "",
        catalog: CATALOG,
      });
      assert.deepEqual(extraction.items, [{ productId: "p1", quantity: 2 }]);
      assert.deepEqual(extraction.suggestions, ["p2"]);
      assert.equal(extraction.idNumber, undefined, "cédula inválida");
      assert.equal(extraction.email, undefined);
      assert.equal(extraction.paymentMethod, "cod");
      assert.equal(extraction.answer, undefined, "precio inventado: se descarta la respuesta");
      assert.ok(answerPricesAreReal("Cuesta $34.90 y 2 por $62.82", CATALOG));
    } finally {
      (gemini as any).geminiJson = original;
    }
  });

  await test("Payphone: decisión por la consulta de la venta", () => {
    assert.equal(decideFromSale({ found: false }), "pending");
    assert.equal(decideFromSale({ found: true, statusCode: 3, transactionId: 10 }), "confirm");
    assert.equal(decideFromSale({ found: true, statusCode: 2 }), "rejected");
    assert.equal(decideFromSale({ found: true, statusCode: 1 }), "pending");
  });

  await test("helpers: teléfono, historial, archivo, KV-, cédula y detectores", () => {
    assert.equal(toSessionPhone("593990000001:12@s.whatsapp.net"), "0990000001");
    assert.equal(toSessionPhone("+593 99 000 0001"), "0990000001");
    assert.equal(toSessionPhone("123456@lid"), "lid:123456");
    assert.equal(toSessionPhone("{from}"), "");
    assert.equal(
      latestUserMessage(
        '[{"role":"user","content":"hola"},{"role":"assistant","content":"qué tal"},{"role":"user","content":"licuadora"}]',
      ),
      "licuadora",
    );
    assert.match(
      builderBotHistory([
        { role: "user", content: "hola" },
        { role: "assistant", content: "hey" },
      ]),
      /Cliente: hola\nBot: hey/,
    );
    assert.equal(readMediaUrl({ urlTempFile: "https://x.com/a.jpg" }), "https://x.com/a.jpg");
    assert.equal(readMediaUrl({ urlTempFile: "{urlTempFile}" }), "");
    assert.equal(orderNumberIn("mi pedido kv 1001"), "KV-1001");
    assert.ok(isValidIdNumber("0926687856"));
    assert.ok(!isValidIdNumber("0990000001"), "un celular no es cédula");
    assert.equal(extractChoice("la segunda", 3), 2);
    assert.equal(extractQuantity("2 licuadoras"), 2);
    assert.equal(extractQuantity("parlante 20w"), null);
    assert.equal(extractQuantity("quiero un parlante"), null, "'un' no salta las ofertas");
    assert.equal(extractQuantity("dos licuadoras"), 2);
    assert.equal(detectPaymentMethod("pago al recibir"), "cod");
    assert.equal(detectPaymentMethod("con tarjeta"), "card");
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  if (failed) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0));
