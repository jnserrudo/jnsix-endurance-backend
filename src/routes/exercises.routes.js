const express = require('express');
const router = express.Router();
const exercisesController = require('../controllers/exercises.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticateToken);

router.get('/filters', exercisesController.getFilters);
router.get('/', exercisesController.listExercises);
router.get('/:id', exercisesController.getExerciseById);

// Rutas de administración
router.post('/', requirePermission('exercises.manage'), exercisesController.createExercise);
router.put('/:id', requirePermission('exercises.manage'), exercisesController.updateExercise);
router.delete('/:id', requirePermission('exercises.manage'), exercisesController.deleteExercise);

module.exports = router;
