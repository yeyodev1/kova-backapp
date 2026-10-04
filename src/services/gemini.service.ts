import axios from "axios";
import { env } from "../config/env";

/**
 * Cliente mínimo de Gemini (REST, sin SDK). Devuelve el JSON que pide el
 * prompt o `null` si no hay llave, si tarda o si la respuesta no se puede
 * leer: quien llama siempre tiene un plan B con reglas.
 */

export const geminiEnabled = () => Boolean(env.GEMINI_API_KEY);

// Fallos seguidos (por instancia): el bot sigue con reglas, pero si se repiten alguien
// tiene que mirar la llave o la cuota.
const health = { failures: 0, lastError: "" };

/** Fallos consecutivos de Gemini y el último error. */
export const geminiHealth = () => ({ ...health });

export interface GeminiJsonRequest {
  system: string;
  text: string;
  image?: { mimeType: string; base64: string };
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export async function geminiJson<T = any>(request: GeminiJsonRequest): Promise<T | null> {
  if (!env.GEMINI_API_KEY) return null;

  const parts: any[] = [{ text: request.text }];
  if (request.image) {
    parts.push({ inline_data: { mime_type: request.image.mimeType, data: request.image.base64 } });
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          maxOutputTokens: request.maxOutputTokens ?? 800,
          // Sin "thinking": cada segundo cuenta contra el timeout de BuilderBot.
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      {
        // La llave va en header y no en la URL: así no queda en logs de errores.
        headers: { "x-goog-api-key": env.GEMINI_API_KEY },
        timeout: request.timeoutMs ?? 12000,
      },
    );
    const output: string =
      response.data?.candidates?.[0]?.content?.parts
        ?.map((part: any) => part.text || "")
        .join("") || "";
    const json = output.match(/\{[\s\S]*\}/)?.[0];
    health.failures = 0;
    return json ? (JSON.parse(json) as T) : null;
  } catch (error: any) {
    const message = error?.response?.data?.error?.message || error?.message || String(error);
    health.failures += 1;
    health.lastError = String(message).slice(0, 300);
    console.error("[gemini] falló la llamada:", message);
    return null;
  }
}
