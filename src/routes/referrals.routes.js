const express = require('express');
const { authenticateToken } = require('../middleware/auth.middleware');
const { getMyReferrals } = require('../controllers/referrals.controller');

const router = express.Router();

router.get('/me', authenticateToken, getMyReferrals);

module.exports = router;
