const express = require('express');
const router = express.Router();
const communitiesController = require('../controllers/communities.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const { checkPlanLimit } = require('../middleware/plan-enforcement.middleware');
const imageUpload = require('../middleware/imageUpload.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('communities_enabled'));

router.get('/invitations/mine', communitiesController.listMyCommunityInvitations);
router.patch('/invitations/:invitationId', communitiesController.respondCommunityInvite);

router.get('/', communitiesController.listCommunities);
router.get('/:id', communitiesController.getCommunityById);
router.post('/', checkPlanLimit('communities.create'), communitiesController.createCommunity);
router.put('/:id', communitiesController.updateCommunity);
router.patch('/:id/disable', communitiesController.disableCommunity);
router.post('/:id/join', communitiesController.joinCommunity);
router.post('/:id/request', communitiesController.requestToJoinCommunity);
router.get('/:id/requests', communitiesController.listCommunityJoinRequests);
router.patch('/:id/requests/:requestId', communitiesController.respondCommunityJoinRequest);
router.post('/:id/invite', communitiesController.inviteToCommunity);
router.get('/:id/invitations', communitiesController.listCommunityInvitations);
router.post('/:id/avatar', imageUpload.single('image'), communitiesController.uploadCommunityAvatar);
router.delete('/:id/leave', communitiesController.leaveCommunity);

module.exports = router;
