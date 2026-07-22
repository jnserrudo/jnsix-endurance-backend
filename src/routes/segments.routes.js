const express = require('express');
const router = express.Router();
const segmentsController = require('../controllers/segments.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', segmentsController.getSegments);
router.post('/', segmentsController.createSegment);
router.post('/:id/leaderboard', segmentsController.logLeaderboard);
router.get('/:id/leaderboard', segmentsController.getLeaderboard);

module.exports = router;
