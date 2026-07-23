const express = require('express');
const router = express.Router();
const integrationsController = require('../controllers/integrations.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.post('/garmin/connect', authenticateToken, integrationsController.connectGarmin);
router.post('/polar/connect', authenticateToken, integrationsController.connectPolar);

module.exports = router;
