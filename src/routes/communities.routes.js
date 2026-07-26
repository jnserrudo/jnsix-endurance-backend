const express = require('express');
const router = express.Router();
const communitiesController = require('../controllers/communities.controller');
const feedController = require('../controllers/feed.controller');
const eventsController = require('../controllers/events.controller');
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
router.post('/:id/avatar', imageUpload.uploadImageField('image'), communitiesController.uploadCommunityAvatar);
router.delete('/:id/leave', communitiesController.leaveCommunity);

// Muro de la comunidad (feed filtrado por communityId)
router.get('/:id/feed', feedController.getCommunityFeed);

// Estadísticas del reto colectivo (suma de distancia del mes de los miembros)
router.get('/:id/challenge-stats', communitiesController.getChallengeStats);

// Eventos de la comunidad
router.get('/:id/events', eventsController.listCommunityEvents);
router.post('/:id/events', eventsController.createCommunityEvent);

module.exports = router;
