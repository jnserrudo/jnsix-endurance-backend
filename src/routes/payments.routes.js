const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticateToken, requireRole } = require('../middleware/auth.middleware');
const paymentsController = require('../controllers/payments.controller');

// Configuración de multer (memoria) para pasar el buffer al StorageService
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  }
});

// Rutas de Usuario
router.post(
  '/manual',
  authenticateToken,
  upload.single('receiptImage'),
  paymentsController.requestManualPayment
);

// Rutas de Admin
router.get(
  '/pending',
  authenticateToken,
  requireRole('ADMIN'),
  paymentsController.getPendingPayments
);

router.post(
  '/:id/approve',
  authenticateToken,
  requireRole('ADMIN'),
  paymentsController.approvePayment
);

router.post(
  '/:id/reject',
  authenticateToken,
  requireRole('ADMIN'),
  paymentsController.rejectPayment
);

module.exports = router;
