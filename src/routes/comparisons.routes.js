const express = require('express');
const router = express.Router();
const comparisonsController = require('../controllers/comparisons.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', comparisonsController.getComparisons);
router.get('/:id', comparisonsController.getComparisonById);
router.post('/', comparisonsController.createComparison);
router.post('/:id/activities', comparisonsController.addActivityToComparison);
router.delete('/:id/activities/:activityId', comparisonsController.removeActivityFromComparison);
router.put('/:id', comparisonsController.updateComparison);
router.delete('/:id', comparisonsController.deleteComparison);

module.exports = router;
