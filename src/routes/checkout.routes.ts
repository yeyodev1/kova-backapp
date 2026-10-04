import { Router } from "express";
import * as checkoutController from "../controllers/checkout.controller";
import { rateLimit } from "../middlewares/rateLimit.middleware";

const router = Router();

router.post("/quote", checkoutController.quote);
router.post("/lead", rateLimit({ max: 10, windowMs: 10 * 60 * 1000 }), checkoutController.lead);

export default router;
