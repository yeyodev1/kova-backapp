import { Router } from "express";
import * as orderController from "../controllers/order.controller";
import { rateLimit } from "../middlewares/rateLimit.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";

const router = Router();

router.post("/", rateLimit({ max: 10, windowMs: 10 * 60 * 1000 }), orderController.create);
router.post("/confirm", orderController.confirm);
router.get("/track", orderController.track);
router.post("/:number/receipt", uploadMiddleware.single("receipt"), orderController.receipt);

export default router;
