import { Request, Response, NextFunction } from "express";
import * as orderService from "../services/order.service";

/** POST /api/orders — body: { items, paymentMethod, customer, address, notes?, utm? } */
export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await orderService.createOrder(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** POST /api/orders/confirm — body: { id, clientTransactionId } (respuesta de Payphone) */
export async function confirm(req: Request, res: Response, next: NextFunction) {
  try {
    const { id, clientTransactionId } = req.body ?? {};
    res.status(200).json(await orderService.confirmPayphone(id, clientTransactionId));
  } catch (error) {
    next(error);
  }
}

/** POST /api/orders/:number/receipt — multipart: receipt + phone */
export async function receipt(req: Request, res: Response, next: NextFunction) {
  try {
    const order = await orderService.uploadReceipt(req.params.number, req.body?.phone, req.file);
    res.status(200).json(order);
  } catch (error) {
    next(error);
  }
}

/** GET /api/orders/track?number&phone */
export async function track(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await orderService.track(req.query.number, req.query.phone));
  } catch (error) {
    next(error);
  }
}

/** GET /api/orders/pay/:token — link privado de pago */
export async function payByToken(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await orderService.getPayOrder(req.params.token));
  } catch (error) {
    next(error);
  }
}
