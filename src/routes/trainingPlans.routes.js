const express = require('express');
const router = express.Router();
const trainingPlansController = require('../controllers/trainingPlans.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/current', trainingPlansController.getCurrentPlan);
router.post('/generate', trainingPlansController.generatePlan);
router.post('/effort', trainingPlansController.logEffort);
router.get('/effort/history', trainingPlansController.getEffortHistory);

module.exports = router;
