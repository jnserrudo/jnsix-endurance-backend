const prisma = require('../lib/prisma');

/**
 * Funciones de conteo de uso por feature key.
 * Cada función cuenta el uso actual del usuario para decidir si se excedió el límite.
 */
const USAGE_COUNTERS = {
  'ai_coach.daily_limit': async (userId) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return prisma.aIAnalysis.count({
      where: { userId, createdAt: { gte: today } }
    });
  },
  'comparisons.max': async (userId) => {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    return prisma.activityComparison.count({
      where: { userId, createdAt: { gte: startOfMonth } }
    });
  },
  'communities.create': async (userId) => {
    return prisma.community.count({
      where: { createdById: userId, deletedAt: null }
    });
  },
  'challenges.create_global': async (userId) => {
    return prisma.challenge.count({
      where: { createdById: userId, type: 'GLOBAL', deletedAt: null }
    });
  }
};

/**
 * Resuelve el plan activo de un usuario.
 * Si no tiene suscripción activa, devuelve el plan "Free".
 */
const getActivePlan = async (userId) => {
  const subscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: 'ACTIVE',
      isActive: true,
      deletedAt: null,
      OR: [
        { endDate: null },
        { endDate: { gte: new Date() } }
      ]
    },
    include: { plan: { include: { features: true } } },
    orderBy: { startDate: 'desc' }
  });

  if (subscription) {
    return subscription.plan;
  }

  // Fallback: plan Free
  const freePlan = await prisma.plan.findUnique({
    where: { name: 'Free' },
    include: { features: true }
  });

  return freePlan;
};

/**
 * Middleware que verifica si el usuario puede usar una feature según su plan.
 * Uso: checkPlanLimit('ai_coach.daily_limit')
 */
const checkPlanLimit = (featureKey) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // ADMIN legacy siempre pasa
      if (req.user.role === 'ADMIN') {
        return next();
      }

      const plan = await getActivePlan(req.user.id);

      if (!plan) {
        // Sin plan configurado, fail-open
        return next();
      }

      const feature = plan.features.find((f) => f.featureKey === featureKey);

      if (!feature) {
        // Feature no configurada en este plan, fail-open
        return next();
      }

      if (feature.limitType === 'UNLIMITED') {
        return next();
      }

      if (feature.limitType === 'HARD_BLOCK' && feature.limitValue === 0) {
        return res.status(403).json({
          error: 'Esta función no está disponible en tu plan actual',
          feature: featureKey,
          plan: plan.name,
          upgrade: true
        });
      }

      // SOFT_BLOCK con límite numérico
      const counter = USAGE_COUNTERS[featureKey];
      if (!counter) {
        // Sin counter definido, fail-open
        return next();
      }

      const currentUsage = await counter(req.user.id);

      if (currentUsage >= feature.limitValue) {
        return res.status(429).json({
          error: 'Límite de plan alcanzado',
          feature: featureKey,
          plan: plan.name,
          currentUsage,
          limit: feature.limitValue,
          upgrade: true
        });
      }

      next();
    } catch (error) {
      // En caso de error, fail-open para no bloquear al usuario
      console.error('[PlanEnforcement] Error:', error.message);
      next();
    }
  };
};

module.exports = {
  checkPlanLimit,
  getActivePlan
};
