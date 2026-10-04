import { env } from "../../config/env";
import { normalizeEcPhone } from "../../utils/phone";

/**
 * Lectura del body de BuilderBot: texto, teléfono, archivo e historial. Acepta
 * los nombres de campo de BuilderBot y de Boloncity/Megaprinter.
 */

/** Una variable de BuilderBot que no se reemplazó llega literal: "{body}", "{from}". */
const PLACEHOLDER = /^\{\s*[\w.-]+\s*\}$/;

export function clean(value: unknown) {
  if (value == null || typeof value === "object") return "";
  const text = String(value).trim();
  return PLACEHOLDER.test(text) ? "" : text;
}

/**
 * Teléfono de la sesión: 09XXXXXXXX para celulares de Ecuador. WhatsApp puede
 * mandar el JID ("593991234567:12@s.whatsapp.net"). Un "…@lid" es un id de
 * privacidad, no un teléfono: la sesión queda como "lid:<dígitos>" y el bot
 * pide el celular. Otros países: "+<dígitos>".
 */
export function toSessionPhone(value: unknown) {
  const text = clean(value);
  if (!text) return "";
  if (/@lid\b/i.test(text) || /^lid:\d+$/.test(text)) {
    const lid = text
      .replace(/^lid:/, "")
      .replace(/[:@].*$/, "")
      .replace(/\D/g, "");
    return lid ? `lid:${lid}` : "";
  }
  const digits = text.replace(/[:@].*$/, "").replace(/\D/g, "");
  if (!digits) return "";
  return normalizeEcPhone(digits) || `+${digits}`;
}

/** Fuera de producción, BOT_TEST_PHONE reemplaza el teléfono (pruebas por Telegram o Postman). */
export function readPhone(body: any) {
  const testPhone = env.NODE_ENV !== "production" ? toSessionPhone(env.BOT_TEST_PHONE) : "";
  return (
    testPhone || toSessionPhone(clean(body?.phone) || clean(body?.from) || clean(body?.telefono))
  );
}

const ASSISTANT_ROLES = /^(assistant|model|bot|system|asistente|ia|ai)$/i;
const ROLE_LINE =
  /^\s*(user|usuario|cliente|human|humano|customer|assistant|asistente|model|bot|system|ia|ai)\s*:\s*(.*)$/i;

function historyContent(value: any): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(historyContent).filter(Boolean).join("\n").trim();
  for (const key of ["text", "content", "message", "body", "value"]) {
    if (typeof value?.[key] === "string") return value[key].trim();
  }
  return "";
}

function historyItems(value: unknown): any[] | string {
  let data: any = value;
  if (typeof data === "string") {
    const text = clean(data);
    if (!text) return [];
    try {
      data = JSON.parse(text);
    } catch {
      return text;
    }
  }
  return Array.isArray(data)
    ? data
    : (["messages", "history", "conversation", "data"]
        .map((key) => data?.[key])
        .find(Array.isArray) as any[]) || [];
}

/** Último mensaje del CLIENTE dentro de `{history}` (flujo que solo manda el historial). */
export function latestUserMessage(history: unknown): string {
  if (history == null) return "";
  const items = historyItems(history);
  if (typeof items === "string") {
    const lines = items
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.some((line) => ROLE_LINE.test(line))) return lines.length === 1 ? lines[0] : "";
    let last = "";
    let current: { assistant: boolean; parts: string[] } | null = null;
    for (const line of lines) {
      const match = line.match(ROLE_LINE);
      if (match) {
        if (current && !current.assistant) last = current.parts.join("\n");
        current = { assistant: ASSISTANT_ROLES.test(match[1]), parts: [match[2]] };
      } else if (current) current.parts.push(line);
    }
    if (current && !current.assistant) last = current.parts.join("\n");
    return last.trim();
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (ASSISTANT_ROLES.test(String(item?.role ?? item?.sender ?? item?.type ?? "user"))) continue;
    const content = historyContent(
      item?.content ?? item?.parts ?? item?.text ?? item?.body ?? item,
    );
    if (content) return content;
  }
  return "";
}

/** Últimos turnos del {history} de BuilderBot como "Cliente: … / Bot: …" (vacío si no llega). */
export function builderBotHistory(value: unknown, maxEntries = 12): string {
  const items = historyItems(value);
  if (typeof items === "string")
    return items
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-maxEntries)
      .join("\n")
      .slice(-3000);
  return items
    .slice(-maxEntries)
    .map((item: any) => {
      const content = historyContent(
        item?.content ?? item?.parts ?? item?.text ?? item?.body ?? item,
      );
      if (!content) return "";
      const assistant = ASSISTANT_ROLES.test(
        String(item?.role ?? item?.sender ?? item?.type ?? "user"),
      );
      return `${assistant ? "Bot" : "Cliente"}: ${content.slice(0, 400)}`;
    })
    .filter(Boolean)
    .join("\n")
    .slice(-3000);
}

function rawText(body: any) {
  return (
    [body?.rawMessage, body?.rawMess, body?.body, body?.message, body?.mensaje]
      .map(clean)
      .find(Boolean) || latestUserMessage(body?.history)
  );
}

/** BuilderBot manda los eventos sin texto como "_event_media__<uuid>", "_event_document__…". */
const EVENT = /^_event_(\w*?)__/i;

export function readMessage(body: any) {
  const text = rawText(body);
  return EVENT.test(text) ? "" : text.slice(0, 1500);
}

/** URL del archivo. BuilderBot la expone como {urlTempFile}; se aceptan otros nombres. */
export function readMediaUrl(body: any) {
  const keys = ["urlTempFile", "tempFile", "fileUrl", "mediaUrl", "imageUrl", "url"];
  const candidates = [...keys.map((key) => body?.[key]), ...keys.map((key) => body?.data?.[key])];
  return candidates.map(clean).find((value) => /^https?:\/\//i.test(value)) || "";
}

/** Tipo de archivo según el evento de BuilderBot ("_event_video__…", "_event_voice_note__…"). */
export function mediaEventKind(body: any): "video" | "audio" | "file" | undefined {
  const name = rawText(body).match(EVENT)?.[1] || "";
  if (!name || /location|ubicacion/i.test(name)) return undefined;
  if (/video/i.test(name)) return "video";
  if (/voice|audio|note/i.test(name)) return "audio";
  return "file";
}
