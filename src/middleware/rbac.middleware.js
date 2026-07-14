const prisma = require('../lib/prisma');

/**
 * Devuelve el set de permission keys que tiene un usuario, combinando:
 * - Permisos del enum Role legado (ADMIN tiene wildcard "*")
 * - Permisos de los RoleDefinition asignados via UserRole
 */
const getUserPermissions = async (userId, legacyRole) => {
  if (legacyRole === 'ADMIN') {
    return new Set(['*']);
  }

  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: {
      role: {
        include: { permissions: { include: { permission: true } } }
      }
    }
  });

  const permissions = new Set();
  for (const ur of userRoles) {
    if (!ur.role.isActive || ur.role.deletedAt) continue;
    for (const rp of ur.role.permissions) {
      permissions.add(rp.permission.key);
    }
  }
  return permissions;
};

/**
 * Middleware que exige que el usuario autenticado tenga uno de los permission keys dados.
 * ADMIN (legacy role) siempre pasa. Uso: requirePermission('groups.create')
 */
const requirePermission = (...requiredKeys) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const permissions = await getUserPermissions(req.user.id, req.user.role);

      if (permissions.has('*')) {
        return next();
      }

      const hasPermission = requiredKeys.some((key) => permissions.has(key));
      if (!hasPermission) {
        return res.status(403).json({ error: 'Insufficient permissions', required: requiredKeys });
      }

      next();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };
};

module.exports = {
  getUserPermissions,
  requirePermission
};
