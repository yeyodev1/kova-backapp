import { Router } from "express";
import * as storeController from "../controllers/store.controller";

const router = Router();

router.get("/settings", storeController.settings);

export default router;
