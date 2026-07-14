const express = require('express');
const router = express.Router();
const feedController = require('../controllers/feed.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('feed_enabled'));

router.get('/', feedController.getFeed);
router.post('/posts', feedController.createPost);
router.get('/comments', feedController.listComments);
router.post('/comments', feedController.createComment);
router.get('/reactions', feedController.listReactions);
router.post('/reactions', feedController.toggleReaction);

module.exports = router;
