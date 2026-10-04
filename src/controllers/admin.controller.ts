import { Request, Response, NextFunction } from "express";
import * as adminService from "../services/admin.service";
import * as dropiManualService from "../services/dropiManual.service";
import * as orderExportService from "../services/orderExport.service";
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

/** POST /api/admin/products — crear producto manual */
export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await adminService.createProduct(req.body));
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/products/categories */
export async function productCategories(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.productCategories());
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/uploads/image (multipart `image`) */
export async function uploadImage(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await adminService.uploadProductImage(req.file));
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

/** POST /api/admin/orders/:id/dropi-manual — { dropiOrderId?, guide?, carrier? } */
export async function markCreatedInDropi(req: Request, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(await dropiManualService.markCreatedInDropi(String(req.params.id), req.body));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/orders/:id/shipping — { guide?, carrier?, status? } */
export async function updateShipping(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await dropiManualService.updateShipping(String(req.params.id), req.body));
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/orders/export?status&from&to&ids&paymentMethod&q — CSV para Dropi */
export async function exportOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const { filename, content, orders } = await orderExportService.exportOrdersCsv(req.query);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Orders-Count", String(orders));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Orders-Count");
    res.status(200).send(content);
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

/** GET /api/admin/team */
export async function listTeam(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.listTeam());
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/team/:id  { notifyHumanRequests } */
export async function updateTeamMember(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await adminService.updateTeamMember(String(req.params.id), req.body));
  } catch (error) {
    next(error);
  }
}
