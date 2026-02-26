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



// Basic input sanitization (simplified)
app.use((req, res, next) => {
  // Basic XSS protection
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
      if (Array.isArray(obj)) {
        return obj.map(sanitizeObject);
      }
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


// ✅ Secure CORS configuration
const allowedOrigins = [
  // AssurAssistance production
  'https://assurassistancepro.org',
  'https://www.assurassistancepro.org',
  // Legacy / other
  'https://app.acareeracademy.com',
  'https://acareeracademy.com',
  'https://www.acareeracademy.com',
  process.env.FRONTEND_URL || 'https://assurassistancepro.org',
  // Local development
  'http://localhost:3000',
  'http://localhost:5173'
];


app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  credentials: true,
  optionsSuccessStatus: 200,
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
  exposedHeaders: ["Content-Range", "X-Content-Range"]
}));

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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`server is running on ${PORT}`);
});


