const express = require('express');
const router = express.Router();
const duelsController = require('../controllers/duels.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.post('/', duelsController.createDuel);
router.get('/mine', duelsController.listMine);
router.patch('/:id', duelsController.patchDuel);

module.exports = router;
