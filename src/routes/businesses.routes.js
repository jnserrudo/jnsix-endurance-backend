const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole, optionalAuth } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const { uploadImage } = require('../middleware/upload.middleware');
const businessesController = require('../controllers/businesses.controller');

router.use(requireFeatureEnabled('rewards_marketplace_enabled'));

router.get('/', optionalAuth, businessesController.listBusinesses);
router.get('/me', authenticateToken, requireRole('BUSINESS'), businessesController.getMyBusiness);
router.put('/me', authenticateToken, requireRole('BUSINESS'), businessesController.updateMyBusiness);
router.post('/me/logo', authenticateToken, requireRole('BUSINESS'), uploadImage.single('image'), businessesController.uploadBusinessImage('logoUrl'));
router.post('/me/cover', authenticateToken, requireRole('BUSINESS'), uploadImage.single('image'), businessesController.uploadBusinessImage('coverUrl'));

router.get('/me/rewards', authenticateToken, requireRole('BUSINESS'), businessesController.listMyRewards);
router.post('/me/rewards', authenticateToken, requireRole('BUSINESS'), businessesController.createMyReward);
router.put('/me/rewards/:id', authenticateToken, requireRole('BUSINESS'), businessesController.updateMyReward);
router.patch('/me/rewards/:id/status', authenticateToken, requireRole('BUSINESS'), businessesController.updateMyRewardStatus);
router.patch('/me/rewards/:id/feature', authenticateToken, requireRole('BUSINESS'), businessesController.featureMyReward);
router.post('/me/rewards/:id/image', authenticateToken, requireRole('BUSINESS'), uploadImage.single('image'), businessesController.uploadRewardImage);

router.get('/me/redemptions', authenticateToken, requireRole('BUSINESS'), businessesController.listMyRedemptions);
router.get('/me/analytics', authenticateToken, requireRole('BUSINESS'), businessesController.getMyAnalytics);
router.get('/me/settlements', authenticateToken, requireRole('BUSINESS'), businessesController.listMySettlements);
router.post('/me/redemptions/lookup', authenticateToken, requireRole('BUSINESS'), businessesController.lookupRedemption);
router.post('/me/redemptions/validate', authenticateToken, requireRole('BUSINESS'), businessesController.validateRedemption);

router.post('/:id/check-in', authenticateToken, requireRole('ATHLETE', 'ADMIN'), businessesController.checkIn);
router.get('/:id', optionalAuth, businessesController.getBusinessById);

module.exports = router;
