import { Router } from "express";
import * as locationController from "../controllers/location.controller";

const router = Router();

router.get("/provinces", locationController.provinces);
router.get("/provinces/:id/cities", locationController.cities);

export default router;
