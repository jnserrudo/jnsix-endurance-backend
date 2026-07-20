const prisma = require('../lib/prisma');
const bcrypt = require('bcrypt');

// ==========================================
// ESTADÍSTICAS DEL SISTEMA
// ==========================================
const getStats = async (req, res) => {
  try {
    const totalUsers = await prisma.user.count({ where: { deletedAt: null } });
    const activeUsers = await prisma.user.count({ where: { deletedAt: null, isActive: true } });
    const transactions = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: { status: 'COMPLETED' }
    });
    
    res.json({
      totalUsers,
      activeUsers,
      totalRevenue: transactions._sum.amount || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ==========================================
// USUARIOS
// ==========================================
const listUsers = async (req, res) => {
  try {
    const { search, isActive, role, page = 1, limit = 50 } = req.query;
    const where = { deletedAt: null };

    if (search) {
      where.email = { contains: search };
    }
    if (isActive !== undefined) {
      where.isActive = isActive === 'true';
    }
    if (role) {
      where.role = role;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const users = await prisma.user.findMany({
      where,
      skip,
      take: parseInt(limit),
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastSyncDate: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const total = await prisma.user.count({ where });

    res.json({ users, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getUserDetails = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        userScore: true,
        subscriptions: { include: { plan: true } }
      }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const VALID_ROLES = ['ADMIN', 'ATHLETE'];


const createUser = async (req, res) => {
  try {
    const { email, username, password, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const user = await prisma.user.create({
      data: {
        email,
        username,
        password: hashedPassword,
        role: role || 'ATHLETE'
      }
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'CREATE_USER',
        entityId: user.id,
        entityType: 'USER',
        metadata: { email, username, role }
      }
    });

    res.status(201).json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const editUser = async (req, res) => {
  try {
    const { isActive, role, roleIds, username } = req.body;

    const data = {};
    if (isActive !== undefined) data.isActive = isActive;
    if (role !== undefined) data.role = role;
    if (username !== undefined) data.username = username;

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data
    });

    if (roleIds && Array.isArray(roleIds)) {
      await prisma.userRole.deleteMany({ where: { userId: user.id } });
      if (roleIds.length > 0) {
        await prisma.userRole.createMany({
          data: roleIds.map(roleId => ({ userId: user.id, roleId }))
        });
      }
    }

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'EDIT_USER',
        entityId: user.id,
        entityType: 'USER',
        metadata: { updatedFields: Object.keys(data) }
      }
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteUser = async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() }
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'DELETE_USER',
        entityId: user.id,
        entityType: 'USER'
      }
    });

    res.json({ message: 'User deleted successfully', user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const banUser = async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive: false, deletedAt: new Date() }
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const restoreUser = async (req, res) => {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive: true, deletedAt: null }
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ==========================================
// ROLES Y PERMISOS
// ==========================================
const listRoles = async (req, res) => {
  try {
    const roles = await prisma.roleDefinition.findMany({
      where: { deletedAt: null },
      include: { permissions: { include: { permission: true } } }
    });
    res.json(roles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createRole = async (req, res) => {
  try {
    const { name, description, permissionKeys = [] } = req.body;
    
    const permissions = await prisma.permission.findMany({
      where: { key: { in: permissionKeys } }
    });

    const role = await prisma.roleDefinition.create({
      data: {
        name,
        description,
        permissions: {
          create: permissions.map(p => ({ permissionId: p.id }))
        }
      },
      include: { permissions: { include: { permission: true } } }
    });
    res.status(201).json(role);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const editRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, permissionKeys = [] } = req.body;

    // Sincronizar permisos: borrar existentes y crear nuevos
    await prisma.rolePermission.deleteMany({ where: { roleId: id } });

    const permissions = await prisma.permission.findMany({
      where: { key: { in: permissionKeys } }
    });

    const role = await prisma.roleDefinition.update({
      where: { id },
      data: {
        name,
        description,
        permissions: {
          create: permissions.map(p => ({ permissionId: p.id }))
        }
      },
      include: { permissions: { include: { permission: true } } }
    });
    res.json(role);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteRole = async (req, res) => {
  try {
    const role = await prisma.roleDefinition.findUnique({ where: { id: req.params.id } });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.isSystem) return res.status(403).json({ error: 'Cannot delete system role' });

    await prisma.roleDefinition.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date(), isActive: false }
    });
    res.json({ message: 'Role deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const listPermissions = async (req, res) => {
  try {
    const permissions = await prisma.permission.findMany();
    res.json(permissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ==========================================
// FEATURE FLAGS
// ==========================================
const listFeatureFlags = async (req, res) => {
  try {
    const flags = await prisma.featureFlag.findMany();
    res.json(flags);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const toggleFeatureFlag = async (req, res) => {
  try {
    const { isEnabled } = req.body;
    const flag = await prisma.featureFlag.update({
      where: { key: req.params.key },
      data: { isEnabled, updatedBy: req.user.id }
    });
    res.json(flag);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ==========================================
// PLANES
// ==========================================
const listPlans = async (req, res) => {
  try {
    const plans = await prisma.plan.findMany({
      where: { deletedAt: null },
      include: { features: true }
    });
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createPlan = async (req, res) => {
  try {
    const { name, price, interval, features = [] } = req.body;
    const plan = await prisma.plan.create({
      data: {
        name,
        price,
        interval,
        features: {
          create: features.map(f => ({
            featureKey: f.featureKey,
            limitType: f.limitType,
            limitValue: f.limitValue
          }))
        }
      },
      include: { features: true }
    });
    res.status(201).json(plan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const editPlan = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, interval, features = [] } = req.body;

    await prisma.planFeature.deleteMany({ where: { planId: id } });

    const plan = await prisma.plan.update({
      where: { id },
      data: {
        name,
        price,
        interval,
        features: {
          create: features.map(f => ({
            featureKey: f.featureKey,
            limitType: f.limitType,
            limitValue: f.limitValue
          }))
        }
      },
      include: { features: true }
    });
    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const disablePlan = async (req, res) => {
  try {
    const plan = await prisma.plan.update({
      where: { id: req.params.id },
      data: { isActive: false, deletedAt: new Date() }
    });
    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ==========================================
// RANGOS Y CATEGORÍAS
// ==========================================
const listRanks = async (req, res) => {
  try {
    const ranks = await prisma.rank.findMany({ where: { deletedAt: null }, orderBy: { order: 'asc' } });
    res.json(ranks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createRank = async (req, res) => {
  try {
    const rank = await prisma.rank.create({ data: req.body });
    res.status(201).json(rank);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const editRank = async (req, res) => {
  try {
    const rank = await prisma.rank.update({
      where: { id: req.params.id },
      data: req.body
    });
    res.json(rank);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const listCategories = async (req, res) => {
  try {
    const categories = await prisma.category.findMany({ where: { deletedAt: null } });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createCategory = async (req, res) => {
  try {
    const category = await prisma.category.create({ data: req.body });
    res.status(201).json(category);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


const editCategory,
  deleteRank,
  deleteCategory = async (req, res) => {
  try {
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: req.body
    });
    
    await prisma.auditLog.create({
      data: { userId: req.user.id, action: 'EDIT_CATEGORY', entityId: category.id, entityType: 'CATEGORY' }
    });
    
    res.json(category);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteRank = async (req, res) => {
  try {
    const rank = await prisma.rank.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() }
    });
    await prisma.auditLog.create({
      data: { userId: req.user.id, action: 'DELETE_RANK', entityId: rank.id, entityType: 'RANK' }
    });
    res.json({ message: 'Rank deleted', rank });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() }
    });
    await prisma.auditLog.create({
      data: { userId: req.user.id, action: 'DELETE_CATEGORY', entityId: category.id, entityType: 'CATEGORY' }
    });
    res.json({ message: 'Category deleted', category });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ==========================================
// AUDITORÍA
// ==========================================
const listAuditLogs = async (req, res) => {
  try {
    const { userId, action, entityType, page = 1, limit = 50 } = req.query;
    const where = {};

    if (userId) where.userId = userId;
    if (action) where.action = action;
    if (entityType) where.entityType = entityType;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const logs = await prisma.auditLog.findMany({
      where,
      skip,
      take: parseInt(limit),
      orderBy: { createdAt: 'desc' },
      include: { user: true }
    });

    const total = await prisma.auditLog.count({ where });

    res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getAuditLogDetails = async (req, res) => {
  try {
    const log = await prisma.auditLog.findUnique({
      where: { id: req.params.id },
      include: { user: true }
    });
    if (!log) return res.status(404).json({ error: 'Audit log not found' });
    res.json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deletePost = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.post.update({
      where: { id },
      data: { deletedAt: new Date() }
    });
    // Audit log
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'DELETE_POST',
        entityId: id,
        entityType: 'POST',
        metadata: { reason: req.body.reason || 'Admin moderation' }
      }
    });
    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteGroup = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.group.update({
      where: { id },
      data: { deletedAt: new Date() }
    });
    // Audit log
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'DELETE_GROUP',
        entityId: id,
        entityType: 'GROUP',
        details: { reason: req.body.reason || 'Admin moderation' }
      }
    });
    res.json({ message: 'Group deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ==========================================
// EJERCICIOS (Global Library)
// ==========================================
const listAdminExercises = async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const where = { deletedAt: null };

    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const exercises = await prisma.exercise.findMany({
      where,
      skip,
      take: parseInt(limit),
      orderBy: { name: 'asc' }
    });

    const total = await prisma.exercise.count({ where });

    res.json({ exercises, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createExercise = async (req, res) => {
  try {
    const { name, description, primaryMuscle, secondaryMuscles, equipment, mechanics, difficulty, gifUrl, videoUrl } = req.body;
    const exercise = await prisma.exercise.create({
      data: { name, description, primaryMuscle, secondaryMuscles, equipment, mechanics, difficulty, gifUrl, videoUrl }
    });
    res.status(201).json(exercise);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const editExercise = async (req, res) => {
  try {
    const { name, description, primaryMuscle, secondaryMuscles, equipment, mechanics, difficulty, gifUrl, videoUrl } = req.body;
    const exercise = await prisma.exercise.update({
      where: { id: req.params.id },
      data: { name, description, primaryMuscle, secondaryMuscles, equipment, mechanics, difficulty, gifUrl, videoUrl }
    });
    res.json(exercise);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteExercise = async (req, res) => {
  try {
    await prisma.exercise.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() }
    });
    res.json({ message: 'Exercise deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getStats,
  listUsers,
  getUserDetails,
  createUser,
  editUser,
  deleteUser,
  banUser,
  restoreUser,
  listRoles,
  createRole,
  editRole,
  deleteRole,
  listPermissions,
  listFeatureFlags,
  toggleFeatureFlag,
  listPlans,
  createPlan,
  editPlan,
  disablePlan,
  listRanks,
  createRank,
  editRank,
  listCategories,
  createCategory,
  editCategory,
  listAuditLogs,
  getAuditLogDetails,
  deletePost,
  deleteGroup,
  listAdminExercises,
  createExercise,
  editExercise,
  deleteExercise
};
