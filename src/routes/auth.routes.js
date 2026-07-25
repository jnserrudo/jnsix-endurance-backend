const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.post('/register', authController.register);
router.post('/register-business', authController.registerBusiness);
router.post('/login', authController.login);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerification);
router.post('/unsubscribe', authController.unsubscribe);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/change-password', authenticateToken, authController.changePassword);
router.post('/totp/setup', authenticateToken, authController.setupTotp);
router.post('/totp/enable', authenticateToken, authController.enableTotp);
router.post('/totp/disable', authenticateToken, authController.disableTotp);
router.post('/push-token', authenticateToken, authController.registerPushToken);
router.delete('/push-token', authenticateToken, authController.removePushToken);
router.get('/strava', authController.stravaAuth);
router.get('/strava/callback', authController.stravaCallback);
router.post('/strava/disconnect', authenticateToken, authController.disconnectStrava);
router.post('/refresh', authController.refreshToken);
router.get('/me', authenticateToken, authController.getCurrentUser);

module.exports = router;
