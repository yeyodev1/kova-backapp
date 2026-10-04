import { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import * as adminController from "../controllers/admin.controller";
import * as dropiController from "../controllers/dropi.controller";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { authMiddleware } from "../middlewares/auth.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";
import { CustomError } from "../errors/customError.error";

const router = Router();

/** Multer con mensajes en español: sin esto un archivo grande cae como 500 en inglés. */
function singleImage(req: Request, res: Response, next: NextFunction) {
  uploadMiddleware.single("image")(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return next(new CustomError("La foto pesa más de 10 MB. Prueba con una más liviana", 413));
    }
    if (error instanceof multer.MulterError) {
      return next(new CustomError("Envía una sola foto en el campo image", 400));
    }
    next(error);
  });
}

router.use(authMiddleware, adminMiddleware);

router.get("/dashboard", adminController.dashboard);

router.get("/dropi/status", dropiController.status);
router.get("/dropi/products", dropiController.searchCatalog);
router.post("/dropi/import", dropiController.importProduct);
router.post("/dropi/clip", dropiController.clip);
router.get("/dropi/linked", dropiController.linked);
router.post("/dropi/sync-products", dropiController.syncProducts);
router.post("/dropi/sync-locations", dropiController.syncLocations);
router.post("/dropi/sync-orders", dropiController.syncOrders);

router.get("/products", adminController.listProducts);
router.post("/products", adminController.createProduct);
// Antes de /products/:id para que "categories" no se tome como id.
router.get("/products/categories", adminController.productCategories);
router.get("/products/:id", adminController.getProduct);
router.put("/products/:id", adminController.updateProduct);
router.delete("/products/:id", adminController.deleteProduct);
router.post("/products/:id/sync-dropi", dropiController.syncProduct);
router.post(
  "/products/:id/images",
  singleImage,
  adminController.addProductImage,
);
router.post("/uploads/image", singleImage, adminController.uploadImage);

router.get("/orders", adminController.listOrders);
// Antes de /orders/:id para que "export" no se tome como id.
router.get("/orders/export", adminController.exportOrders);
router.get("/orders/:id", adminController.getOrder);
router.post("/orders/:id/dropi-manual", adminController.markCreatedInDropi);
router.put("/orders/:id/shipping", adminController.updateShipping);
router.post("/orders/:id/confirm-transfer", adminController.confirmTransfer);
router.post("/orders/:id/send-to-dropi", adminController.sendToDropi);
router.post("/orders/:id/cancel", adminController.cancelOrder);

router.get("/leads", adminController.listLeads);

router.get("/settings", adminController.getSettings);
router.put("/settings", adminController.updateSettings);

export default router;
