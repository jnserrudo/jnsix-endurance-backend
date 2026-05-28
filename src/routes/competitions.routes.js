const express = require('express');
const router = express.Router();
const competitionsController = require('../controllers/competitions.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', competitionsController.getCompetitions);
router.post('/', competitionsController.createCompetition);
router.put('/:id', competitionsController.updateCompetition);
router.delete('/:id', competitionsController.deleteCompetition);
router.post('/:id/simulate', competitionsController.associateSimulation);

module.exports = router;
