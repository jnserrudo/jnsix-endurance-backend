const express = require('express');
const router = express.Router();
const trainingPlansController = require('../controllers/trainingPlans.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/current', trainingPlansController.getCurrentPlan);
router.get('/today', trainingPlansController.getTodaySession);
router.post('/generate', trainingPlansController.generatePlan);
router.post('/sessions/match', trainingPlansController.matchSession);
router.post('/effort', trainingPlansController.logEffort);
router.get('/effort/history', trainingPlansController.getEffortHistory);
router.patch('/:planId/sessions/:sessionId', trainingPlansController.updateSession);
router.post('/:planId/regenerate-week', trainingPlansController.regenerateWeek);

module.exports = router;
