const express = require('express');
const router = express.Router();
const gamificationController = require('../controllers/gamification.controller');
const duelsController = require('../controllers/duels.controller');
const { authenticateToken, requireRole } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/streak', gamificationController.getStreak);
router.get('/streak/at-risk', gamificationController.getStreakAtRisk);
router.get('/missions', gamificationController.getMissions);
router.get('/missions/today', gamificationController.getTodayMission);
router.post('/missions/:id/progress', gamificationController.updateMissionProgress);
router.post('/check', gamificationController.checkUnlockables);
router.get('/badges', gamificationController.getBadges);

router.get('/seasons/current', gamificationController.getCurrentSeason);
router.get('/seasons', requireRole('ADMIN'), gamificationController.listSeasons);
router.post('/seasons', requireRole('ADMIN'), gamificationController.createSeason);

// Alias bajo gamification (también montados en /api/duels)
router.post('/duels', duelsController.createDuel);
router.patch('/duels/:id', duelsController.patchDuel);
router.get('/duels/mine', duelsController.listMine);

module.exports = router;
