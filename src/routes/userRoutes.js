import express from "express";
const router = express.Router();

router.get("/", (req, res) => {
  res.send("Backend is running and connected to MySQL!");
});

export default router;
