import { Router } from "express";
import * as paymentsController from "../controllers/payments.controller";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { authMiddleware } from "../middlewares/auth.middleware";

// Pagos y bancos: separado de /admin/settings para que haya un solo lugar que edita las cuentas.
const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get("/", paymentsController.get);
router.put("/", paymentsController.update);
router.post("/accounts", paymentsController.createAccount);
router.put("/accounts/:id", paymentsController.updateAccount);
router.delete("/accounts/:id", paymentsController.deleteAccount);

export default router;
