const express = require('express');
const router = express.Router();
const aiController = require('../controllers/ai.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { checkPlanLimit } = require('../middleware/plan-enforcement.middleware');

router.use(authenticateToken);

router.post('/analyze-activity/:id', checkPlanLimit('ai_coach.daily_limit'), aiController.analyzeActivity);
router.post('/analyze-multiple', checkPlanLimit('ai_coach.daily_limit'), aiController.analyzeMultipleActivities);
router.post('/compare', checkPlanLimit('ai_coach.daily_limit'), aiController.compareActivities);
router.post('/analyze-trends', checkPlanLimit('ai_coach.daily_limit'), aiController.analyzeTrends);
router.post('/training-plan', checkPlanLimit('ai_coach.daily_limit'), aiController.generateTrainingPlan);
router.post('/race-strategy', checkPlanLimit('ai_coach.daily_limit'), aiController.getRaceStrategy);
router.post('/predict-time', checkPlanLimit('ai_coach.daily_limit'), aiController.predictTime);
router.post('/coach', checkPlanLimit('ai_coach.daily_limit'), aiController.chatWithCoach);
router.post('/analyze-competition/:id', checkPlanLimit('ai_coach.daily_limit'), aiController.analyzeCompetitionGoal);
router.get('/history', aiController.getAnalysisHistory);
router.get('/usage', aiController.getUsageStats);
router.get('/conversations', aiController.listConversations);
router.get('/conversations/:id', aiController.getConversation);
router.delete('/conversations/:id', aiController.deleteConversation);
router.get('/predict-race', aiController.predictRace);
router.get('/export-plan/:userPlanId', aiController.exportPlan);
router.post('/export-plan/:userPlanId', aiController.exportPlan);
router.get('/exercise-suggestions', aiController.suggestComplementaryExercises);
router.get('/daily-briefing', aiController.getDailyBriefing);

module.exports = router;
