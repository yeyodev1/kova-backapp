import { NextFunction, Request, Response } from "express";
import * as paymentsService from "../services/payments.service";

/** GET /api/admin/payments */
export async function get(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await paymentsService.getPayments());
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/payments */
export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await paymentsService.updatePayments(req.body));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/payments/accounts */
export async function createAccount(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await paymentsService.createAccount(req.body));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/payments/accounts/:id */
export async function updateAccount(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await paymentsService.updateAccount(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/admin/payments/accounts/:id */
export async function deleteAccount(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await paymentsService.deleteAccount(req.params.id));
  } catch (error) {
    next(error);
  }
}
