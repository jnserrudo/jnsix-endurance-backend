const express = require('express');
const router = express.Router();
const achievementsController = require('../controllers/achievements.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', achievementsController.getAchievements);
router.get('/user/:userId?', achievementsController.getUserAchievements);
router.post('/check', achievementsController.triggerCheck);

module.exports = router;
