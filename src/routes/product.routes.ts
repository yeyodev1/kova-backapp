import { Router } from "express";
import * as productController from "../controllers/product.controller";

const router = Router();

router.get("/", productController.list);
// Antes de /:slug para que "categories" no se lea como slug.
router.get("/categories", productController.categories);
router.get("/:slug", productController.bySlug);

export default router;
