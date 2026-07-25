const express = require('express');
const router = express.Router();
const eventsController = require('../controllers/events.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.use(authenticateToken);

router.get('/', eventsController.listEvents);
router.post('/', eventsController.createEvent);
router.get('/:id', eventsController.getEvent);
router.patch('/:id', eventsController.updateEvent);
router.delete('/:id', eventsController.deleteEvent);
router.patch('/:id/rsvp', eventsController.rsvpEvent);
router.post('/:id/rsvp', eventsController.rsvpEvent);

module.exports = router;
