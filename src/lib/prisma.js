const { PrismaClient } = require('@prisma/client');
const { AsyncLocalStorage } = require('async_hooks');

// Contexto por request (usuario/IP/user-agent), seguro entre requests concurrentes.
const actorStorage = new AsyncLocalStorage();
const getCurrentActor = () => actorStorage.getStore() || null;
const runWithActor = (actor, fn) => actorStorage.run(actor, fn);

// Cliente base (sin extension) usado internamente solo para escribir el AuditLog,
// evitando que la propia escritura de auditoria vuelva a disparar la extension (loop infinito).
const basePrisma = global.__basePrismaClient || new PrismaClient();

const EXCLUDED_MODELS = new Set(['AuditLog']);
const AUDITABLE_OPERATIONS = new Set(['create', 'update', 'delete', 'upsert', 'updateMany', 'deleteMany']);

const safeSerialize = (obj) => {
  try {
    const str = JSON.stringify(obj);
    return str.length > 5000 ? JSON.parse(str.slice(0, 5000)) : JSON.parse(str);
  } catch {
    return null;
  }
};

const writeAuditLog = (model, operation, result, args) => {
  const actor = getCurrentActor();
  basePrisma.auditLog.create({
    data: {
      userId: actor?.userId || null,
      action: `${model.toLowerCase()}.${operation}`,
      entityType: model,
      entityId: result?.id || null,
      metadata: { args: safeSerialize(args) },
      ipAddress: actor?.ipAddress || null,
      userAgent: actor?.userAgent || null
    }
  }).catch((err) => {
    console.error('[AuditLog] Failed to write audit entry:', err.message);
  });
};

// Cliente extendido: toda la app usa este. Intercepta create/update/delete/upsert
// sobre cualquier modelo (excepto AuditLog) y registra un AuditLog de forma
// asincrona (fire-and-forget) sin bloquear la respuesta original.
const extendedPrisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const result = await query(args);
        if (model && !EXCLUDED_MODELS.has(model) && AUDITABLE_OPERATIONS.has(operation)) {
          writeAuditLog(model, operation, result, args);
        }
        return result;
      }
    }
  }
});

if (process.env.NODE_ENV !== 'production') {
  global.__basePrismaClient = basePrisma;
}

module.exports = extendedPrisma;
module.exports.getCurrentActor = getCurrentActor;
module.exports.runWithActor = runWithActor;
