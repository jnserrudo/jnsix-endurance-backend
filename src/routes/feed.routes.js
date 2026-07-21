const express = require('express');
const router = express.Router();
const feedController = require('../controllers/feed.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const { uploadImage } = require('../middleware/upload.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('feed_enabled'));

router.get('/', feedController.getFeed);
router.post('/posts', uploadImage.single('image'), feedController.createPost);
router.get('/comments', feedController.listComments);
router.post('/comments', feedController.createComment);
router.get('/reactions', feedController.listReactions);
router.post('/reactions', feedController.toggleReaction);

router.put('/posts/:id', feedController.updatePost);
router.delete('/posts/:id', feedController.deletePost);
router.put('/comments/:id', feedController.updateComment);
router.delete('/comments/:id', feedController.deleteComment);

module.exports = router;
