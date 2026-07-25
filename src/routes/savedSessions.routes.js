const express = require('express');
const router = express.Router();
const savedSessionsController = require('../controllers/savedSessions.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', savedSessionsController.listSavedSessions);
router.post('/', savedSessionsController.createSavedSession);
router.delete('/:id', savedSessionsController.deleteSavedSession);

module.exports = router;
