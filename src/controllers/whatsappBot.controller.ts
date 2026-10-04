import { Request, Response, NextFunction } from "express";
import * as botAdminService from "../services/botAdmin.service";
import * as whatsappBotService from "../services/whatsappBot.service";

/** Body + query: BuilderBot a veces manda los campos por query. */
const input = (req: Request) => ({ ...(req.query || {}), ...(req.body || {}) });

/** Nombre del endpoint que llamó (conversation, checkout, media…), para la bitácora. */
const endpointOf = (req: Request) => req.path.split("/").filter(Boolean).pop() || "turn";

/** POST /whatsapp-bot/brain — siempre 200. */
export async function brain(req: Request, res: Response) {
  try {
    res.status(200).json(await whatsappBotService.decide(input(req)));
  } catch (error) {
    console.error("[whatsapp-bot] error en brain:", error);
    // Ante cualquier falla, a conversación: ese flujo siempre responde algo.
    res.status(200).json({ ...whatsappBotService.errorResponse(), message: "" });
  }
}

/** /conversation, /checkout, /search-order, /human — siempre 200. */
export async function turn(req: Request, res: Response) {
  try {
    res.status(200).json(await whatsappBotService.turn(input(req), endpointOf(req)));
  } catch (error) {
    console.error("[whatsapp-bot] error en el turno:", error);
    res.status(200).json(whatsappBotService.errorResponse());
  }
}

/** /media (alias /transfer-receipt) — siempre 200. */
export async function media(req: Request, res: Response) {
  try {
    res.status(200).json(await whatsappBotService.media(input(req), endpointOf(req)));
  } catch (error) {
    console.error("[whatsapp-bot] error en media:", error);
    res.status(200).json(whatsappBotService.errorResponse());
  }
}

/** GET|POST /catalog — siempre 200. */
export async function catalog(req: Request, res: Response) {
  try {
    res.status(200).json(await whatsappBotService.catalog(input(req)));
  } catch (error) {
    console.error("[whatsapp-bot] error en catalog:", error);
    res.status(200).json(whatsappBotService.errorResponse());
  }
}

// ── Admin ───────────────────────────────────────────────────────────────────

export async function adminEvents(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await botAdminService.listEvents(req.query as Record<string, unknown>));
  } catch (error) {
    next(error);
  }
}

export async function adminSessions(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await botAdminService.listSessions(req.query as Record<string, unknown>));
  } catch (error) {
    next(error);
  }
}

export async function adminConversation(req: Request, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(
        await botAdminService.getConversation(
          req.params.phone,
          req.query as Record<string, unknown>,
        ),
      );
  } catch (error) {
    next(error);
  }
}

export async function adminReset(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await botAdminService.resetSession(req.params.phone));
  } catch (error) {
    next(error);
  }
}

export async function adminSilence(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await botAdminService.silenceSession(req.params.phone, req.body?.minutes));
  } catch (error) {
    next(error);
  }
}

export async function adminUnsilence(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await botAdminService.unsilenceSession(req.params.phone));
  } catch (error) {
    next(error);
  }
}

export async function adminConfig(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(botAdminService.getConfig());
  } catch (error) {
    next(error);
  }
}
