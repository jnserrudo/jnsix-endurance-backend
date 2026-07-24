const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/rbac.middleware');

router.use(authenticateToken);

// Estadísticas
router.get('/stats', adminController.getStats);

// Usuarios
router.get('/users', requirePermission('users.view'), adminController.listUsers);
router.post('/users', requirePermission('users.manage'), adminController.createUser);
router.get('/users/:id', requirePermission('users.view'), adminController.getUserDetails);
router.patch('/users/:id', requirePermission('users.edit'), adminController.editUser);
router.delete('/users/:id', requirePermission('users.manage'), adminController.deleteUser);
router.patch('/users/:id/ban', requirePermission('users.ban'), adminController.banUser);
router.patch('/users/:id/restore', requirePermission('users.ban'), adminController.restoreUser);

// Roles y Permisos
router.get('/roles', requirePermission('roles.manage'), adminController.listRoles);
router.post('/roles', requirePermission('roles.manage'), adminController.createRole);
router.put('/roles/:id', requirePermission('roles.manage'), adminController.editRole);
router.delete('/roles/:id', requirePermission('roles.manage'), adminController.deleteRole);
router.get('/permissions', requirePermission('roles.manage'), adminController.listPermissions);

// Feature Flags
router.get('/feature-flags', requirePermission('feature_flags.manage'), adminController.listFeatureFlags);
router.put('/feature-flags/:key', requirePermission('feature_flags.manage'), adminController.toggleFeatureFlag);

// Planes
router.get('/plans', requirePermission('plans.manage'), adminController.listPlans);
router.post('/plans', requirePermission('plans.manage'), adminController.createPlan);
router.put('/plans/:id', requirePermission('plans.manage'), adminController.editPlan);
router.patch('/plans/:id/disable', requirePermission('plans.manage'), adminController.disablePlan);

// Rangos y Categorías
router.get('/ranks', requirePermission('rankings.manage'), adminController.listRanks);
router.post('/ranks', requirePermission('rankings.manage'), adminController.createRank);
router.put('/ranks/:id', requirePermission('rankings.manage'), adminController.editRank);
router.delete('/ranks/:id', requirePermission('rankings.manage'), adminController.deleteRank);

router.get('/categories', requirePermission('rankings.manage'), adminController.listCategories);
router.post('/categories', requirePermission('rankings.manage'), adminController.createCategory);
router.put('/categories/:id', requirePermission('rankings.manage'), adminController.editCategory);
router.delete('/categories/:id', requirePermission('rankings.manage'), adminController.deleteCategory);

// Auditoría
router.get('/audit', requirePermission('audit.view'), adminController.listAuditLogs);
router.get('/audit-logs', requirePermission('audit.view'), adminController.listAuditLogs);
router.get('/audit-logs/:id', requirePermission('audit.view'), adminController.getAuditLogDetails);

// Moderación
router.delete('/posts/:id', requirePermission('content.moderate'), adminController.deletePost);
router.delete('/groups/:id', requirePermission('content.moderate'), adminController.deleteGroup);

// Ejercicios (Librería Global)
router.get('/exercises', requirePermission('exercises.manage'), adminController.listAdminExercises);
router.post('/exercises', requirePermission('exercises.manage'), adminController.createExercise);
router.put('/exercises/:id', requirePermission('exercises.manage'), adminController.editExercise);
router.delete('/exercises/:id', requirePermission('exercises.manage'), adminController.deleteExercise);

// Marketplace - Negocios
router.get('/businesses', requirePermission('businesses.moderate'), adminController.listBusinesses);
router.patch('/businesses/:id/approve', requirePermission('businesses.moderate'), adminController.approveBusiness);
router.patch('/businesses/:id/reject', requirePermission('businesses.moderate'), adminController.rejectBusiness);
router.patch('/businesses/:id/suspend', requirePermission('businesses.moderate'), adminController.suspendBusiness);

router.get('/rewards', requirePermission('rewards.moderate'), adminController.listAdminRewards);
router.patch('/rewards/:id/status', requirePermission('rewards.moderate'), adminController.updateAdminRewardStatus);
router.post('/notifications/test', adminController.sendTestNotification);

// Misiones y Logros
router.get('/missions', requirePermission('rankings.manage'), adminController.listMissions);
router.post('/missions', requirePermission('rankings.manage'), adminController.createMission);
router.put('/missions/:id', requirePermission('rankings.manage'), adminController.editMission);
router.delete('/missions/:id', requirePermission('rankings.manage'), adminController.deleteMission);

router.get('/achievements', requirePermission('rankings.manage'), adminController.listAdminAchievements);
router.post('/achievements', requirePermission('rankings.manage'), adminController.createAchievement);
router.put('/achievements/:id', requirePermission('rankings.manage'), adminController.editAchievement);
router.delete('/achievements/:id', requirePermission('rankings.manage'), adminController.deleteAchievement);

module.exports = router;
