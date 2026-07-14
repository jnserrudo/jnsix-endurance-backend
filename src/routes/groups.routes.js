const express = require('express');
const router = express.Router();
const groupsController = require('../controllers/groups.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('groups_enabled'));

router.get('/', groupsController.listGroups);
router.get('/:id', groupsController.getGroupById);
router.post('/', groupsController.createGroup);
router.put('/:id', groupsController.updateGroup);
router.patch('/:id/disable', groupsController.disableGroup);
router.post('/:id/join', groupsController.joinGroup);
router.delete('/:id/leave', groupsController.leaveGroup);
router.post('/:id/subgroups', groupsController.createSubgroup);

module.exports = router;
