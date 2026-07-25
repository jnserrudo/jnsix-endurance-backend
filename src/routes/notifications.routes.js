const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notifications.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', notificationsController.getNotifications);
router.get('/unread-count', notificationsController.getUnreadCount);
router.patch('/read-all', notificationsController.markAllAsRead);
router.get('/preferences', notificationsController.getPreferences);
router.patch('/preferences', notificationsController.updatePreferences);
router.patch('/:id/read', notificationsController.markAsRead);
router.post('/push-token', notificationsController.registerPushToken);
router.post('/send', notificationsController.sendPushNotification);

module.exports = router;
