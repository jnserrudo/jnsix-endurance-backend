const express = require('express');
const router = express.Router();
const storiesController = require('../controllers/stories.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const { uploadStoryMedia } = require('../middleware/upload.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('stories_enabled'));

router.post('/', uploadStoryMedia.single('media'), storiesController.createStory);
router.get('/feed', storiesController.getFeedStories);
router.post('/:id/view', storiesController.viewStory);

module.exports = router;
