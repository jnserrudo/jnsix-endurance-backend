const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/strava', authController.stravaAuth);
router.get('/strava/callback', authController.stravaCallback);
router.post('/strava/disconnect', authenticateToken, authController.disconnectStrava);
router.post('/refresh', authController.refreshToken);
router.get('/me', authenticateToken, authController.getCurrentUser);

module.exports = router;

