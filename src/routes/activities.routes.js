const express = require('express');
const router = express.Router();
const activitiesController = require('../controllers/activities.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { uploadActivityFile, uploadImage } = require('../middleware/upload.middleware');


router.get('/shared/:token', activitiesController.getSharedActivity);

router.use(authenticateToken);

router.get('/', activitiesController.getActivities);
router.get('/dashboard-metrics', activitiesController.getDashboardMetrics);
router.post('/sync-strava', activitiesController.syncStravaActivities);
router.post('/sync/health', activitiesController.syncHealthWorkouts);
router.post('/sync-job', activitiesController.createSyncJob);
router.get('/sync-job/:jobId', activitiesController.getSyncJobStatus);
router.get('/check-new', activitiesController.checkNewActivities);
router.get('/:id', activitiesController.getActivityById);
router.post('/', activitiesController.createActivity);
router.post('/manual', activitiesController.createManualActivity);
router.post('/upload', uploadActivityFile.single('file'), activitiesController.uploadActivity);
router.post('/:id/photos', uploadImage.array('photos', 5), activitiesController.uploadActivityPhotos);
router.post('/import-link', activitiesController.importFromLink);
router.post('/:id/share', activitiesController.shareActivity);
router.put('/:id', activitiesController.updateActivity);
router.delete('/:id', activitiesController.deleteActivity);

module.exports = router;
