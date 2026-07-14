const express = require('express');
const router = express.Router();
const friendsController = require('../controllers/friends.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('friends_enabled'));

router.get('/search', friendsController.searchUsers);
router.get('/', friendsController.listFriends);
router.get('/requests', friendsController.listPendingRequests);
router.post('/request', friendsController.sendRequest);
router.patch('/request/:id', friendsController.respondRequest);
router.delete('/:id', friendsController.removeFriend);

module.exports = router;
