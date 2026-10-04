import { Request, Response, NextFunction } from "express";
import * as checkoutService from "../services/checkout.service";

/** POST /api/checkout/quote — body: { items, paymentMethod } */
export async function quote(req: Request, res: Response, next: NextFunction) {
  try {
    const { items, paymentMethod } = req.body ?? {};
    res.status(200).json(await checkoutService.quote(items, paymentMethod));
  } catch (error) {
    next(error);
  }
}

/** POST /api/checkout/lead — body: { phone, firstName?, items } */
export async function lead(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await checkoutService.saveLead(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}
