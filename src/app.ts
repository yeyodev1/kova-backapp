import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import http from "http";
import routerApi from "./routes";
import { env } from "./config/env";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.middleware";

const whitelist = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://localhost:8100",
  "http://localhost:8101",
  "https://kovashopper.com",
  "https://www.kovashopper.com",
  ...env.CORS_ORIGINS,
];

/** Previews de Vercel y túneles de desarrollo: permitidos. */
const allowedPatterns: RegExp[] = [
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/i,
  /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i,
  /^https:\/\/[a-z0-9-]+\.bakano\.ec$/i,
];

function isOriginAllowed(origin: string): boolean {
  if (whitelist.includes(origin)) return true;
  return allowedPatterns.some((p) => p.test(origin));
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Sin Origin (curl, server-to-server, Vercel Cron) se deja pasar.
    if (!origin || isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};

const BOT_PATH = "/api/whatsapp-bot";

/**
 * Texto que en realidad es JSON (nodo con RAW encendido) se convierte en objeto, y si aun así
 * no llega el teléfono se deja rastro en los logs de Vercel con las claves recibidas.
 */
function botBodyFallback(req: Request, _res: Response, next: NextFunction) {
  if (typeof req.body === "string") {
    const raw = req.body.trim();
    try {
      req.body = raw ? JSON.parse(raw) : {};
    } catch {
      req.body = { rawMessage: raw };
    }
  }
  if (req.method === "POST" && !req.path.startsWith("/admin")) {
    const body = req.body || {};
    if (!body.phone && !body.from && !body.telefono) {
      console.warn(
        `[whatsapp-bot] ${req.path} sin teléfono. content-type=${req.headers["content-type"] || "-"} claves=${Object.keys(body).join(",") || "(vacío)"}`,
      );
    }
  }
  next();
}

export function createApp() {
  const app = express();
  // Vercel va delante como proxy: sin esto req.ip sería la IP del proxy.
  app.set("trust proxy", 1);

  app.use(cors(corsOptions));
  app.use(express.json({ limit: "50mb" }));
  // BuilderBot puede mandar el cuerpo como formulario o como texto según cómo se arme el nodo
  // HTTP. Para las rutas del bot se aceptan los tres formatos, como en Megaprinter.
  app.use(BOT_PATH, express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(BOT_PATH, express.text({ type: ["text/plain", "text/*"], limit: "2mb" }));
  app.use(BOT_PATH, botBodyFallback);

  app.get("/", (_req, res) => {
    res.send("Server is alive");
  });

  routerApi(app);

  app.use(globalErrorHandler);

  const server = http.createServer(app);

  return { app, server };
}
