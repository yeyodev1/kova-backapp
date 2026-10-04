import { geminiJson } from "../gemini.service";
import { botName, casualMarks } from "./texts";

/**
 * VOZ DEL BOT CON IA.
 *
 * El router decide QUÉ decir (datos, pasos, listas); aquí Gemini lo reescribe
 * para que suene natural y sin repetir lo que ya dijo. Los datos no se tocan:
 * cada línea con datos debe salir idéntica y se conservan montos, KV-, links,
 * números y la palabra "bot". Si la IA cambia algo, tarda o falla, se envía el
 * borrador original.
 */

/** Líneas estructuradas que la IA copia tal cual: listas, viñetas, datos de cuenta, resumen. */
const STRUCTURED =
  /^(\*\d+\.\*|•|🏦|👤|📱|📍|🪪|📧|💳|\*Total|N\.º|A nombre de|RUC|Cuenta |Paga aquí|https?:\/\/)/u;

export const protectedLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && STRUCTURED.test(line));

/** Datos sueltos dentro del texto libre: pedidos, montos, números largos, links y correos. */
export const protectedTokens = (text: string) => [
  ...new Set(
    text.match(/KV-\d+|\$\d[\d,]*(?:\.\d+)?|https?:\/\/\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\d{4,}/g) ||
      [],
  ),
];

/** Lo que el cliente debe leer o escribir tal cual (*negritas*) y la palabra "bot" (transparencia). */
export const protectedPhrases = (text: string) => [
  ...new Set([...(text.match(/\*[^*\n]+\*/g) || []), ...(/\bbot\b/i.test(text) ? ["bot"] : [])]),
];

/** El borrador y la versión de la IA conservan exactamente los mismos datos. */
export function keepsData(draft: string, rewritten: string) {
  const output = rewritten.split("\n").map((line) => line.trim());
  return (
    protectedLines(draft).every((line) => output.includes(line)) &&
    protectedTokens(draft).every((token) => rewritten.includes(token)) &&
    // Ni datos nuevos: un KV-, monto, link o número que no estaba es inventado.
    protectedTokens(rewritten).every((token) => draft.includes(token)) &&
    protectedPhrases(draft).every((phrase) => rewritten.includes(phrase)) &&
    // Nunca dice que es una persona.
    !/\bsoy (una )?(persona|humano|humana)\b/i.test(rewritten)
  );
}

const VOICE_PROMPT = (
  name: string,
) => `Eres ${name}, el bot de Kova (tienda online en Ecuador) que atiende por WhatsApp. Cercano y amable, tuteas, nada formal, español de Ecuador, emojis con moderación (máximo 3).
Te paso el BORRADOR del mensaje que vas a enviar y tus últimos mensajes. Reescribe el borrador para que suene natural y DISTINTO a tus mensajes anteriores (no repitas saludos, muletillas ni aperturas).
Devuelve SOLO JSON: {"message":"..."}
Reglas estrictas:
- Copia IDÉNTICAS, cada una en su propia línea, las líneas de listas numeradas (*1.* …), viñetas (•), datos de cuenta (🏦, Cuenta, N.º, A nombre de, RUC), resumen (👤 📱 📍 🪪 📧 💳, *Total*) y links.
- En el resto del texto conserva exactos los números de pedido (KV-…), montos ($…), números, links y correos.
- No agregues información, características, productos, precios, plazos ni promesas que no estén en el borrador. No quites nada que el borrador pida al cliente.
- Copia exactas todas las palabras en *negrita* (con sus asteriscos).
- Eres un bot y nunca lo ocultas: si el borrador dice "bot", tu mensaje también. Nunca digas ni insinúes que eres una persona.
- Signos de pregunta y exclamación SOLO al final (nunca "¿" ni "¡").
- Igual de corto o más corto que el borrador.`;

export async function naturalize(draft: string, recent: string[]): Promise<string> {
  if (!draft.trim()) return draft;
  const parsed = await geminiJson<{ message?: string }>({
    system: VOICE_PROMPT(botName()),
    text: `Tus últimos mensajes (no los repitas):\n${recent.map((message) => `---\n${message}`).join("\n") || "(ninguno)"}\n\nBORRADOR:\n${draft}`,
    maxOutputTokens: 900,
    timeoutMs: 8000,
  });
  const message = typeof parsed?.message === "string" ? casualMarks(parsed.message.trim()) : "";
  if (!message || message.length > draft.length * 1.3 + 60 || !keepsData(draft, message))
    return draft;
  return message;
}
