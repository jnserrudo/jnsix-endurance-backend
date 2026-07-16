const express = require('express');
const router = express.Router();
const plansController = require('../controllers/plans.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.get('/', authenticateToken, plansController.listPublicPlans);

module.exports = router;
