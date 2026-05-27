const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

router.get('/strava', webhookController.verifyStravaWebhook);
router.post('/strava', webhookController.handleStravaWebhook);

module.exports = router;
