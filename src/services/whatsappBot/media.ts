import axios from "axios";
import { geminiJson } from "../gemini.service";
import type { BotProduct } from "./catalog";

/**
 * Archivos que manda el cliente por WhatsApp: descarga, tipo, y lectura con
 * Gemini (¿comprobante, producto u otra cosa?). La IA solo AYUDA: nunca aprueba
 * un pago; eso lo hace una persona en el panel.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const VIDEO_EXT = /\.(mp4|mov|3gp|webm|mkv|avi)(\?|$)/i;
const AUDIO_EXT = /\.(ogg|opus|mp3|m4a|aac|wav|amr)(\?|$)/i;

export interface MediaFile {
  buffer: Buffer;
  mimeType: string;
}

/** Descarga el archivo temporal que manda BuilderBot (sus URLs caducan). */
export async function downloadMedia(url: string): Promise<MediaFile> {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 15000,
    maxContentLength: MAX_BYTES,
  });
  let mimeType = String(response.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!mimeType || mimeType === "application/octet-stream") {
    mimeType = /\.pdf(\?|$)/i.test(url)
      ? "application/pdf"
      : /\.png(\?|$)/i.test(url)
        ? "image/png"
        : "image/jpeg";
  }
  if (mimeType === "image/jpg") mimeType = "image/jpeg";
  return { buffer: Buffer.from(response.data), mimeType };
}

/** Tipo del archivo SIN descargarlo (un video puede pesar decenas de MB). */
export async function probeMediaKind(url: string): Promise<"video" | "audio" | ""> {
  if (VIDEO_EXT.test(url)) return "video";
  if (AUDIO_EXT.test(url)) return "audio";
  try {
    const response = await axios.head(url, { timeout: 5000 });
    const type = String(response.headers["content-type"] || "");
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
  } catch {
    // Algunos servidores no aceptan HEAD: se decide al descargar.
  }
  return "";
}

export const mediaKindFromMime = (mimeType: string): "video" | "audio" | "" =>
  mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : "";

export interface ImageInsight {
  kind: "receipt" | "product" | "other";
  description: string;
  searchQuery: string;
  productIds: string[];
  exactMatch: boolean;
}

const IMAGE_PROMPT = `Eres el asistente de Kova (tienda online en Ecuador: hogar, cocina, tecnología y accesorios). Un cliente mandó esta imagen por WhatsApp. Puede ser una foto, una captura de Instagram/TikTok, una publicidad o un comprobante bancario.
Devuelve SOLO JSON: {"kind":"receipt|product|other","description":"","searchQuery":"","matches":[0],"exactMatch":false}
- kind "receipt": comprobante de transferencia, depósito o pago bancario, o captura de un pago con tarjeta aprobado.
- kind "product": muestra un producto o una publicación/anuncio de uno.
- kind "other": cualquier otra cosa.
- description: frase corta en español de lo que se ve (ej. "una licuadora negra de vaso de vidrio").
- searchQuery: si es product, 2 a 4 palabras para buscarlo (ej. "licuadora vidrio"); si no, "".
- matches: si es product, hasta 3 números [ref] del CATÁLOGO que sean ese mismo producto o los más parecidos. [] si ninguno. NUNCA inventes refs.
- exactMatch: true solo si el primer ref es exactamente el mismo producto.`;

/** Qué muestra una imagen: comprobante, producto (cruzado con el catálogo) u otra cosa. null sin IA. */
export async function describeImage(
  file: MediaFile,
  catalog: BotProduct[],
): Promise<ImageInsight | null> {
  if (!file.mimeType.startsWith("image/")) return null;
  const list = catalog
    .slice(0, 150)
    .map((product, index) => `[${index}] ${product.name} | ${product.category}`)
    .join("\n");
  const parsed = await geminiJson<any>({
    system: `${IMAGE_PROMPT}\n\nCATÁLOGO:\n${list || "(vacío)"}`,
    text: "Analiza la imagen del cliente.",
    image: { mimeType: file.mimeType, base64: file.buffer.toString("base64") },
    maxOutputTokens: 300,
    timeoutMs: 15000,
  });
  if (!parsed) return null;
  const kind = ["receipt", "product", "other"].includes(parsed.kind) ? parsed.kind : "other";
  const productIds =
    kind === "product" && Array.isArray(parsed.matches)
      ? ([
          ...new Set(
            parsed.matches
              .map(Number)
              .filter((i: number) => Number.isInteger(i) && catalog[i])
              .map((i: number) => catalog[i].id),
          ),
        ].slice(0, 3) as string[])
      : [];
  return {
    kind,
    description: String(parsed.description || "").slice(0, 160),
    searchQuery: kind === "product" ? String(parsed.searchQuery || "").slice(0, 120) : "",
    productIds,
    exactMatch: productIds.length > 0 && parsed.exactMatch === true,
  };
}

export interface ReceiptReading {
  isReceipt: boolean | null;
  /** Centavos. */
  detectedAmount: number | null;
  detectedBank: string;
  detectedReference: string;
  summary: string;
}

const RECEIPT_PROMPT = `Eres asistente contable de Kova (tienda online en Ecuador). Te muestran una imagen que un cliente envió como comprobante de transferencia o depósito.
Devuelve SOLO JSON: {"isReceipt":bool,"detectedAmount":number|null,"detectedBank":"","detectedReference":"","summary":""}
- isReceipt: true solo si es un comprobante bancario real. Fotos de productos, chats o imágenes borrosas = false.
- detectedAmount: monto transferido en dólares, con decimales. null si no se lee.
- detectedBank: banco de origen o destino que se lee.
- detectedReference: número de comprobante, referencia o documento.
- summary: una frase en español para el equipo (banco, monto, fecha, destinatario). No apruebes ni rechaces: solo describe.`;

/** Lectura del comprobante para ayudar a quien lo revisa. null sin IA o si es PDF. */
export async function readReceipt(
  file: MediaFile,
  expected: { total: number; orderNumber: string },
): Promise<ReceiptReading | null> {
  if (!file.mimeType.startsWith("image/")) return null;
  const parsed = await geminiJson<any>({
    system: RECEIPT_PROMPT,
    text: `Pedido ${expected.orderNumber}. Monto esperado: $${(expected.total / 100).toFixed(2)}.`,
    image: { mimeType: file.mimeType, base64: file.buffer.toString("base64") },
    maxOutputTokens: 400,
    timeoutMs: 15000,
  });
  if (!parsed) return null;
  const amount =
    parsed.detectedAmount !== null && Number.isFinite(Number(parsed.detectedAmount))
      ? Math.round(Number(parsed.detectedAmount) * 100)
      : null;
  return {
    isReceipt: typeof parsed.isReceipt === "boolean" ? parsed.isReceipt : null,
    detectedAmount: amount,
    detectedBank: String(parsed.detectedBank || "").slice(0, 80),
    detectedReference: String(parsed.detectedReference || "").slice(0, 80),
    summary: String(parsed.summary || "").slice(0, 300),
  };
}
