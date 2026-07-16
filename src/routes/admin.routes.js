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
router.get('/users/:id', requirePermission('users.view'), adminController.getUserDetails);
router.patch('/users/:id', requirePermission('users.edit'), adminController.editUser);
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
router.get('/categories', requirePermission('rankings.manage'), adminController.listCategories);
router.post('/categories', requirePermission('rankings.manage'), adminController.createCategory);
router.put('/categories/:id', requirePermission('rankings.manage'), adminController.editCategory);

// Auditoría
router.get('/audit', requirePermission('audit.view'), adminController.listAuditLogs);
router.get('/audit-logs', requirePermission('audit.view'), adminController.listAuditLogs);
router.get('/audit-logs/:id', requirePermission('audit.view'), adminController.getAuditLogDetails);

// Moderación
router.delete('/posts/:id', requirePermission('content.moderate'), adminController.deletePost);
router.delete('/groups/:id', requirePermission('content.moderate'), adminController.deleteGroup);

module.exports = router;
