const express = require('express');
const router = express.Router();
const exercisesController = require('../controllers/exercises.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/filters', exercisesController.getFilters);
router.get('/', exercisesController.listExercises);
router.get('/:id', exercisesController.getExerciseById);

module.exports = router;
