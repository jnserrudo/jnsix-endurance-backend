const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const discountsController = require('../controllers/discounts.controller');

router.use(authenticateToken);

router.post('/validate', discountsController.validate);

module.exports = router;
