const express = require('express');
const router = express.Router();
const liveRunsController = require('../controllers/liveRuns.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', liveRunsController.listLiveRuns);
router.post('/start', liveRunsController.startLiveRun);
router.get('/invite/:token', liveRunsController.resolveInvite);
router.get('/:id', liveRunsController.getLiveRun);
router.post('/:id/tick', liveRunsController.postLiveTick);
router.post('/:id/end', liveRunsController.endLiveRun);
router.post('/:id/cancel', liveRunsController.cancelLiveRun);

module.exports = router;
