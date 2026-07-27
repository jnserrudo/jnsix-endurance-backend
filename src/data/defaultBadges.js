/**
 * Catálogo base de insignias (usado por gamification + seedAdmin).
 * Vive en src/ para que siempre se despliegue con el backend.
 */

const DEFAULT_BADGES = [
  {
    code: 'first_post',
    name: 'Primera publicación',
    description: 'Publicaste tu primer post en el feed.',
    criteria: { type: 'FIRST_POST', target: 1 },
  },
  {
    code: 'first_activity',
    name: 'Primer entrenamiento',
    description: 'Registraste tu primera actividad.',
    criteria: { type: 'FIRST_ACTIVITY', target: 1 },
  },
  {
    code: 'streak_7',
    name: 'Racha de 7',
    description: 'Entrenaste 7 días seguidos.',
    criteria: { type: 'STREAK', target: 7 },
  },
  {
    code: 'streak_30',
    name: 'Racha de 30',
    description: 'Entrenaste 30 días seguidos.',
    criteria: { type: 'STREAK', target: 30 },
  },
  {
    code: 'distance_100',
    name: '100 km',
    description: 'Acumulaste 100 km en total.',
    criteria: { type: 'TOTAL_DISTANCE', target: 100 },
  },
  {
    code: 'distance_500',
    name: '500 km',
    description: 'Acumulaste 500 km en total.',
    criteria: { type: 'TOTAL_DISTANCE', target: 500 },
  },
  {
    code: 'activities_10',
    name: '10 sesiones',
    description: 'Completaste 10 actividades.',
    criteria: { type: 'ACTIVITY_COUNT', target: 10 },
  },
  {
    code: 'social_combo',
    name: 'Combo social',
    description: 'Entrenaste, publicaste y reaccionaste el mismo día.',
    criteria: { type: 'DAILY_COMBO', target: 1 },
  },
  {
    code: 'duel_win',
    name: 'Duelo ganado',
    description: 'Ganaste tu primer duelo semanal.',
    criteria: { type: 'DUEL_WIN', target: 1 },
  },
  {
    code: 'rain_run',
    name: 'Corrida bajo lluvia',
    description: 'Entrenaste bajo la lluvia (lluvia/rain en el nombre o descripción).',
    criteria: { type: 'FIRST_RAIN_RUN', target: 1 },
  },
  {
    code: 'local_client',
    name: 'Cliente local',
    description: 'Hiciste check-in en un negocio adherido del Club.',
    criteria: { type: 'BUSINESS_CHECK_IN', target: 1 },
  },
];

async function seedBadges(client, { silent = false } = {}) {
  if (!client) {
    throw new Error('seedBadges requires a Prisma client');
  }
  if (!silent) console.log('Seeding Badges...');
  for (const b of DEFAULT_BADGES) {
    await client.badge.upsert({
      where: { code: b.code },
      update: {
        name: b.name,
        description: b.description,
        criteria: b.criteria,
      },
      create: {
        code: b.code,
        name: b.name,
        description: b.description,
        criteria: b.criteria,
      },
    });
  }
  if (!silent) console.log(`Badges seeded: ${DEFAULT_BADGES.length}`);
  return DEFAULT_BADGES;
}

async function ensureBadgesExist(client) {
  if (!client) {
    throw new Error('ensureBadgesExist requires a Prisma client');
  }
  // Siempre upsert del catálogo para incorporar badges nuevos.
  await seedBadges(client, { silent: true });
  return client.badge.findMany({ orderBy: { createdAt: 'asc' } });
}

module.exports = { DEFAULT_BADGES, seedBadges, ensureBadgesExist };
