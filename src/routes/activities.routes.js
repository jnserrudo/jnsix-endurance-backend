const express = require('express');
const router = express.Router();
const activitiesController = require('../controllers/activities.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const upload = require('../middleware/upload.middleware');

// Webhook de Strava (sin autenticación)
router.get('/strava-webhook', activitiesController.verifyStravaWebhook);
router.post('/strava-webhook', activitiesController.handleStravaWebhook);

router.get('/shared/:token', activitiesController.getSharedActivity);

router.use(authenticateToken);

router.get('/', activitiesController.getActivities);
router.post('/sync-strava', activitiesController.syncStravaActivities);
router.post('/sync-job', activitiesController.createSyncJob);
router.get('/sync-job/:jobId', activitiesController.getSyncJobStatus);
router.get('/check-new', activitiesController.checkNewActivities);
router.get('/:id', activitiesController.getActivityById);
router.post('/', activitiesController.createActivity);
router.post('/upload', upload.single('file'), activitiesController.uploadActivity);
router.post('/import-link', activitiesController.importFromLink);
router.post('/:id/share', activitiesController.shareActivity);
router.put('/:id', activitiesController.updateActivity);
router.delete('/:id', activitiesController.deleteActivity);

module.exports = router;
