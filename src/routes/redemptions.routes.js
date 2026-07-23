const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const redemptionsController = require('../controllers/redemptions.controller');

router.use(authenticateToken);
router.use(requireRole('ATHLETE'));
router.use(requireFeatureEnabled('rewards_marketplace_enabled'));

router.get('/me', redemptionsController.getMyRedemptions);
router.get('/:id', redemptionsController.getRedemptionById);

module.exports = router;
