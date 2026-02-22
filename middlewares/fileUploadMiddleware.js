// File upload security middleware
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../uploads');
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // Generate secure filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${file.fieldname}-${uniqueSuffix}-${sanitizedName}`);
  }
});

// File filter for security
const fileFilter = (req, file, cb) => {
  const allowedTypes = process.env.ALLOWED_FILE_TYPES?.split(',') || ['pdf', 'jpg', 'jpeg', 'png'];
  const fileExtension = path.extname(file.originalname).toLowerCase().slice(1);
  
  if (allowedTypes.includes(fileExtension)) {
    cb(null, true);
  } else {
    cb(new Error(`File type .${fileExtension} is not allowed. Allowed types: ${allowedTypes.join(', ')}`), false);
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024, // 5MB default
    files: 5 // Maximum 5 files per request
  }
});

// Error handling middleware
export const handleUploadError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        message: `Maximum file size is ${(parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024) / 1024 / 1024}MB`
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Too many files',
        message: 'Maximum 5 files allowed per request'
      });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: 'Unexpected file field',
        message: 'Check the field name for file upload'
      });
    }
  }
  
  if (error.message.includes('File type')) {
    return res.status(400).json({
      error: 'Invalid file type',
      message: error.message
    });
  }
  
  next(error);
};

// File validation after upload
export const validateUploadedFile = (req, res, next) => {
  if (!req.file) {
    return next();
  }
  
  const file = req.file;
  
  // Check file size again (double check)
  const maxSize = parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024;
  if (file.size > maxSize) {
    // Delete the uploaded file
    fs.unlinkSync(file.path);
    return res.status(400).json({
      error: 'File too large',
      message: `Maximum file size is ${maxSize / 1024 / 1024}MB`
    });
  }
  
  // Check file extension again
  const allowedTypes = process.env.ALLOWED_FILE_TYPES?.split(',') || ['pdf', 'jpg', 'jpeg', 'png'];
  const fileExtension = path.extname(file.originalname).toLowerCase().slice(1);
  
  if (!allowedTypes.includes(fileExtension)) {
    // Delete the uploaded file
    fs.unlinkSync(file.path);
    return res.status(400).json({
      error: 'Invalid file type',
      message: `File type .${fileExtension} is not allowed. Allowed types: ${allowedTypes.join(', ')}`
    });
  }
  
  // Additional security checks for specific file types
  if (fileExtension === 'pdf') {
    // Check if it's actually a PDF by reading the first few bytes
    const buffer = fs.readFileSync(file.path, { start: 0, end: 4 });
    const header = buffer.toString('hex');
    if (!header.startsWith('25504446')) { // PDF magic number
      fs.unlinkSync(file.path);
      return res.status(400).json({
        error: 'Invalid PDF file',
        message: 'The uploaded file is not a valid PDF'
      });
    }
  }
  
  next();
};

// Clean up files on error
export const cleanupFiles = (req, res, next) => {
  const originalSend = res.send;
  
  res.send = function(data) {
    // If response indicates an error, clean up uploaded files
    if (res.statusCode >= 400 && req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (error) {
        console.error('Error cleaning up file:', error);
      }
    }
    
    return originalSend.call(this, data);
  };
  
  next();
};

export default upload;
