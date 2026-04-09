import express from 'express';
const router = express.Router();
import {
  createCatalogue,
  getCatalogues,
  updateCatalogue,
  deleteCatalogue,
  uploadPartnerInsurerLogo,
  deletePartnerInsurerLogo,
  uploadPartnerLogoMiddleware
} from '../controllers/catalogueController.js';
import authenticate from '../middlewares/authMiddleware.js';

import { adminOnly } from '../middlewares/roleMiddleware.js';

// Admin creates a new plan
router.post('/', authenticate, adminOnly, createCatalogue);

// Get all catalogues (Admin sees all, Agent sees only active)
router.get('/', authenticate, getCatalogues);

router.post(
  '/:id/partner-logo',
  authenticate,
  adminOnly,
  (req, res, next) => {
    uploadPartnerLogoMiddleware(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || 'Invalid upload' });
      }
      next();
    });
  },
  uploadPartnerInsurerLogo
);

router.delete('/:id/partner-logo', authenticate, adminOnly, deletePartnerInsurerLogo);

// Update plan (Admin)
router.put('/:id', authenticate, adminOnly, updateCatalogue);

// Delete plan (Admin)
router.delete('/:id', authenticate, adminOnly, deleteCatalogue);

export default router;
