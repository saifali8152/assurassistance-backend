import dotenv from 'dotenv';

const originalConsoleLog = console.log;
console.log = () => {};
dotenv.config();
console.log = originalConsoleLog;

import express from 'express';
import cors from 'cors'; 
import { initializePool } from './utils/db.js';
import { initializeEmailTransporter } from './utils/emailService.js';

import { fileURLToPath } from "url";
import path from 'path';
import authRoutes from './routes/authRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import userRoutes from './routes/userRoutes.js';
import caseRoutes from "./routes/caseRoutes.js";
import salesRoute from "./routes/salesRoute.js";
import catalogueRoutes from './routes/catalogueRoutes.js';
import ledgerRoutes from './routes/ledgerRoute.js';
import reconciliationRoute from './routes/reconciliationRoute.js';
import activityLogRoutes from './routes/activityLogRoute.js';

// Initialize database pool
const pool = initializePool({
  DB_HOST: process.env.DB_HOST,
  DB_PORT: Number(process.env.DB_PORT || 3306),
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_NAME: process.env.DB_NAME
});

pool.getConnection((err, connection) => {
  if (err) {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  } else {
    console.log('✅ Connected to MySQL database');
    connection.release();
  }
});

// Initialize email transporter
const emailTransporter = initializeEmailTransporter({
  EMAIL_HOST: process.env.EMAIL_HOST,
  EMAIL_PORT: process.env.EMAIL_PORT,
  EMAIL_SECURE: process.env.EMAIL_SECURE,
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASS: process.env.EMAIL_PASS
});

// Test email configuration
emailTransporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email configuration failed:', error.message);
    console.log('📧 Email functionality will be disabled');
  } 
});

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ CORS first (before any other middleware) so headers are always set
const allowedOrigins = [
  'https://assurassistancepro.org',
  'https://www.assurassistancepro.org',
  'https://app.acareeracademy.com',
  'https://acareeracademy.com',
  'https://www.acareeracademy.com',
  'http://localhost:3000',
  'http://localhost:5173'
];
const extraOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const origins = [...new Set([...allowedOrigins, ...extraOrigins])];

// Handle preflight for all /api routes first so CORS headers are always sent (helps behind proxy)
app.use('/api', (req, res, next) => {
  if (req.method !== 'OPTIONS') return next();
  const origin = req.get('Origin');
  if (origin && origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  }
  res.sendStatus(204);
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (origins.includes(origin)) return callback(null, true);
      callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
    optionsSuccessStatus: 204,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
  })
);

// Basic input sanitization (simplified)
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    const sanitizeString = (str) => {
      if (typeof str === 'string') {
        return str
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/javascript:/gi, '')
          .replace(/on\w+\s*=/gi, '');
      }
      return str;
    };
    const sanitizeObject = (obj) => {
      if (Array.isArray(obj)) return obj.map(sanitizeObject);
      if (obj && typeof obj === 'object') {
        const sanitized = {};
        for (const [key, value] of Object.entries(obj)) {
          sanitized[key] = sanitizeObject(value);
        }
        return sanitized;
      }
      return sanitizeString(obj);
    };
    req.body = sanitizeObject(req.body);
  }
  next();
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/catalogue', catalogueRoutes);
app.use("/api/cases", caseRoutes);
app.use("/api/sales",salesRoute)
app.get('/', (req, res) => res.send('Assur Assistance Backend is running'));
// Serve uploads
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files for invoices/certificates
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.use("/api/reconciliation", reconciliationRoute);
app.use("/api/ledger", ledgerRoutes);
app.use("/api/activity-log", activityLogRoutes);

// 404 for unknown API routes (so proxy gets a response, not hang)
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin');
  if (origin && origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.status(404).json({ message: 'Not found' });
});

// Global error handler: always send a response so proxy never sees "bad gateway"
app.use((err, req, res, next) => {
  const origin = req.get('Origin');
  if (origin && origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (res.headersSent) return next(err);
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`server is running on ${PORT}`);
});


