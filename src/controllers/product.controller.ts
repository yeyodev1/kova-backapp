import { Request, Response, NextFunction } from "express";
import * as productService from "../services/product.service";

/** GET /api/products?page&limit&category&q&featured&sort */
export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await productService.listPublic(req.query));
  } catch (error) {
    next(error);
  }
}

/** GET /api/products/categories */
export async function categories(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await productService.categories());
  } catch (error) {
    next(error);
  }
}

/** GET /api/products/:slug */
export async function bySlug(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await productService.getBySlug(String(req.params.slug)));
  } catch (error) {
    next(error);
  }
}
