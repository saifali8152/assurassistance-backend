// src/server.js
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import './db.js'
import authRoutes from './routes/authRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import userRoutes from './routes/userRoutes.js';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);

app.get('/', (req, res) => res.send('Assur Assistance Backend is running'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
