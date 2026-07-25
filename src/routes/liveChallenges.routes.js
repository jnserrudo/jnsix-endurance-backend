const express = require('express');
const router = express.Router();
const liveChallengesController = require('../controllers/liveChallenges.controller');
const { authenticateToken, requireRole } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', liveChallengesController.getChallenges);
router.post('/', requireRole('ADMIN'), liveChallengesController.createChallenge);
router.get('/:id', liveChallengesController.getChallengeById);
router.put('/:id', requireRole('ADMIN'), liveChallengesController.updateChallenge);
router.delete('/:id', requireRole('ADMIN'), liveChallengesController.deleteChallenge);
router.post('/:id/join', liveChallengesController.joinChallenge);
router.post('/:id/leave', liveChallengesController.leaveChallenge);
router.post('/:id/progress', liveChallengesController.updateProgress);

module.exports = router;
