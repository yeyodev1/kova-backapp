import { Router, Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { dbConnect, isConnected } from "../config/mongo";
import { CustomError } from "../errors/customError.error";
import * as dropiController from "../controllers/dropi.controller";
import * as incidentController from "../controllers/incident.controller";

const router = Router();

/**
 * Solo Vercel Cron puede disparar esto.
 *
 * Vercel manda `Authorization: Bearer $CRON_SECRET` en cada corrida. Sin el
 * secreto configurado la ruta queda cerrada: es preferible que la tarea no
 * ocurra a que cualquiera desde internet pueda dispararla.
 */
function soloCron(req: Request, _res: Response, next: NextFunction) {
  if (!env.CRON_SECRET) {
    return next(new CustomError("CRON_SECRET no está configurado", 503));
  }
  if (req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) {
    return next(new CustomError("No autorizado", 401));
  }
  next();
}

async function conBaseDeDatos(_req: Request, _res: Response, next: NextFunction) {
  try {
    if (!isConnected() && !(await dbConnect())) {
      throw new CustomError("Sin base de datos", 503);
    }
    next();
  } catch (error) {
    next(error);
  }
}

// Vercel Cron solo hace GET, de ahí el verbo aunque las tareas escriban.

/** GET /api/cron/dropi-orders — cada hora: estados y guías. */
router.get("/dropi-orders", soloCron, conBaseDeDatos, dropiController.syncOrders);

/** GET /api/cron/dropi-products — cada 6 horas: stock y costo. */
router.get("/dropi-products", soloCron, conBaseDeDatos, dropiController.syncProducts);

/** GET /api/cron/incidents-sweep — cada hora: comprobantes sin revisar y pedidos sin guía. */
router.get("/incidents-sweep", soloCron, conBaseDeDatos, incidentController.sweep);

export default router;
