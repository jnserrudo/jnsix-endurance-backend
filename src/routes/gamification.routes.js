const express = require('express');
const router = express.Router();
const gamificationController = require('../controllers/gamification.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/streak', gamificationController.getStreak);
router.get('/missions', gamificationController.getMissions);
router.post('/missions/:id/progress', gamificationController.updateMissionProgress);
router.post('/check', gamificationController.checkUnlockables);

module.exports = router;
