const express = require('express');
const router = express.Router();
const groupsController = require('../controllers/groups.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const imageUpload = require('../middleware/imageUpload.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('groups_enabled'));

router.get('/invitations/mine', groupsController.listMyGroupInvitations);
router.patch('/invitations/:invitationId', groupsController.respondGroupInvite);

router.get('/', groupsController.listGroups);
router.get('/:id', groupsController.getGroupById);
router.post('/', groupsController.createGroup);
router.put('/:id', groupsController.updateGroup);
router.patch('/:id/disable', groupsController.disableGroup);
router.post('/:id/join', groupsController.joinGroup);
router.post('/:id/request', groupsController.requestToJoinGroup);
router.get('/:id/requests', groupsController.listGroupJoinRequests);
router.patch('/:id/requests/:requestId', groupsController.respondGroupJoinRequest);
router.post('/:id/invite', groupsController.inviteToGroup);
router.get('/:id/invitations', groupsController.listGroupInvitations);
router.post('/:id/avatar', imageUpload.single('image'), groupsController.uploadGroupAvatar);
router.delete('/:id/leave', groupsController.leaveGroup);
router.post('/:id/subgroups', groupsController.createSubgroup);

module.exports = router;
