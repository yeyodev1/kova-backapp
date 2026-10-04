import { Router } from "express";
import * as seoController from "../controllers/seo.controller";

const router = Router();

router.get("/sitemap.xml", seoController.sitemap);

export default router;
