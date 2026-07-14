const express = require('express');
const router = express.Router();
const communitiesController = require('../controllers/communities.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const { checkPlanLimit } = require('../middleware/plan-enforcement.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('communities_enabled'));

router.get('/', communitiesController.listCommunities);
router.get('/:id', communitiesController.getCommunityById);
router.post('/', checkPlanLimit('communities.create'), communitiesController.createCommunity);
router.put('/:id', communitiesController.updateCommunity);
router.patch('/:id/disable', communitiesController.disableCommunity);
router.post('/:id/join', communitiesController.joinCommunity);
router.delete('/:id/leave', communitiesController.leaveCommunity);

module.exports = router;
