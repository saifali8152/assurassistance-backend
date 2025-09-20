// src/server.js
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors'; 
import './db.js';
import authRoutes from './routes/authRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import userRoutes from './routes/userRoutes.js';
import caseRoutes from "./routes/caseRoutes.js";
import salesRoute from "./routes/salesRoute.js";
import catalogueRoutes from './routes/catalogueRoutes.js';
const app = express();
const PORT = process.env.PORT || 5000;

// ✅ Enable CORS for frontend
app.use(cors({
  origin: "http://localhost:5173", // frontend URL
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  credentials: true
}));

// Middleware
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/catalogue', catalogueRoutes);
app.use("/api/cases", caseRoutes);
app.use("/api/sales",salesRoute)
app.get('/', (req, res) => res.send('Assur Assistance Backend is running'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
