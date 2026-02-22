import express from "express";
import {
  getActivityLogController,
  deleteActivityController,
  deleteAllActivitiesController,
} from "../controllers/activityLogController.js";
import authenticate from "../middlewares/authMiddleware.js";
import { adminOnly } from "../middlewares/roleMiddleware.js";

const router = express.Router();

// Get activity log with pagination and filters
router.get("/",authenticate, adminOnly, getActivityLogController);

// Delete a specific activity
router.delete("/:id", authenticate, adminOnly, deleteActivityController);

// Delete all activities
// router.delete("/delete-all", authenticate, adminOnly, deleteAllActivitiesController);

export default router;
