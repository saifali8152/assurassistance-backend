import express from "express";
import pool from "../db.js";

const router = express.Router();

router.get("/", (req, res) => {
  pool.query("SELECT 'Backend is running and connected to MySQL!' AS message", (err, results) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(results[0]);
  });
});

export default router;
