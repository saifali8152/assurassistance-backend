import dotenv from "dotenv";
dotenv.config();

import express from "express";
import userRoutes from "./routes/userRoutes.js";
import pool from "./db.js"; 

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// Register routes
app.use("/api/users", userRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
