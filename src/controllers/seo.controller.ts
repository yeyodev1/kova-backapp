import { Request, Response, NextFunction } from "express";
import * as seoService from "../services/seo.service";

/** GET /api/seo/sitemap.xml — el front lo expone como /sitemap.xml con un rewrite. */
export async function sitemap(_req: Request, res: Response, next: NextFunction) {
  try {
    const xml = await seoService.sitemap();
    res
      .status(200)
      .set("Content-Type", "application/xml; charset=utf-8")
      .set("Cache-Control", "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400")
      .send(xml);
  } catch (error) {
    next(error);
  }
}
