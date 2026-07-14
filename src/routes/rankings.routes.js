const express = require('express');
const router = express.Router();
const rankingsController = require('../controllers/rankings.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('rankings_enabled'));

router.get('/me', rankingsController.getUserScore);
router.get('/global', rankingsController.getGlobalRankings);
router.get('/friends', rankingsController.getFriendsRankings);
router.get('/group/:id', rankingsController.getGroupRankings);
router.get('/community/:id', rankingsController.getCommunityRankings);

module.exports = router;
