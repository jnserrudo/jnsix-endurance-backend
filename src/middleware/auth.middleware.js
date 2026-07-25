const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Se requiere iniciar sesión' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        stravaId: true
      }
    });

    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(403).json({ error: 'Sesión inválida. Volvé a iniciar sesión.' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(403).json({ error: 'Tu sesión expiró. Volvé a iniciar sesión.' });
    }
    return res.status(500).json({ error: 'Error de autenticación' });
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Se requiere iniciar sesión' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'No tenés permiso para esta acción',
        code: 'INSUFFICIENT_ROLE',
        role: req.user.role,
        required: roles
      });
    }

    next();
  };
};

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          stravaId: true
        }
      });
      req.user = user;
    }

    next();
  } catch (error) {
    next();
  }
};

module.exports = {
  authenticateToken,
  requireRole,
  optionalAuth
};
