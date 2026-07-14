const prisma = require('../lib/prisma');

/**
 * Middleware Express que ejecuta el resto de la cadena de middlewares/controller
 * dentro de un contexto AsyncLocalStorage con el actor (usuario, IP, user-agent).
 * La interceptacion real de create/update/delete/upsert (Prisma Client Extension)
 * vive en lib/prisma.js; este middleware solo provee el contexto del actor por request.
 * Nota: req.user puede no estar seteado aun en este punto si va antes de authenticateToken;
 * se resuelve leyendo req.user de forma perezosa via un getter en el store.
 */
const auditContextMiddleware = (req, res, next) => {
  const actor = {
    get userId() { return req.user?.id || null; },
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] || null
  };
  prisma.runWithActor(actor, () => next());
};

module.exports = {
  auditContextMiddleware,
  getCurrentActor: prisma.getCurrentActor
};
