import { Request, Response, NextFunction } from "express";
import * as dropiStatusService from "../services/dropiStatus.service";
import * as dropiSyncService from "../services/dropiSync.service";

/** GET /api/admin/dropi/status?refresh=1 */
export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    res.status(200).json(await dropiStatusService.getStatus(refresh));
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/dropi/products?q&page&limit */
export async function searchCatalog(req: Request, res: Response, next: NextFunction) {
  try {
    const q = String(req.query.q ?? "").trim();
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    res.status(200).json(await dropiSyncService.searchCatalog(q, page, limit));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/dropi/import — body: { dropiId? | url?, markupPercent? } */
export async function importProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { dropiId, url, markupPercent } = req.body ?? {};
    const markup =
      markupPercent === undefined || markupPercent === null || markupPercent === ""
        ? undefined
        : Number(markupPercent);
    const id = dropiSyncService.parseDropiReference(dropiId, url);
    res.status(200).json(await dropiSyncService.importProduct(id, markup));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/products/:id/sync-dropi */
export async function syncProduct(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await dropiSyncService.syncProduct(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/dropi/sync-products y GET /api/cron/dropi-products */
export async function syncProducts(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await dropiSyncService.syncProducts());
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/dropi/sync-locations */
export async function syncLocations(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await dropiSyncService.syncLocations());
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/dropi/sync-orders y GET /api/cron/dropi-orders */
export async function syncOrders(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await dropiSyncService.syncOrders());
  } catch (error) {
    next(error);
  }
}
