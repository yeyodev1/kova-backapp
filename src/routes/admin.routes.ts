import { Router } from "express";
import * as adminController from "../controllers/admin.controller";
import * as dropiController from "../controllers/dropi.controller";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { authMiddleware } from "../middlewares/auth.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get("/dashboard", adminController.dashboard);

router.get("/dropi/products", dropiController.searchCatalog);
router.post("/dropi/import", dropiController.importProduct);
router.post("/dropi/sync-products", dropiController.syncProducts);
router.post("/dropi/sync-locations", dropiController.syncLocations);
router.post("/dropi/sync-orders", dropiController.syncOrders);

router.get("/products", adminController.listProducts);
router.post("/products", adminController.createProduct);
router.get("/products/:id", adminController.getProduct);
router.put("/products/:id", adminController.updateProduct);
router.delete("/products/:id", adminController.deleteProduct);
router.post(
  "/products/:id/images",
  uploadMiddleware.single("image"),
  adminController.addProductImage,
);

router.get("/orders", adminController.listOrders);
router.get("/orders/:id", adminController.getOrder);
router.post("/orders/:id/confirm-transfer", adminController.confirmTransfer);
router.post("/orders/:id/send-to-dropi", adminController.sendToDropi);
router.post("/orders/:id/cancel", adminController.cancelOrder);

router.get("/leads", adminController.listLeads);

router.get("/settings", adminController.getSettings);
router.put("/settings", adminController.updateSettings);

export default router;
