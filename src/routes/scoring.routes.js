const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const { requireFeatureEnabled } = require('../middleware/feature-flag.middleware');
const scoringController = require('../controllers/scoring.controller');

router.use(authenticateToken);

// La guía de precios que ve el negocio no depende del módulo de rankings, así que
// se registra antes del feature flag.
router.get('/reference', scoringController.getReference);

router.use(requireFeatureEnabled('rankings_enabled'));

router.get('/me', scoringController.getMySummary);
router.get('/me/history', scoringController.getMyHistory);
router.get('/me/suggestions', scoringController.getMySuggestions);

module.exports = router;
