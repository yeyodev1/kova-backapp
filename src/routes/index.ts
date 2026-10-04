import express, { Application } from "express";
import authRoutes from "./auth.routes";
import healthRoutes from "./health.routes";
import cronRoutes from "./cron.routes";
import storeRoutes from "./store.routes";
import productRoutes from "./product.routes";
import locationRoutes from "./location.routes";
import checkoutRoutes from "./checkout.routes";
import orderRoutes from "./order.routes";
import adminRoutes from "./admin.routes";
import paymentsRoutes from "./payments.routes";
import seoRoutes from "./seo.routes";
import whatsappBotRoutes from "./whatsappBot.routes";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/health", healthRoutes);
  router.use("/auth", authRoutes);
  router.use("/cron", cronRoutes);
  router.use("/store", storeRoutes);
  router.use("/products", productRoutes);
  router.use("/locations", locationRoutes);
  router.use("/checkout", checkoutRoutes);
  router.use("/orders", orderRoutes);
  // Antes de /admin para no pasar dos veces por su auth.
  router.use("/admin/payments", paymentsRoutes);
  router.use("/admin", adminRoutes);
  router.use("/seo", seoRoutes);
  router.use("/whatsapp-bot", whatsappBotRoutes);
}

export default routerApi;
