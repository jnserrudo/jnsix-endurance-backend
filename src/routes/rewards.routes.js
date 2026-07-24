const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole, optionalAuth } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const rewardsController = require('../controllers/rewards.controller');

router.use(requireFeatureEnabled('rewards_marketplace_enabled'));

router.get('/', optionalAuth, rewardsController.listRewards);
router.get('/featured', optionalAuth, rewardsController.getFeaturedReward);
router.get('/wishlist/me', authenticateToken, requireRole('ATHLETE'), rewardsController.getMyWishlist);
router.get('/:id', authenticateToken, rewardsController.getRewardById);
router.post('/:id/redeem', authenticateToken, requireRole('ATHLETE'), rewardsController.redeemReward);
router.post('/:id/wishlist', authenticateToken, requireRole('ATHLETE'), rewardsController.toggleWishlist);
router.delete('/:id/wishlist', authenticateToken, requireRole('ATHLETE'), rewardsController.toggleWishlist);

module.exports = router;
