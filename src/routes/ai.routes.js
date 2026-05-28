const express = require('express');
const router = express.Router();
const aiController = require('../controllers/ai.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.post('/analyze-activity/:id', aiController.analyzeActivity);
router.post('/analyze-multiple', aiController.analyzeMultipleActivities);
router.post('/compare', aiController.compareActivities);
router.post('/analyze-trends', aiController.analyzeTrends);
router.post('/training-plan', aiController.generateTrainingPlan);
router.post('/race-strategy', aiController.getRaceStrategy);
router.post('/predict-time', aiController.predictTime);
router.post('/coach', aiController.chatWithCoach);
router.get('/history', aiController.getAnalysisHistory);
router.get('/usage', aiController.getUsageStats);

module.exports = router;
