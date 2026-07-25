require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  console.log('Starting seed...');

  const hashedPassword = await bcrypt.hash('demo123', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@jnsix.com' },
    update: {},
    create: {
      email: 'admin@jnsix.com',
      password: hashedPassword,
      role: 'ADMIN'
    }
  });

  console.log('Admin user created:', admin.email);

  const athlete = await prisma.user.upsert({
    where: { email: 'athlete@jnsix.com' },
    update: {},
    create: {
      email: 'athlete@jnsix.com',
      password: hashedPassword,
      role: 'ATHLETE'
    }
  });

  console.log('Athlete user created:', athlete.email);

  // Crear planes PRO necesarios para pagos y suscripciones
  const proPlan = await prisma.plan.upsert({
    where: { name: 'PRO' },
    update: {},
    create: {
      name: 'PRO',
      price: 9.99,
      interval: 'MONTHLY',
      features: {
        create: [
          { featureKey: 'advanced_analytics' },
          { featureKey: 'unlimited_activities' },
          { featureKey: 'ai_coach' }
        ]
      }
    }
  });

  const proYearlyPlan = await prisma.plan.upsert({
    where: { name: 'PRO_YEARLY' },
    update: {},
    create: {
      name: 'PRO_YEARLY',
      price: 99.99,
      interval: 'YEARLY',
      features: {
        create: [
          { featureKey: 'advanced_analytics' },
          { featureKey: 'unlimited_activities' },
          { featureKey: 'ai_coach' }
        ]
      }
    }
  });

  console.log('Plans created:', proPlan.name, proYearlyPlan.name);

  // Seed feature flags para que los módulos sociales/gamificación estén habilitados
  const flags = [
    { key: 'feed_enabled', name: 'Feed' },
    { key: 'chat_enabled', name: 'Chat' },
    { key: 'groups_enabled', name: 'Grupos' },
    { key: 'communities_enabled', name: 'Comunidades' },
    { key: 'rankings_enabled', name: 'Rankings' },
    { key: 'challenges_enabled', name: 'Retos' },
    { key: 'stories_enabled', name: 'Stories' }
  ];
  for (const flag of flags) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: { isEnabled: true, name: flag.name },
      create: { ...flag, isEnabled: true }
    });
  }
  console.log('Feature flags seeded');

  const activities = [
    {
      name: 'Trail Running - Montaña Alta',
      type: 'TRAIL_RUN',
      distanceKm: 15.3,
      elevationM: 845,
      movingTime: 6420,
      startDate: new Date('2024-05-15T07:30:00'),
      averageHr: 165,
      maxHr: 182,
      calories: 1250,
      isExternal: false
    },
    {
      name: 'Carrera Larga - Ruta Plana',
      type: 'RUN',
      distanceKm: 21.1,
      elevationM: 120,
      movingTime: 7380,
      startDate: new Date('2024-05-18T06:00:00'),
      averageHr: 152,
      maxHr: 168,
      calories: 1580,
      isExternal: false
    },
    {
      name: 'Intervalos en Pista',
      type: 'RUN',
      distanceKm: 10.0,
      elevationM: 15,
      movingTime: 2940,
      startDate: new Date('2024-05-20T18:00:00'),
      averageHr: 172,
      maxHr: 189,
      calories: 720,
      isExternal: false
    },
    {
      name: 'Trail Técnico - Sendero Rocoso',
      type: 'TRAIL_RUN',
      distanceKm: 12.5,
      elevationM: 1120,
      movingTime: 6180,
      startDate: new Date('2024-05-22T08:00:00'),
      averageHr: 168,
      maxHr: 185,
      calories: 1180,
      isExternal: false
    },
    {
      name: 'Recuperación Activa',
      type: 'RUN',
      distanceKm: 8.0,
      elevationM: 45,
      movingTime: 2880,
      startDate: new Date('2024-05-24T07:00:00'),
      averageHr: 138,
      maxHr: 152,
      calories: 520,
      isExternal: false
    }
  ];

  console.log('Creating activities...');

  for (const activityData of activities) {
    const activity = await prisma.activity.create({
      data: {
        ...activityData,
        userId: athlete.id
      }
    });

    const laps = generateLaps(activity.distanceKm, activity.movingTime, activity.elevationM);
    
    for (const lap of laps) {
      await prisma.activityLap.create({
        data: {
          ...lap,
          activityId: activity.id
        }
      });
    }

    console.log(`Activity created: ${activity.name}`);
  }

  const allActivities = await prisma.activity.findMany({
    where: { userId: athlete.id },
    orderBy: { startDate: 'desc' },
    take: 3
  });

  if (allActivities.length >= 2) {
    const comparison = await prisma.activityComparison.create({
      data: {
        userId: athlete.id,
        name: 'Comparación Trail vs Ruta',
        description: 'Análisis de rendimiento en diferentes terrenos',
        activities: {
          create: [
            {
              activityId: allActivities[0].id,
              color: '#00E5FF',
              label: 'Trail Técnico'
            },
            {
              activityId: allActivities[1].id,
              color: '#FF2A5F',
              label: 'Carrera Plana'
            }
          ]
        }
      }
    });

    console.log('Comparison created:', comparison.name);
  }

  try {
    const { seedMissions } = require('../seed_missions');
    await seedMissions(prisma);
  } catch (e) {
    console.warn('Mission seed skipped:', e.message);
  }

  console.log('Seed completed successfully!');
}

function generateLaps(totalDistance, totalTime, totalElevation) {
  const numLaps = Math.floor(totalDistance);
  const laps = [];
  const baseTime = totalTime / totalDistance;
  const baseElevation = totalElevation / numLaps;

  for (let i = 1; i <= numLaps; i++) {
    const variation = (Math.random() - 0.5) * 0.3;
    const timeForLap = baseTime * (1 + variation);
    const elevationForLap = baseElevation * (0.5 + Math.random());

    laps.push({
      splitNum: i,
      distance: 1.0,
      elevationGain: Math.round(elevationForLap),
      averagePace: timeForLap / 60,
      averageHr: Math.round(150 + Math.random() * 30),
      maxHr: Math.round(160 + Math.random() * 30)
    });
  }

  return laps;
}

main()
  .catch((e) => {
    console.error('Error during seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
