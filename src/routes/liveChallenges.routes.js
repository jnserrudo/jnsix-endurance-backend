const express = require('express');
const router = express.Router();
const liveChallengesController = require('../controllers/liveChallenges.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', liveChallengesController.getChallenges);
router.post('/', liveChallengesController.createChallenge);

module.exports = router;
