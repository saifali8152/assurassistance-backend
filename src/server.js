import dotenv from "dotenv";
dotenv.config();

import express from "express";
import mysql from "mysql2";
import userRoutes from "./routes/userRoutes.js"; // ⬅️ Import your route file

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware for JSON
app.use(express.json());

// MySQL connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err.message);
  } else {
    console.log("Connected to MySQL successfully!");
  }
});

// ⬅️ Register routes
app.use("/api/users", userRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
