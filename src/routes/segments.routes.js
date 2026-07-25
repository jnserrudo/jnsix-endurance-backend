const express = require('express');
const router = express.Router();
const segmentsController = require('../controllers/segments.controller');
const { authenticateToken, requireRole } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', segmentsController.getSegments);
router.post('/match', segmentsController.matchSegments);
router.post('/', requireRole('ADMIN'), segmentsController.createSegment);
router.get('/:id', segmentsController.getSegmentById);
router.put('/:id', requireRole('ADMIN'), segmentsController.updateSegment);
router.delete('/:id', requireRole('ADMIN'), segmentsController.deleteSegment);
router.post('/:id/leaderboard', segmentsController.logLeaderboard);
router.get('/:id/leaderboard', segmentsController.getLeaderboard);

module.exports = router;
