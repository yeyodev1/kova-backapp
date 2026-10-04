import { Router } from "express";
import * as whatsappBotController from "../controllers/whatsappBot.controller";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { authMiddleware } from "../middlewares/auth.middleware";
import { botTokenMiddleware } from "../middlewares/botToken.middleware";

/**
 * Bot de WhatsApp (BuilderBot Cloud). Los endpoints del bot siempre responden
 * 200; ver docs/WHATSAPP-BOT.md. El panel usa /admin/* con sesión de admin.
 */
const router = Router();

const admin = Router();
admin.use(authMiddleware, adminMiddleware);
admin.get("/events", whatsappBotController.adminEvents);
admin.get("/sessions", whatsappBotController.adminSessions);
admin.post("/sessions/:phone/reset", whatsappBotController.adminReset);
admin.post("/sessions/:phone/silence", whatsappBotController.adminSilence);
admin.post("/sessions/:phone/unsilence", whatsappBotController.adminUnsilence);
admin.get("/config", whatsappBotController.adminConfig);
router.use("/admin", admin);

// Flujo principal: solo decide la ruta (no responde al cliente).
router.all("/brain", botTokenMiddleware, whatsappBotController.brain);
// Flujos destino: procesan el mensaje y responden en `message`.
router.all("/conversation", botTokenMiddleware, whatsappBotController.turn);
router.all("/checkout", botTokenMiddleware, whatsappBotController.turn);
router.all("/search-order", botTokenMiddleware, whatsappBotController.turn);
router.all("/human", botTokenMiddleware, whatsappBotController.turn);
router.all("/catalog", botTokenMiddleware, whatsappBotController.catalog);
router.all("/media", botTokenMiddleware, whatsappBotController.media);
router.all("/transfer-receipt", botTokenMiddleware, whatsappBotController.media);

export default router;
