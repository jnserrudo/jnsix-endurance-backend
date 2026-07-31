const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const meController = require('../controllers/me.controller');

router.use(authenticateToken);

// Agregado de "qué hago ahora": no lleva feature flag porque es la puerta de
// entrada del Dashboard y tiene que responder siempre.
router.get('/today', meController.getToday);
router.get('/weekly-recap', meController.getWeeklyRecap);

module.exports = router;
