import { Request, Response, NextFunction } from "express";
import * as adminService from "../services/admin.service";
import * as orderService from "../services/order.service";

/** GET /api/admin/dashboard */
export async function dashboard(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.dashboard());
  } catch (error) {
    next(error);
  }
}

// ── Productos ───────────────────────────────────────────────────────────────

/** GET /api/admin/products?q&page&published */
export async function listProducts(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.listProducts(req.query));
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/products/:id */
export async function getProduct(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.getProduct(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/products/:id */
export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.updateProduct(String(req.params.id), req.body));
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/admin/products/:id */
export async function deleteProduct(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.deleteProduct(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/products/:id/images — multipart: image */
export async function addProductImage(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.addProductImage(String(req.params.id), req.file));
  } catch (error) {
    next(error);
  }
}

// ── Pedidos ─────────────────────────────────────────────────────────────────

/** GET /api/admin/orders?status&paymentMethod&q&page */
export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.listOrders(req.query));
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/orders/:id */
export async function getOrder(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.getOrder(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/orders/:id/confirm-transfer */
export async function confirmTransfer(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await orderService.confirmTransfer(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/orders/:id/send-to-dropi */
export async function sendToDropi(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await orderService.sendToDropi(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/orders/:id/cancel */
export async function cancelOrder(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await orderService.cancelOrder(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

// ── Carritos y configuración ────────────────────────────────────────────────

/** GET /api/admin/leads?page */
export async function listLeads(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.listLeads(req.query));
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/settings */
export async function getSettings(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.getAdminSettings());
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/settings */
export async function updateSettings(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.updateSettings(req.body));
  } catch (error) {
    next(error);
  }
}
