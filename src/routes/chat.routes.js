const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const { uploadChatMedia } = require('../middleware/upload.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('chat_enabled'));

router.get('/rooms', chatController.listRooms);
router.post('/rooms/direct', chatController.getOrCreateDirectRoom);
router.post('/rooms/group', chatController.getOrCreateGroupRoom);
router.post('/rooms/community', chatController.getOrCreateCommunityRoom);
router.get('/rooms/:roomId/messages', chatController.getMessages);
router.post(
  '/rooms/:roomId/messages',
  uploadChatMedia.single('media'),
  chatController.sendMessage
);
router.post('/rooms/:roomId/messages/read', chatController.markAsRead);
router.post('/rooms/:roomId/read', chatController.markAsRead);

module.exports = router;
