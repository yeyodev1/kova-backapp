import { Request, Response, NextFunction } from "express";
import * as locationService from "../services/location.service";

/** GET /api/locations/provinces */
export async function provinces(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await locationService.getProvinces());
  } catch (error) {
    next(error);
  }
}

/** GET /api/locations/provinces/:id/cities */
export async function cities(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await locationService.getCities(Number(req.params.id) || 0));
  } catch (error) {
    next(error);
  }
}
