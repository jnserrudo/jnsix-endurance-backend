const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const imageUpload = require('../middleware/imageUpload.middleware');

router.use(authenticateToken);

router.get('/search', usersController.searchUsers);
router.get('/me/profile', usersController.getMyProfile);
router.put('/me/profile', usersController.updateMyProfile);
router.post('/me/avatar', imageUpload.single('image'), usersController.uploadAvatar);
router.post('/me/cover', imageUpload.single('image'), usersController.uploadCover);
router.get('/:id/profile', usersController.getUserPublicProfile);

module.exports = router;
