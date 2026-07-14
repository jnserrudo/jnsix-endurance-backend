const prisma = require('../lib/prisma');

/**
 * Middleware que exige que un feature flag este habilitado para permitir el acceso al modulo.
 * Uso: requireFeatureEnabled('chat_enabled')
 */
const requireFeatureEnabled = (key) => {
  return async (req, res, next) => {
    try {
      const flag = await prisma.featureFlag.findUnique({ where: { key } });

      // Si el flag no existe todavia, se asume habilitado (fail-open) para no romper features nuevas sin seed.
      if (!flag) {
        return next();
      }

      if (!flag.isEnabled) {
        return res.status(503).json({ error: 'Feature temporarily disabled', feature: key });
      }

      next();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };
};

/**
 * Devuelve todos los feature flags en formato { key: isEnabled } para exponer al cliente.
 */
const getAllFlags = async () => {
  const flags = await prisma.featureFlag.findMany();
  return flags.reduce((acc, f) => {
    acc[f.key] = f.isEnabled;
    return acc;
  }, {});
};

module.exports = {
  requireFeatureEnabled,
  getAllFlags
};
