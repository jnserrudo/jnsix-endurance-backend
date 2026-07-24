const express = require('express');
const router = express.Router();
const storiesController = require('../controllers/stories.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { uploadImage } = require('../middleware/upload.middleware');

router.use(authenticateToken);

router.post('/', uploadImage.single('media'), storiesController.createStory);
router.get('/feed', storiesController.getFeedStories);
router.post('/:id/view', storiesController.viewStory);

module.exports = router;
