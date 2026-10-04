/**
 * Detectores deterministas (regex). Deciden lo que no puede quedar en manos
 * de la IA: sí/no al confirmar, correo, cédula, elección por número, pedir
 * una persona, no recibir mensajes.
 */

export const normalize = (text: string) =>
  String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.@\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const has = (text: string, pattern: RegExp) => pattern.test(normalize(text));

export const isYes = (text: string) =>
  has(
    text,
    /^(si+|sii+|ok+|okey|dale|listo|claro|correcto|confirmo|confirmado|de una|va|vale|perfecto|asi es|esta bien|todo bien|exacto|hagale|hazlo)\b/,
  );

export const isNo = (text: string) =>
  has(text, /^(no+|nop|nel|ninguno|ninguna|todavia no|aun no|espera|cambiar|corregir)\b/);

/** "no", "ninguna", "saltar", "sin referencia": respuesta para saltar un dato opcional. */
export const isSkip = (text: string) =>
  has(
    text,
    /^(no+|nop|ninguno|ninguna|nada|saltar|salta|omitir|paso|sin (referencia|cedula|correo)|no tengo|despues)\b/,
  );

export const wantsHuman = (text: string) =>
  has(
    text,
    /\b(asesor|asesora|humano|persona real|agente|alguien real|hablar con alguien|vendedor|reclamo|queja|estafa|devolucion|devolver|garantia|reembolso)\b/,
  );

export const wantsCatalog = (text: string) =>
  has(
    text,
    /\b(catalogo|que (productos )?tienen|que venden|productos|ofertas|lista de precios|menu)\b/,
  );

export const wantsTracking = (text: string) =>
  has(
    text,
    /\b(mi pedido|mis pedidos|estado de(l)? (mi )?pedido|mi orden|mi compra|ya transferi|cuando llega|seguimiento|rastrear|rastreo|guia|numero de pedido|kv-?\s?\d+)\b/,
  );

export const wantsCancel = (text: string) =>
  has(
    text,
    /\b(cancela(r)?|ya no (lo )?quiero|olvidalo|vaciar( el)? carrito|borra(r)? (todo|el carrito))\b/,
  );

export const isGreeting = (text: string) =>
  has(text, /^(hola+|buen(os|as)? (dias|tardes|noches)|buenas|saludos|hey|que tal)\b/) &&
  normalize(text).split(" ").length <= 5;

export type BotPaymentMethod = "card" | "transfer" | "cod";

export function detectPaymentMethod(text: string): BotPaymentMethod | null {
  const value = normalize(text);
  if (
    /\b(contra ?entrega|al recibir|cuando (me )?llegue|en efectivo|efectivo|pago al entregar|cod)\b/.test(
      value,
    )
  ) {
    return "cod";
  }
  if (/\b(transferencia|transfiero|transferir|deposito|depositar|deuna)\b/.test(value))
    return "transfer";
  if (/\b(tarjeta|credito|debito|link de pago|payphone|visa|mastercard)\b/.test(value))
    return "card";
  return null;
}

export const extractEmail = (text: string) =>
  String(text || "")
    .match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0]
    ?.toLowerCase() || "";

/** Cédula ecuatoriana con dígito verificador (módulo 10) o RUC de 13 dígitos. */
export function isValidIdNumber(value: string): boolean {
  if (/^\d{13}$/.test(value))
    return isValidIdNumber(value.slice(0, 10)) || /^\d{10}001$/.test(value);
  if (!/^\d{10}$/.test(value)) return false;
  const province = Number(value.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30) || Number(value[2]) >= 6)
    return false;
  const sum = value
    .slice(0, 9)
    .split("")
    .reduce((acc, digit, index) => {
      let n = Number(digit) * (index % 2 === 0 ? 2 : 1);
      if (n > 9) n -= 9;
      return acc + n;
    }, 0);
  return (10 - (sum % 10)) % 10 === Number(value[9]);
}

export function extractIdNumber(text: string) {
  const candidates = String(text || "").match(/\b\d{10}(?:\d{3})?\b/g) || [];
  return candidates.find(isValidIdNumber) || "";
}

/** "2", "la 2", "opción 3", "el primero": posición en la lista mostrada. */
export function extractChoice(text: string, max: number): number | null {
  const value = normalize(text);
  const ordinals: Record<string, number> = {
    primer: 1,
    primero: 1,
    primera: 1,
    segundo: 2,
    segunda: 2,
    tercero: 3,
    tercera: 3,
    tercer: 3,
    cuarto: 4,
    cuarta: 4,
    quinto: 5,
    quinta: 5,
  };
  const ordinal = Object.entries(ordinals).find(([word]) =>
    new RegExp(`\\b${word}\\b`).test(value),
  );
  const numeric = value.match(/^(?:(?:la|el|opcion|numero|nro|#)\s*)?(\d{1,2})$/);
  const choice = ordinal ? ordinal[1] : numeric ? Number(numeric[1]) : null;
  return choice && choice >= 1 && choice <= max ? choice : null;
}

/** Cantidad explícita: "2 licuadoras", "dos", "x3", "3 unidades". */
export function extractQuantity(text: string): number | null {
  const value = normalize(text);
  const words: Record<string, number> = {
    un: 1,
    una: 1,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
  };
  const units = value.match(/\b(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco)\s+(unidad|unidades|u)\b/);
  if (units) return Number(units[1]) || words[units[1]] || null;
  // Solo al inicio ("2 licuadoras") o con x ("x2"): "parlante 20w" no es una cantidad.
  const digit = value.match(/^(?:quiero |dame |necesito )?(\d{1,2})(?:\s|$)|\bx\s?(\d{1,2})\b/);
  if (digit) return Math.min(Number(digit[1] || digit[2]), 10) || null;
  // "quiero un parlante" no fija la cantidad: así se le ofrecen las ofertas por cantidad.
  const word = Object.entries(words)
    .filter(([, quantity]) => quantity > 1)
    .find(([key]) => new RegExp(`^(?:quiero |dame |necesito )?${key}\\b`).test(value));
  return word ? word[1] : null;
}

/**
 * Respuesta corta en el paso de cantidad: "una sola", "solo una", "uno nomás", "las dos", "tres".
 * Aquí "una" sí es una cantidad, a diferencia de "quiero una licuadora" en una búsqueda.
 */
export function quantityAnswer(text: string): number | null {
  const value = normalize(text).replace(/[!.?,]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(?:solo |sola |nomas )?(?:un|una|uno|1)(?: sola| solo| solita| nomas| no mas| unidad)?(?: nomas| no mas| porfa| por favor| gracias)?$/.test(value)) return 1;
  if (/^(?:solo )?(?:una|uno|1) (?:sola|solo)$/.test(value)) return 1;
  const words: Record<string, number> = { dos: 2, tres: 3, cuatro: 4, cinco: 5 };
  const match = value.match(/^(?:las |los |solo |quiero |dame )?(dos|tres|cuatro|cinco)(?: unidades| porfa| por favor)?$/);
  return match ? words[match[1]] : null;
}

/** "KV-1001", "kv 1001", "pedido 1001". */
export function orderNumberIn(text: string) {
  const match =
    String(text || "").match(/\bKV-?\s?(\d{3,6})\b/i) ||
    normalize(text).match(/\bpedido\s+(\d{4,6})\b/);
  return match ? `KV-${match[1]}` : "";
}

/** Pide que no le escriban más (política de Meta: se respeta y se confirma). */
export const wantsOptOut = (text: string) =>
  has(
    text,
    /\b(no me escribas|no me vuelvas a escribir|deja de escribir(me)?|no quiero (mas )?mensajes|stop|darme de baja|no molestar|no me interesa)\b/,
  );

/** "eres un bot?", "hablo con una persona?", "eres real?": se responde con la verdad. */
export const asksIfBot = (text: string) =>
  has(
    text,
    /\b(eres (un |una )?(bot|robot|ia|inteligencia artificial|maquina|persona|humano|humana|real)|(hablo|estoy hablando) con (un |una )?(bot|robot|maquina|persona|humano|humana|ia)|es (un )?(bot|automatico)|sos (un )?bot)\b/,
  );

/** "pagado", "ya pagué", "listo, pagué", "ya hice el pago". */
export const claimsPaid = (text: string) =>
  has(
    text,
    /\b(pagado|ya pague|ya pagamos|listo pague|ya hice el pago|ya realice el pago|pago hecho|ya esta pagado|acabo de pagar)\b/,
  );

/** "ya transferí", "ya deposité": falta la foto del comprobante. */
export const claimsTransfer = (text: string) =>
  has(
    text,
    /\b(ya transferi|transferi|ya deposite|deposite|hice la transferencia|ya hice la transferencia)\b/,
  );
