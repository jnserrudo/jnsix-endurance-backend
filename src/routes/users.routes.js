const express = require('express');
const router = express.Router();
const usersController = require('../controllers/users.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const imageUpload = require('../middleware/imageUpload.middleware');
const { uploadImageField } = imageUpload;

router.use(authenticateToken);

router.get('/search', usersController.searchUsers);
router.get('/discover', usersController.discoverAthletes);
router.get('/me/profile', usersController.getMyProfile);
router.put('/me/profile', usersController.updateMyProfile);
router.put('/me/coach-memory', usersController.updateCoachMemory);
router.post('/me/avatar', uploadImageField('image'), usersController.uploadAvatar);
router.post('/me/cover', uploadImageField('image'), usersController.uploadCover);
router.post('/me/onboarding', usersController.completeOnboarding);
router.get('/me/export', usersController.exportMyData);
router.get('/me/blocks', usersController.listMyBlocks);
router.delete('/me', usersController.deleteAccount);
router.get('/:id/profile', usersController.getUserPublicProfile);
router.post('/:id/block', usersController.blockUser);
router.delete('/:id/block', usersController.unblockUser);

module.exports = router;
