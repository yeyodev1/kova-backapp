import "dotenv/config";

/**
 * Único lugar que lee process.env. Leerlo en otro archivo a nivel de módulo
 * es el bug clásico de "la variable está en .env pero llega undefined".
 */

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function list(key: string): string[] {
  return optional(key, "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export const env = {
  PORT: Number(optional("PORT", "8100")),
  NODE_ENV: optional("NODE_ENV", "development"),
  IS_VERCEL: Boolean(process.env.VERCEL),
  DB_URI: required("DB_URI"),
  JWT_SECRET: required("JWT_SECRET"),
  CORS_ORIGINS: list("CORS_ORIGINS"),
  FRONTEND_URL: optional("FRONTEND_URL", "http://localhost:5173"),
  SLACK_ERROR_WEBHOOK: optional("SLACK_ERROR_WEBHOOK", ""),
  ADMIN_EMAIL: optional("ADMIN_EMAIL", "admin@kovashopper.com").toLowerCase(),
  ADMIN_PASSWORD: optional("ADMIN_PASSWORD", ""),
  ADMIN_NAME: optional("ADMIN_NAME", "Administración"),
  RESEND_API_KEY: optional("RESEND_API_KEY", ""),
  RESEND_FROM_EMAIL: optional("RESEND_FROM_EMAIL", "Kova <onboarding@resend.dev>"),
  CLOUDINARY_CLOUD_NAME: optional("CLOUDINARY_CLOUD_NAME", ""),
  CLOUDINARY_API_KEY: optional("CLOUDINARY_API_KEY", ""),
  CLOUDINARY_API_SECRET: optional("CLOUDINARY_API_SECRET", ""),
  CRON_SECRET: optional("CRON_SECRET", ""),
  // Dropi Ecuador: el token sale de Mis integraciones en dropi.ec
  DROPI_API_URL: optional("DROPI_API_URL", "https://api.dropi.ec/integrations"),
  DROPI_INTEGRATION_KEY: optional("DROPI_INTEGRATION_KEY", ""),
  PAYPHONE_TOKEN: optional("PAYPHONE_TOKEN", ""),
  PAYPHONE_STORE_ID: optional("PAYPHONE_STORE_ID", ""),
  // Bot de WhatsApp (BuilderBot Cloud + Gemini). Sin GEMINI_API_KEY el bot sigue con reglas.
  GEMINI_API_KEY: optional("GEMINI_API_KEY", ""),
  GEMINI_MODEL: optional("GEMINI_MODEL", "gemini-2.5-flash"),
  BOT_NAME: optional("BOT_NAME", "Kova"),
  BOT_AI_VOICE: optional("BOT_AI_VOICE", "on"),
  BOT_SUPPORT_PHONE: optional("BOT_SUPPORT_PHONE", ""),
  WHATSAPP_BOT_SECRET: optional("WHATSAPP_BOT_SECRET", ""),
  // Solo fuera de producción: fija el teléfono para probar desde Postman/Telegram.
  BOT_TEST_PHONE: optional("BOT_TEST_PHONE", ""),
  PUBLIC_WEB_URL: optional("PUBLIC_WEB_URL", "https://kovashopper.com"),
  // API de Conversiones de Meta: token de Events Manager → píxel → Configuración.
  // Sin token no se envía nada. TEST_CODE solo para probar en "Eventos de prueba".
  META_PIXEL_ID: optional("META_PIXEL_ID", ""),
  META_CAPI_TOKEN: optional("META_CAPI_TOKEN", ""),
  META_CAPI_TEST_CODE: optional("META_CAPI_TEST_CODE", ""),
} as const;
