const express = require('express');
const router = express.Router();
const storiesController = require('../controllers/stories.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.post('/', storiesController.createStory);
router.get('/feed', storiesController.getFeedStories);
router.post('/:id/view', storiesController.viewStory);

module.exports = router;
