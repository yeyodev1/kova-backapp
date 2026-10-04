import { env } from "../../config/env";
import { geminiJson } from "../gemini.service";
import { BotProduct, formatCents } from "./catalog";
import {
  BotPaymentMethod,
  detectPaymentMethod,
  extractEmail,
  extractIdNumber,
  isGreeting,
  normalize,
  wantsCatalog,
  wantsHuman,
  wantsTracking,
} from "./intents";

/**
 * EXTRACCIÓN DEL MENSAJE.
 *
 * Gemini lee el mensaje y devuelve datos; el backend decide el paso siguiente.
 * La IA ve el catálogo real para responder preguntas ("¿el parlante es
 * bluetooth?"), pero su respuesta solo se usa si cada precio que menciona existe
 * en el catálogo y cada producto es un id real. Sin llave o si falla: reglas.
 */

export type ExtractedIntent =
  | "comprar"
  | "pregunta"
  | "catalogo"
  | "consultar_pedido"
  | "humano"
  | "dato"
  | "saludo"
  | "fuera_de_tema"
  | "otro";

export interface Extraction {
  intent: ExtractedIntent;
  /** Productos que el cliente quiere agregar, por id del catálogo. */
  items: Array<{ productId: string; quantity: number | null }>;
  remove: string[];
  searchQuery: string;
  suggestions: string[];
  firstName?: string;
  lastName?: string;
  city?: string;
  street?: string;
  reference?: string;
  idNumber?: string;
  email?: string;
  paymentMethod?: BotPaymentMethod;
  answer?: string;
  source: "ai" | "heuristic";
}

export interface ExtractContext {
  stage: string;
  lastQuestion: string;
  cart: Array<{ title: string; quantity: number }>;
  history: string;
  catalog: BotProduct[];
}

export type Extractor = (message: string, context: ExtractContext) => Promise<Extraction>;

const OFF_TOPIC =
  /\b(receta|tarea|deberes|chiste|poema|cancion|traduce|traducir|programa(r|cion)?|codigo|politica|presidente|futbol|partido|clima|horoscopo|ensayo|redacta|escribe un)\b/;

function heuristicIntent(message: string): ExtractedIntent {
  const value = normalize(message);
  if (wantsHuman(message)) return "humano";
  if (wantsTracking(message)) return "consultar_pedido";
  if (wantsCatalog(message)) return "catalogo";
  if (isGreeting(message)) return "saludo";
  if (OFF_TOPIC.test(value)) return "fuera_de_tema";
  if (
    /\?|\b(tiene|trae|sirve|cual|recomienda|diferencia|funciona|incluye|garantia|envio|demora)\b/.test(
      value,
    )
  ) {
    return "pregunta";
  }
  return "comprar";
}

/** Plan B sin IA: intención por regex y búsqueda por palabras en el router. */
export const heuristicExtract: Extractor = async (message) => ({
  intent: heuristicIntent(message),
  items: [],
  remove: [],
  searchQuery: message,
  suggestions: [],
  email: extractEmail(message) || undefined,
  idNumber: extractIdNumber(message) || undefined,
  paymentMethod: detectPaymentMethod(message) || undefined,
  source: "heuristic",
});

const PROMPT =
  () => `Eres el EXTRACTOR de datos del bot de WhatsApp de Kova, tienda online en Ecuador (productos para el hogar, cocina, tecnología y accesorios; envío a todo el país, pago con tarjeta, transferencia o contra entrega).
No conversas libremente. Devuelves SOLO JSON válido con esta forma exacta:
{"intent":"comprar","items":[{"ref":0,"quantity":null}],"remove":[0],"searchQuery":"","suggestions":[0],"firstName":null,"lastName":null,"city":null,"street":null,"reference":null,"idNumber":null,"email":null,"paymentMethod":null,"answer":""}

Catálogo: cada producto tiene un número [ref]. Úsalo para referirte a él. NUNCA inventes productos, precios, stock, variantes ni características que no estén en el catálogo.

intent (uno):
- "comprar": quiere un producto o agregarlo al carrito.
- "pregunta": pregunta sobre productos, características, envío o recomendaciones.
- "catalogo": quiere ver qué venden en general.
- "consultar_pedido": pregunta por un pedido ya hecho o un pago.
- "humano": pide un asesor, reclama, garantía, devolución o algo que el bot no puede resolver.
- "dato": solo responde un dato que el bot pidió (nombre, ciudad, dirección, cédula, correo, forma de pago, sí/no).
- "saludo": solo saluda.
- "fuera_de_tema": pide algo que NO es de Kova (tareas, recetas, chistes, política, programación, traducciones, consejos generales, escribir textos, otras tiendas). Política de Meta: este bot SOLO atiende ventas y pedidos de Kova; nunca respondas eso.
- "otro": nada de lo anterior.

Campos:
- items: SOLO si identifica un producto concreto (por nombre o porque responde a opciones que el bot mostró) Y quiere comprarlo. quantity: solo si dice cuántas unidades, si no null. Si varios encajan, NO elijas: items vacío y usa suggestions.
- remove: refs de productos del carrito que quiere quitar.
- searchQuery: lo que busca con sus palabras, si describe un producto sin identificarlo.
- suggestions: hasta 5 refs que mejor responden a lo que busca o pregunta.
- firstName / lastName: solo si escribe su nombre (o responde a "¿a nombre de quién?").
- city: ciudad o cantón de entrega tal como lo escribe (ej. "Guayaquil", "Quito, Pichincha").
- street: dirección (calle, número, secundaria). reference: referencia para el repartidor.
- idNumber: cédula (10 dígitos) o RUC (13). email: correo.
- paymentMethod: "card" (tarjeta, link de pago), "transfer" (transferencia, depósito) o "cod" (contra entrega, pago al recibir, efectivo). null si no lo dice.
- answer: SOLO con intent "pregunta". Hablas como ${env.BOT_NAME}, el bot de Kova (nunca digas que eres una persona): cercano, tuteas. Formato WhatsApp: 3 a 5 líneas cortas separadas por saltos de línea (\\n), una idea por línea, cada línea de beneficio empieza con un emoji que la represente (ej. ⚡, 🔪, ✅, 🧼, 💤), 3 a 5 emojis en total, nunca un párrafo largo. Signos de pregunta y exclamación SOLO al final (nunca "¿" ni "¡"). Español de Ecuador. Basado EXCLUSIVAMENTE en el catálogo. Si devuelves suggestions, NO enumeres esos productos en answer (el sistema los muestra numerados). Si mencionas un precio, exacto del catálogo en formato $12.90. Si el dato no está en el catálogo, dilo y ofrece pasar con un asesor. No pidas datos personales en answer.
- Usa la pregunta anterior del bot y el historial para interpretar respuestas cortas ("la segunda", "esa", "sí").
- Todo lo que no aplique va null, "" o [].`;

const catalogForPrompt = (catalog: BotProduct[]) =>
  catalog
    .slice(0, 150)
    .map((product, index) => {
      const variants = product.variants.length
        ? ` | opciones: ${product.variants.map((v) => `${v.name} ${formatCents(v.price)}`).join(", ")}`
        : "";
      const offers =
        product.offers.length > 1
          ? ` | ofertas: ${product.offers.map((o) => `${o.quantity}u ${formatCents(o.unitPrice * o.quantity)}`).join(", ")}`
          : "";
      return `[${index}] ${product.name} | ${product.category} | ${formatCents(product.price)}${variants}${offers} | ${product.description.slice(0, 200)}`;
    })
    .join("\n");

/**
 * Limpia el formato de la IA para WhatsApp: un "*" usado como viñeta rompe las
 * negritas. Las viñetas pasan a "•" y se quitan asteriscos sueltos.
 */
export function cleanAnswer(answer: string) {
  return answer
    .split("\n")
    .map((line) => {
      let value = line.replace(/^\s*[*-]\s+/, "• ");
      if ((value.match(/\*/g) || []).length % 2 === 1) value = value.replace(/\*/g, "");
      return value;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Precios que existen en el catálogo (unitarios, tachados, variantes y totales de ofertas). */
export function knownPrices(catalog: BotProduct[]) {
  const values = catalog.flatMap((product) => [
    product.price,
    product.compareAtPrice,
    ...product.variants.map((v) => v.price),
    ...product.offers.flatMap((o) => [o.unitPrice, o.unitPrice * o.quantity]),
  ]);
  return new Set(values.filter((value) => value > 0).map((value) => (value / 100).toFixed(2)));
}

/** Todo precio que la IA escriba debe existir en el catálogo; si no, se descarta su respuesta. */
export function answerPricesAreReal(answer: string, catalog: BotProduct[]) {
  const known = knownPrices(catalog);
  const mentioned = [...answer.matchAll(/\$\s?([\d.,]+)/g)].map((match) =>
    Number(match[1].replace(/,/g, "").replace(/\.$/, "")),
  );
  return mentioned.every((value) => Number.isFinite(value) && known.has(value.toFixed(2)));
}

export const aiExtract: Extractor = async (message, context) => {
  const fallback = await heuristicExtract(message, context);
  const parsed = await geminiJson<any>({
    system: `${PROMPT()}\n\nCATÁLOGO:\n${catalogForPrompt(context.catalog)}`,
    text: [
      `Paso actual del bot: ${context.stage}`,
      `Pregunta anterior del bot: ${context.lastQuestion || "(ninguna)"}`,
      `Carrito: ${context.cart.map((line) => `${line.quantity} x ${line.title}`).join(", ") || "(vacío)"}`,
      `Historial reciente:\n${context.history || "(sin historial)"}`,
      `Mensaje del cliente: ${message}`,
    ].join("\n"),
    maxOutputTokens: 700,
  });
  if (!parsed) return fallback;

  const catalog = context.catalog.slice(0, 150);
  const byRef = (ref: unknown) => {
    const index = Number(ref);
    return Number.isInteger(index) && index >= 0 && index < catalog.length ? catalog[index] : null;
  };
  const str = (value: unknown, max = 200) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
  const intents: ExtractedIntent[] = [
    "comprar",
    "pregunta",
    "catalogo",
    "consultar_pedido",
    "humano",
    "dato",
    "saludo",
    "fuera_de_tema",
    "otro",
  ];
  const intent = intents.includes(parsed.intent)
    ? (parsed.intent as ExtractedIntent)
    : fallback.intent;
  const answer = str(parsed.answer, 1000);
  const payment = ["card", "transfer", "cod"].includes(parsed.paymentMethod)
    ? parsed.paymentMethod
    : undefined;
  const idNumber = extractIdNumber(String(parsed.idNumber || ""));

  return {
    intent,
    items: (Array.isArray(parsed.items) ? parsed.items : [])
      .map((item: any) => {
        const quantity = Number(item?.quantity);
        return {
          product: byRef(item?.ref),
          quantity: Number.isInteger(quantity) && quantity >= 1 ? Math.min(quantity, 10) : null,
        };
      })
      .filter((item: any) => item.product)
      .map((item: any) => ({ productId: item.product.id, quantity: item.quantity })),
    remove: (Array.isArray(parsed.remove) ? parsed.remove : [])
      .map(byRef)
      .filter(Boolean)
      .map((product: BotProduct) => product.id),
    searchQuery: str(parsed.searchQuery, 120) || "",
    suggestions: (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
      .map(byRef)
      .filter(Boolean)
      .slice(0, 5)
      .map((product: BotProduct) => product.id),
    firstName: str(parsed.firstName, 60),
    lastName: str(parsed.lastName, 60),
    city: str(parsed.city, 80),
    street: str(parsed.street, 200),
    reference: str(parsed.reference, 200),
    // Cédula y correo se validan con reglas aunque vengan de la IA.
    idNumber: idNumber || fallback.idNumber,
    email: extractEmail(String(parsed.email || "")) || fallback.email,
    paymentMethod: payment || fallback.paymentMethod,
    answer:
      intent === "pregunta" && answer && answerPricesAreReal(answer, catalog)
        ? cleanAnswer(answer).slice(0, 700)
        : undefined,
    source: "ai",
  };
};
