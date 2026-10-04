import { Request, Response, NextFunction } from "express";

/**
 * Rate limit en memoria por IP. En Vercel cada instancia lleva su propia cuenta,
 * así que es un freno a ráfagas y bots simples, no un límite exacto.
 */
export function rateLimit(options: { max: number; windowMs: number }) {
  const hits = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    const ip = forwarded || req.ip || req.socket.remoteAddress || "unknown";

    const recent = (hits.get(ip) || []).filter((t) => now - t < options.windowMs);
    if (recent.length >= options.max) {
      hits.set(ip, recent);
      res
        .status(429)
        .json({ message: "Demasiados intentos. Espera unos minutos y vuelve a intentarlo" });
      return;
    }
    recent.push(now);
    hits.set(ip, recent);

    // Limpieza ocasional para que el mapa no crezca sin fin.
    if (hits.size > 5000) {
      for (const [key, times] of hits) {
        if (!times.some((t) => now - t < options.windowMs)) hits.delete(key);
      }
    }
    next();
  };
}
