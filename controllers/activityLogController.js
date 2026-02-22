import { getActivityLog, deleteActivity, deleteAllActivities } from "../models/activityLogModel.js";

// Get activity log with pagination and filters
export const getActivityLogController = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 25,
      search = "",
      startDate = "",
      endDate = "",
    } = req.query;

    const result = await getActivityLog({
      page: parseInt(page),
      limit: parseInt(limit),
      search,
      startDate,
      endDate,
    });

    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    console.error("Error fetching activity log:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch activity log",
    });
  }
};

// Delete a specific activity
export const deleteActivityController = async (req, res) => {
  try {
    
    const { id } = req.params;
    const activityId = parseInt(id);

    if (isNaN(activityId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid activity ID",
      });
    }

    const deleted = await deleteActivity(activityId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Activity not found",
      });
    }

    res.json({
      success: true,
      message: "Activity deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting activity:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete activity",
    });
  }
};

// Delete all activities
export const deleteAllActivitiesController = async (req, res) => {
  try {
    const deletedCount = await deleteAllActivities();

    res.json({
      success: true,
      message: `Successfully deleted ${deletedCount} activities`,
      deletedCount,
    });
  } catch (error) {
    console.error("Error deleting all activities:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete all activities",
    });
  }
};
