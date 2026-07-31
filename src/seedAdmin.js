require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PERMISSIONS, ROLE_DEFINITIONS } = require('./data/rbac');

const prisma = new PrismaClient();

const FEATURE_FLAGS = [
  { key: 'chat_enabled', name: 'Chat en tiempo real', description: 'Habilita el modulo de chat (Socket.io)' },
  { key: 'friends_enabled', name: 'Amigos', description: 'Habilita el modulo de solicitudes de amistad' },
  { key: 'rankings_enabled', name: 'Rankings', description: 'Habilita rankings/rangos/categorias' },
  { key: 'challenges_enabled', name: 'Retos', description: 'Habilita el modulo de retos/challenges' },
  { key: 'stories_enabled', name: 'Stories', description: 'Habilita stories efimeras (24h)' },
  { key: 'groups_enabled', name: 'Grupos', description: 'Habilita grupos/subgrupos de amigos' },
  { key: 'communities_enabled', name: 'Comunidades', description: 'Habilita comunidades regionales/tematicas' },
  { key: 'feed_enabled', name: 'Feed social', description: 'Habilita el feed de posts/comentarios/reacciones' },
  { key: 'notifications_push_enabled', name: 'Push notifications', description: 'Habilita el envio de notificaciones push (Expo)' },
  { key: 'notifications_email_enabled', name: 'Email notifications', description: 'Habilita el envio de emails (resumenes/alertas)' },
  { key: 'plans_enabled', name: 'Planes y limites', description: 'Habilita el enforcement de planes/features' },
  { key: 'rewards_marketplace_enabled', name: 'Marketplace de Recompensas', description: 'Habilita el club de beneficios y canje de puntos' }
];

/** Flags that seed must leave enabled (product defaults for Epic social modules). */
const FORCE_ENABLED_FLAGS = new Set([
  'chat_enabled',
  'challenges_enabled',
  'rankings_enabled',
  'stories_enabled',
]);

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
    const forceOn = FORCE_ENABLED_FLAGS.has(flag.key);
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: forceOn
        ? { name: flag.name, description: flag.description, isEnabled: true }
        : { name: flag.name, description: flag.description },
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

  try {
    const { seedMissions } = require('../seed_missions');
    await seedMissions(prisma);
  } catch (e) {
    console.warn('Mission seed skipped:', e.message);
  }

  try {
    const { seedBadges } = require('./data/defaultBadges');
    await seedBadges(prisma);
  } catch (e) {
    console.warn('Badge seed skipped:', e.message);
  }

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
