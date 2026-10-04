import { Request, Response, NextFunction } from "express";
import * as storeService from "../services/store.service";

/** GET /api/store/settings */
export async function settings(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await storeService.publicSettings());
  } catch (error) {
    next(error);
  }
}
