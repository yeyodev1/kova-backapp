import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { unauthorizedResponse } from "../services/whatsappBot.service";

/**
 * Con WHATSAPP_BOT_SECRET, BuilderBot debe mandar `X-Bot-Token`. Responde 200
 * igual (BuilderBot no maneja errores), pero sin procesar nada.
 */
export function botTokenMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!env.WHATSAPP_BOT_SECRET) return next();
  const given = Buffer.from(String(req.headers["x-bot-token"] || ""));
  const expected = Buffer.from(env.WHATSAPP_BOT_SECRET);
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
  console.warn("[whatsapp-bot] X-Bot-Token inválido o ausente");
  res.status(200).json(unauthorizedResponse());
}
