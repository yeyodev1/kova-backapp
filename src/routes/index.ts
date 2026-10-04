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
import seoRoutes from "./seo.routes";

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
  router.use("/admin", adminRoutes);
  router.use("/seo", seoRoutes);
}

export default routerApi;
