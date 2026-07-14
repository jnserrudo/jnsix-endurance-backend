const express = require('express');
const router = express.Router();
const challengesController = require('../controllers/challenges.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');

router.use(authenticateToken);
router.use(requireFeatureEnabled('challenges_enabled'));

router.post('/', challengesController.createChallenge);
router.get('/', challengesController.listChallenges);
router.get('/:id', challengesController.getChallengeById);
router.put('/:id', challengesController.updateChallenge);
router.delete('/:id', challengesController.deleteChallenge);
router.post('/:id/join', challengesController.joinChallenge);
router.post('/:id/leave', challengesController.leaveChallenge);
router.get('/:id/ranking', challengesController.getChallengeRanking);

module.exports = router;
