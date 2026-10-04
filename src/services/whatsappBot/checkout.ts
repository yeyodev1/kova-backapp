import { normalizeEcPhone } from "../../utils/phone";
import type { Extraction } from "./extractor";
import {
  BotPaymentMethod,
  detectPaymentMethod,
  extractChoice,
  extractEmail,
  extractIdNumber,
  isGreeting,
  isNo,
  isSkip,
  isYes,
  normalize,
} from "./intents";
import { matchLocation, placeText } from "./location";
import { reply } from "./reply";
import {
  ASK_PRODUCT,
  QUESTIONS,
  bankQuestion,
  cardInstructions,
  codInstructions,
  paymentQuestion,
  summaryText,
  transferInstructions,
} from "./texts";
import type { BankOption, BotDeps, BotState, TurnResult } from "./types";

/**
 * DATOS DEL PEDIDO Y CIERRE. Pide lo que falte en orden: nombre y apellido,
 * celular (si WhatsApp lo oculta), ciudad validada contra Dropi, dirección,
 * referencia, cédula y correo (opcionales), forma de pago y banco. Luego el
 * resumen con el total del quote y, con el "sí", el pedido real.
 */

export function availableMethods(deps: BotDeps): BotPaymentMethod[] {
  return [
    ...(deps.cardEnabled ? (["card"] as const) : []),
    ...(deps.banks.length ? (["transfer"] as const) : []),
    "cod" as const,
  ];
}

export const chosenBank = (state: BotState, deps: BotDeps): BankOption | null =>
  state.bankIndex >= 0 ? deps.banks[state.bankIndex] || null : null;

/** Primer dato que falta para cerrar el pedido. */
export function missingStage(state: BotState, deps: BotDeps): BotState["stage"] {
  if (!state.cart.length) return "idle";
  if (!state.firstName || !state.lastName) return "name";
  if (!normalizeEcPhone(state.phone)) return "phone";
  if (!state.city) return state.cityOptions.length ? "city_choice" : "city";
  if (!state.street) return "address";
  if (!state.referenceAsked && !state.reference) return "reference";
  if (!state.extrasAsked) return "extras";
  const methods = availableMethods(deps);
  if (state.paymentMethod && !methods.includes(state.paymentMethod)) state.paymentMethod = null;
  if (!state.paymentMethod) {
    if (methods.length === 1) state.paymentMethod = methods[0];
    else return "payment";
  }
  if (state.paymentMethod === "transfer" && !chosenBank(state, deps)) {
    if (deps.banks.length === 1) state.bankIndex = 0;
    else return "bank";
  }
  return "confirm";
}

const cartItems = (state: BotState) =>
  state.cart.map((line) => ({
    productId: line.productId,
    variantId: line.variantId,
    quantity: line.quantity,
  }));

/** Pregunta por lo que falta (o muestra el resumen), con un prefijo opcional. */
export async function askNext(
  state: BotState,
  deps: BotDeps,
  decision: string,
  prefix = "",
): Promise<TurnResult> {
  state.stage = missingStage(state, deps);
  const join = (text: string) => (prefix ? `${prefix}\n\n${text}` : text);
  switch (state.stage) {
    case "idle":
      return reply(state, join(ASK_PRODUCT), decision);
    case "name":
      return reply(
        state,
        join(state.firstName && !state.lastName ? QUESTIONS.lastName : QUESTIONS.name),
        decision,
      );
    case "city":
      return reply(
        state,
        join(
          state.province
            ? `Perfecto, ${state.province} 👍 En qué *ciudad o cantón* te lo entregamos?`
            : QUESTIONS.city,
        ),
        decision,
      );
    case "city_choice": {
      const list = state.cityOptions
        .map((place, index) => `*${index + 1}.* ${placeText(place)}`)
        .join("\n");
      return reply(
        state,
        join(`Encontré varias con ese nombre 🤔 Cuál es la tuya?\n${list}`),
        decision,
      );
    }
    case "payment":
    case "confirm": {
      const method = state.stage === "payment" ? "card" : (state.paymentMethod as BotPaymentMethod);
      const outcome = await deps.quote(cartItems(state), method);
      if (!outcome.ok) {
        return reply(
          state,
          join(
            `Uy, ${outcome.message.charAt(0).toLowerCase()}${outcome.message.slice(1)} 😕 Dime qué quieres cambiar o escribe *asesor*.`,
          ),
          `${decision}:quote_error`,
        );
      }
      if (state.stage === "payment") {
        state.paymentOptions = availableMethods(deps);
        return reply(state, join(paymentQuestion(state.paymentOptions, outcome.quote)), decision);
      }
      return reply(
        state,
        join(summaryText(state, outcome.quote, chosenBank(state, deps))),
        decision,
        {
          route: "confirmOrder",
          total: outcome.quote.total,
        },
      );
    }
    case "bank":
      return reply(state, join(bankQuestion(deps.banks)), decision);
    default:
      return reply(
        state,
        join(QUESTIONS[state.stage as keyof typeof QUESTIONS] || ASK_PRODUCT),
        decision,
      );
  }
}

const NAME = /^[\p{L}][\p{L}' .-]{1,80}$/u;

export const looksLikeName = (text: string) => {
  const value = text.trim();
  return (
    NAME.test(value) &&
    value.split(/\s+/).length <= 5 &&
    !isYes(value) &&
    !isNo(value) &&
    !isGreeting(value) &&
    !detectPaymentMethod(value)
  );
};

const titleCase = (text: string) =>
  text
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/** "Ana Pérez" → Ana / Pérez; "Ana María Pérez Gómez" → Ana María / Pérez Gómez. */
export function splitName(text: string) {
  const words = titleCase(text).split(" ");
  if (words.length === 1) return { firstName: words[0], lastName: "" };
  if (words.length === 2 || words.length === 3)
    return { firstName: words[0], lastName: words.slice(1).join(" ") };
  return { firstName: words.slice(0, 2).join(" "), lastName: words.slice(2).join(" ") };
}

type CityResult = "ok" | "ambiguous" | "province" | "not_found";

/** Ciudad contra las ubicaciones de Dropi. Sin ubicaciones cargadas se acepta "ciudad, provincia". */
export async function applyCity(state: BotState, text: string, deps: BotDeps): Promise<CityResult> {
  const index = await deps.loadLocations();
  if (!index.provinces.length) {
    const [city, province] = text
      .split(/[,/-]/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (!city || city.length < 3) return "not_found";
    Object.assign(state, {
      city: city.slice(0, 80),
      province: (province || city).slice(0, 80),
      cityId: 0,
      provinceId: 0,
    });
    return "ok";
  }
  const within = state.provinceId && !state.cityId ? state.provinceId : 0;
  let match = matchLocation(text, index, within);
  // Escribió otra ciudad de otra provincia: se busca en todo el país.
  if (within && match.status !== "ok" && match.status !== "ambiguous")
    match = matchLocation(text, index);
  if (match.status === "ok") {
    Object.assign(state, { ...match.place, cityOptions: [] });
    return "ok";
  }
  if (match.status === "ambiguous") {
    state.cityOptions = match.options;
    return "ambiguous";
  }
  if (match.status === "province_only") {
    Object.assign(state, {
      provinceId: match.provinceId,
      province: match.province,
      cityId: 0,
      city: "",
    });
    return "province";
  }
  return "not_found";
}

/** Divide "Av. Siempre Viva 123, ref: casa azul" en dirección y referencia. */
export function splitAddress(text: string) {
  const parts = text.split(/\b(?:ref(?:erencia)?\.?\s*:?)\s*/i);
  return {
    street: parts[0]
      .replace(/[,;\s-]+$/, "")
      .trim()
      .slice(0, 200),
    reference: (parts[1] || "").trim().slice(0, 200),
  };
}

/** Datos que el cliente dio en cualquier momento (suelen mandar todo junto). */
export async function applyExtraction(
  state: BotState,
  extraction: Extraction,
  message: string,
  deps: BotDeps,
) {
  if (
    extraction.firstName &&
    (!state.firstName || state.stage === "name" || state.stage === "confirm")
  ) {
    state.firstName = extraction.firstName;
    if (extraction.lastName) state.lastName = extraction.lastName;
  }
  const email = extractEmail(message) || extraction.email;
  if (email) state.email = email;
  const idNumber = extractIdNumber(message) || extraction.idNumber;
  if (idNumber) state.idNumber = idNumber;
  if (extraction.city && extraction.source === "ai" && (!state.city || state.stage === "confirm")) {
    await applyCity(state, extraction.city, deps);
  }
  if (
    extraction.street &&
    extraction.source === "ai" &&
    (!state.street || state.stage === "confirm")
  ) {
    state.street = extraction.street;
  }
  if (extraction.reference && extraction.source === "ai") {
    state.reference = extraction.reference;
    state.referenceAsked = true;
  }
  if ((email || idNumber) && state.street) state.extrasAsked = true;
  const method = extraction.paymentMethod;
  if (method && availableMethods(deps).includes(method) && state.cart.length)
    state.paymentMethod = method;
}

/** Respuesta al paso pendiente, con reglas (sirven aunque la IA esté caída). */
export async function applyStageAnswer(
  state: BotState,
  message: string,
  deps: BotDeps,
): Promise<boolean | "retry"> {
  const text = message.trim();
  switch (state.stage) {
    case "name": {
      const clean = text
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "")
        .replace(/\b\d+\b/g, "")
        .replace(/[,;]/g, " ")
        .trim()
        .replace(/^(soy|me llamo|mi nombre es|a nombre de)\s+/i, "");
      if (!looksLikeName(clean)) return false;
      // Ya tenía el nombre y se le pidió solo el apellido.
      if (state.firstName && !state.lastName && !clean.includes(" "))
        state.lastName = titleCase(clean);
      else Object.assign(state, splitName(clean));
      return true;
    }
    case "phone": {
      const phone = normalizeEcPhone(text.replace(/[^\d+]/g, ""));
      if (!phone) return "retry";
      state.phone = phone;
      return true;
    }
    case "city": {
      const result = await applyCity(state, text, deps);
      return result === "not_found" ? "retry" : true;
    }
    case "city_choice": {
      const choice = extractChoice(text, state.cityOptions.length);
      if (choice) {
        Object.assign(state, { ...state.cityOptions[choice - 1], cityOptions: [] });
        return true;
      }
      state.cityOptions = [];
      const result = await applyCity(state, text, deps);
      return result === "not_found" ? "retry" : true;
    }
    case "address": {
      if (text.length < 5 || !/\p{L}/u.test(text) || isYes(text) || isNo(text)) return "retry";
      const { street, reference } = splitAddress(text);
      state.street = street;
      if (reference) {
        state.reference = reference;
        state.referenceAsked = true;
      }
      return true;
    }
    case "reference":
      state.referenceAsked = true;
      if (!isSkip(text)) state.reference = text.slice(0, 200);
      return true;
    case "extras": {
      const email = extractEmail(text);
      const idNumber = extractIdNumber(text);
      if (email) state.email = email;
      if (idNumber) state.idNumber = idNumber;
      if (email || idNumber || isSkip(text)) {
        state.extrasAsked = true;
        return true;
      }
      return "retry";
    }
    case "payment": {
      const options = state.paymentOptions.length ? state.paymentOptions : availableMethods(deps);
      const choice = extractChoice(text, options.length);
      const named = detectPaymentMethod(text);
      const method = named && options.includes(named) ? named : choice ? options[choice - 1] : null;
      if (!method) return named ? "retry" : false;
      state.paymentMethod = method;
      return true;
    }
    case "bank": {
      const choice = extractChoice(text, deps.banks.length);
      const value = normalize(text);
      const index = choice
        ? choice - 1
        : deps.banks.findIndex((account) =>
            normalize(account.bank)
              .replace(/^banco (del |de )?/, "")
              .split(" ")
              .some((word) => word.length > 3 && value.includes(word)),
          );
      if (index < 0) return "retry";
      state.bankIndex = index;
      return true;
    }
    default:
      return false;
  }
}

const RETRY: Partial<Record<BotState["stage"], string>> = {
  phone: "Ese número no me cuadra 🤔 Escríbelo así: *09XXXXXXXX*",
  city: "No encontré esa ciudad 🤔 Escríbemela de nuevo, por ejemplo *Guayaquil* o *Quito, Pichincha*",
  city_choice:
    "No encontré esa ciudad 🤔 Respóndeme con el número de la lista o escríbela con su provincia",
  address: "Me pasas la *dirección completa*? Calle principal, número y secundaria 🏠",
  extras:
    "No reconocí una cédula (10 dígitos) ni un correo 🤔 Escríbelos de nuevo o responde *no* para saltar",
  payment: "Esa forma de pago no la tengo disponible 🙏 Respóndeme con el número de la lista",
  bank: "Respóndeme con el número del banco de la lista 🙏",
};

export const retryText = (stage: BotState["stage"]) => RETRY[stage] || "";

/** "no" en el resumen y luego "la dirección": se borra ese dato y se vuelve a pedir. */
export function resetNamedField(state: BotState, message: string): boolean {
  const value = normalize(message);
  if (value.split(" ").length > 6) return false;
  if (/\b(nombre|apellido)\b/.test(value)) Object.assign(state, { firstName: "", lastName: "" });
  else if (/\b(ciudad|provincia|canton)\b/.test(value))
    Object.assign(state, { city: "", cityId: 0, province: "", provinceId: 0, cityOptions: [] });
  else if (/\b(direccion|calle)\b/.test(value))
    Object.assign(state, { street: "", reference: "", referenceAsked: false });
  else if (/\breferencia\b/.test(value))
    Object.assign(state, { reference: "", referenceAsked: false });
  else if (/\b(cedula|correo|email|mail)\b/.test(value))
    Object.assign(state, { idNumber: "", email: "", extrasAsked: false });
  else if (/\b(celular|telefono|numero)\b/.test(value)) state.phone = "";
  else if (/\b(pago|forma de pago|metodo|banco)\b/.test(value))
    Object.assign(state, { paymentMethod: null, bankIndex: -1 });
  else return false;
  return true;
}

/** "sí" al resumen: crea el pedido real y responde según la forma de pago. */
export async function confirmOrder(state: BotState, deps: BotDeps): Promise<TurnResult> {
  const outcome = await deps.createOrder(state);
  if (!outcome.ok) {
    return reply(
      state,
      `Uy, no pude registrar tu pedido: ${outcome.message} 😕 Dime qué cambiamos o escribe *asesor* y te ayuda una persona.`,
      "R7:orden_fallida",
      { route: "confirmOrder" },
    );
  }
  const order = outcome.order;
  const method = state.paymentMethod as BotPaymentMethod;
  const bank = chosenBank(state, deps);
  // El carrito se vacía: un "sí" repetido nunca puede crear otro pedido.
  Object.assign(state, {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    stage: "ordered",
    options: [],
    cart: [],
  });
  const text =
    method === "card" && order.paymentLink
      ? cardInstructions(order)
      : method === "transfer" && bank
        ? transferInstructions(order, bank)
        : codInstructions(order);
  return reply(state, text, "R7:orden_creada", {
    intent: "orden_creada",
    route:
      method === "card"
        ? "checkoutCard"
        : method === "transfer"
          ? "checkoutTransfer"
          : "checkoutCod",
    orderNumber: order.orderNumber,
    paymentLink: method === "card" ? order.paymentLink : "",
    paymentMethod: method,
    total: order.total,
  });
}
