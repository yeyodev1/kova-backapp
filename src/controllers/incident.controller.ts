import { NextFunction, Request, Response } from "express";
import * as incidentsService from "../services/incidents.service";
import { AuthRequest } from "../types/AuthRequest";

/** GET /api/admin/incidents?status&type&severity&q&page */
export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await incidentsService.listIncidents(req.query));
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/incidents/summary */
export async function summary(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await incidentsService.incidentSummary());
  } catch (error) {
    next(error);
  }
}

/** GET /api/admin/incidents/:id */
export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await incidentsService.getIncident(String(req.params.id)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/incidents */
export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res
      .status(201)
      .json(await incidentsService.createIncident(req.body, String(req.user?.userId || "")));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/admin/incidents/:id { status?, assignee?, severity? } */
export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res
      .status(200)
      .json(
        await incidentsService.updateIncident(
          String(req.params.id),
          req.body,
          String(req.user?.userId || ""),
        ),
      );
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/incidents/:id/notes { text } */
export async function addNote(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res
      .status(201)
      .json(
        await incidentsService.addIncidentNote(
          String(req.params.id),
          req.body,
          String(req.user?.userId || ""),
        ),
      );
  } catch (error) {
    next(error);
  }
}

/** GET /api/cron/incidents-sweep */
export async function sweep(_req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await incidentsService.sweepIncidents());
  } catch (error) {
    next(error);
  }
}
