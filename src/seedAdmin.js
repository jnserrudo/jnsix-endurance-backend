require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const PERMISSIONS = [
  { key: 'users.view', module: 'users', description: 'Ver listado de usuarios' },
  { key: 'users.edit', module: 'users', description: 'Editar datos de usuarios' },
  { key: 'users.ban', module: 'users', description: 'Banear/reactivar usuarios' },
  { key: 'roles.manage', module: 'roles', description: 'Crear/editar roles y permisos' },
  { key: 'groups.create', module: 'groups', description: 'Crear grupos' },
  { key: 'groups.edit', module: 'groups', description: 'Editar cualquier grupo' },
  { key: 'groups.disable', module: 'groups', description: 'Deshabilitar cualquier grupo' },
  { key: 'communities.create', module: 'communities', description: 'Crear comunidades' },
  { key: 'communities.edit', module: 'communities', description: 'Editar cualquier comunidad' },
  { key: 'communities.disable', module: 'communities', description: 'Deshabilitar cualquier comunidad' },
  { key: 'challenges.create_global', module: 'challenges', description: 'Crear retos globales' },
  { key: 'challenges.edit', module: 'challenges', description: 'Editar cualquier reto' },
  { key: 'challenges.disable', module: 'challenges', description: 'Deshabilitar cualquier reto' },
  { key: 'rankings.manage', module: 'rankings', description: 'Configurar rangos y categorias' },
  { key: 'plans.manage', module: 'plans', description: 'Gestionar planes, features y precios' },
  { key: 'feature_flags.manage', module: 'feature_flags', description: 'Encender/apagar modulos completos' },
  { key: 'audit.view', module: 'audit', description: 'Ver el log de auditoria completo' },
  { key: 'notifications.manage', module: 'notifications', description: 'Enviar notificaciones/broadcast y ver plantillas' },
  { key: 'businesses.moderate', module: 'marketplace', description: 'Aprobar/rechazar negocios del marketplace' },
  { key: 'rewards.moderate', module: 'marketplace', description: 'Moderar recompensas del marketplace' },
  { key: 'business.profile.manage', module: 'marketplace', description: 'Gestionar perfil de negocio' },
  { key: 'rewards.manage', module: 'marketplace', description: 'Gestionar recompensas del negocio' },
  { key: 'redemptions.validate', module: 'marketplace', description: 'Validar cupones canjeados' }
];

const ROLE_DEFINITIONS = [
  { name: 'ADMIN', description: 'Administrador del sistema (acceso total, via role legado)', isSystem: true, permissions: [] },
  { name: 'ATHLETE', description: 'Usuario atleta estandar', isSystem: true, permissions: [] },
  {
    name: 'MODERATOR',
    description: 'Moderador de contenido y comunidad',
    isSystem: false,
    permissions: ['users.view', 'groups.edit', 'groups.disable', 'communities.edit', 'communities.disable', 'audit.view']
  },
  {
    name: 'COACH',
    description: 'Entrenador con vista sobre sus atletas',
    isSystem: false,
    permissions: ['users.view', 'challenges.create_global', 'challenges.edit']
  },
  {
    name: 'BUSINESS',
    description: 'Negocio adherido al marketplace de recompensas',
    isSystem: true,
    permissions: ['business.profile.manage', 'rewards.manage', 'redemptions.validate']
  }
];

const FEATURE_FLAGS = [
  { key: 'chat_enabled', name: 'Chat en tiempo real', description: 'Habilita el modulo de chat (Socket.io)' },
  { key: 'friends_enabled', name: 'Amigos', description: 'Habilita el modulo de solicitudes de amistad' },
  { key: 'rankings_enabled', name: 'Rankings', description: 'Habilita rankings/rangos/categorias' },
  { key: 'challenges_enabled', name: 'Retos', description: 'Habilita el modulo de retos/challenges' },
  { key: 'groups_enabled', name: 'Grupos', description: 'Habilita grupos/subgrupos de amigos' },
  { key: 'communities_enabled', name: 'Comunidades', description: 'Habilita comunidades regionales/tematicas' },
  { key: 'feed_enabled', name: 'Feed social', description: 'Habilita el feed de posts/comentarios/reacciones' },
  { key: 'notifications_push_enabled', name: 'Push notifications', description: 'Habilita el envio de notificaciones push (Expo)' },
  { key: 'notifications_email_enabled', name: 'Email notifications', description: 'Habilita el envio de emails (resumenes/alertas)' },
  { key: 'plans_enabled', name: 'Planes y limites', description: 'Habilita el enforcement de planes/features' },
  { key: 'rewards_marketplace_enabled', name: 'Marketplace de Recompensas', description: 'Habilita el club de beneficios y canje de puntos' }
];

const PLANS = [
  {
    name: 'Free',
    price: 0,
    currency: 'USD',
    interval: 'MONTHLY',
    features: [
      { featureKey: 'comparisons.max', limitType: 'SOFT_BLOCK', limitValue: 3 },
      { featureKey: 'ai_coach.daily_limit', limitType: 'SOFT_BLOCK', limitValue: 5 },
      { featureKey: 'challenges.create_global', limitType: 'HARD_BLOCK', limitValue: 0 },
      { featureKey: 'communities.create', limitType: 'HARD_BLOCK', limitValue: 0 },
      { featureKey: 'analytics.advanced', limitType: 'HARD_BLOCK', limitValue: 0 },
      { featureKey: 'activities.history_days', limitType: 'SOFT_BLOCK', limitValue: 90 }
    ]
  },
  {
    name: 'Pro',
    price: 9.99,
    currency: 'USD',
    interval: 'MONTHLY',
    features: [
      { featureKey: 'comparisons.max', limitType: 'UNLIMITED', limitValue: null },
      { featureKey: 'ai_coach.daily_limit', limitType: 'UNLIMITED', limitValue: null },
      { featureKey: 'challenges.create_global', limitType: 'HARD_BLOCK', limitValue: 0 },
      { featureKey: 'communities.create', limitType: 'UNLIMITED', limitValue: null },
      { featureKey: 'analytics.advanced', limitType: 'UNLIMITED', limitValue: null },
      { featureKey: 'activities.history_days', limitType: 'UNLIMITED', limitValue: null }
    ]
  },
  {
    name: 'Coach',
    price: 19.99,
    currency: 'USD',
    interval: 'MONTHLY',
    features: [
      { featureKey: 'comparisons.max', limitType: 'UNLIMITED', limitValue: null },
      { featureKey: 'ai_coach.daily_limit', limitType: 'UNLIMITED', limitValue: null },
      { featureKey: 'challenges.create_global', limitType: 'UNLIMITED', limitValue: null },
      { featureKey: 'communities.create', limitType: 'UNLIMITED', limitValue: null },
      { featureKey: 'analytics.advanced', limitType: 'UNLIMITED', limitValue: null },
      { featureKey: 'activities.history_days', limitType: 'UNLIMITED', limitValue: null }
    ]
  }
];

const RANKS = [
  { name: 'Bronce', minPoints: 0, maxPoints: 999, order: 1 },
  { name: 'Plata', minPoints: 1000, maxPoints: 2999, order: 2 },
  { name: 'Oro', minPoints: 3000, maxPoints: 6999, order: 3 },
  { name: 'Diamante', minPoints: 7000, maxPoints: null, order: 4 }
];

const CATEGORIES = [
  { name: 'General', criteria: null }
];

async function main() {
  console.log('Starting admin/RBAC seed...');

  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: perm.key },
      update: { description: perm.description, module: perm.module },
      create: perm
    });
  }
  console.log(`Permissions seeded: ${PERMISSIONS.length}`);

  for (const roleDef of ROLE_DEFINITIONS) {
    const role = await prisma.roleDefinition.upsert({
      where: { name: roleDef.name },
      update: { description: roleDef.description, isSystem: roleDef.isSystem },
      create: {
        name: roleDef.name,
        description: roleDef.description,
        isSystem: roleDef.isSystem
      }
    });

    for (const permKey of roleDef.permissions) {
      const permission = await prisma.permission.findUnique({ where: { key: permKey } });
      if (!permission) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id }
      });
    }
  }
  console.log(`Role definitions seeded: ${ROLE_DEFINITIONS.length}`);

  for (const flag of FEATURE_FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: {},
      create: { ...flag, isEnabled: true }
    });
  }
  console.log(`Feature flags seeded: ${FEATURE_FLAGS.length}`);

  for (const planDef of PLANS) {
    const plan = await prisma.plan.upsert({
      where: { name: planDef.name },
      update: { price: planDef.price, currency: planDef.currency, interval: planDef.interval },
      create: {
        name: planDef.name,
        price: planDef.price,
        currency: planDef.currency,
        interval: planDef.interval
      }
    });

    for (const feature of planDef.features) {
      await prisma.planFeature.upsert({
        where: { planId_featureKey: { planId: plan.id, featureKey: feature.featureKey } },
        update: { limitType: feature.limitType, limitValue: feature.limitValue },
        create: { planId: plan.id, ...feature }
      });
    }
  }
  console.log(`Plans seeded: ${PLANS.length}`);

  for (const rank of RANKS) {
    await prisma.rank.upsert({
      where: { name: rank.name },
      update: { minPoints: rank.minPoints, maxPoints: rank.maxPoints, order: rank.order },
      create: rank
    });
  }
  console.log(`Ranks seeded: ${RANKS.length}`);

  for (const category of CATEGORIES) {
    await prisma.category.upsert({
      where: { name: category.name },
      update: {},
      create: category
    });
  }
  console.log(`Categories seeded: ${CATEGORIES.length}`);

  console.log('Admin/RBAC seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('Error during admin seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
