const express = require('express');
const router = express.Router();
const stripeController = require('../controllers/stripe.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

// Protected routes
router.use(authenticateToken);
router.post('/checkout', stripeController.createCheckoutSession);
router.post('/portal', stripeController.createCustomerPortal);

module.exports = router;
