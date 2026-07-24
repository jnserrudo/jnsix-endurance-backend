const express = require('express');
const router = express.Router();
const { authenticateToken, requireRole, optionalAuth } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const rewardsController = require('../controllers/rewards.controller');

// Atletas y ADMIN (smoke test / cuentas admin que usan la app como consumidor)
const athleteOrAdmin = requireRole('ATHLETE', 'ADMIN');

router.use(requireFeatureEnabled('rewards_marketplace_enabled'));

router.get('/', optionalAuth, rewardsController.listRewards);
router.get('/featured', optionalAuth, rewardsController.getFeaturedReward);
router.get('/wishlist/me', authenticateToken, athleteOrAdmin, rewardsController.getMyWishlist);
router.get('/:id', authenticateToken, rewardsController.getRewardById);
router.post('/:id/redeem', authenticateToken, athleteOrAdmin, rewardsController.redeemReward);
router.post('/:id/wishlist', authenticateToken, athleteOrAdmin, rewardsController.toggleWishlist);
router.delete('/:id/wishlist', authenticateToken, athleteOrAdmin, rewardsController.toggleWishlist);

module.exports = router;
