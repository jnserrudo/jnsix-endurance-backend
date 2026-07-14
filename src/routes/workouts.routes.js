const express = require('express');
const router = express.Router();
const workoutsController = require('../controllers/workouts.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.post('/', workoutsController.createSession);
router.get('/', workoutsController.listSessions);
router.get('/:id', workoutsController.getSessionById);
router.post('/:id/sets', workoutsController.addSet);
router.patch('/:id/complete', workoutsController.completeSession);
router.delete('/:id', workoutsController.deleteSession);

module.exports = router;
