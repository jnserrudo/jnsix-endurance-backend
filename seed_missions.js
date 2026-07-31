const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Pool de misiones: permanentes + rotables diarias/semanales. */
function buildMissionPool() {
  const today = startOfDay();
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 7);
  const farFuture = addDays(today, 365 * 10);

  return [
    // Permanentes (onboarding)
    {
      name: 'Primera Carrera',
      description: 'Completá tu primera actividad.',
      type: 'FIRST_ACTIVITY',
      targetValue: 1,
      rewardPts: 50,
      isActive: true,
      startDate: today,
      endDate: farFuture,
    },
    {
      name: 'Constancia Inicial',
      description: 'Alcanzá una racha de 3 días consecutivos.',
      type: 'STREAK',
      targetValue: 3,
      rewardPts: 100,
      isActive: true,
      startDate: today,
      endDate: farFuture,
    },
    {
      name: 'Corredor Experto',
      description: 'Acumulá 50 km de distancia total.',
      type: 'TOTAL_DISTANCE',
      targetValue: 50,
      rewardPts: 300,
      isActive: true,
      startDate: today,
      endDate: farFuture,
    },
    // Diarias (rotan cada día vía cron)
    {
      name: 'Kilómetro del día',
      description: 'Corré o caminá al menos 1 km hoy.',
      type: 'DAILY_DISTANCE',
      targetValue: 1,
      rewardPts: 25,
      isActive: true,
      startDate: today,
      endDate: tomorrow,
    },
    {
      name: 'Sesión activa',
      description: 'Registrá al menos una actividad hoy.',
      type: 'DAILY_ACTIVITY',
      targetValue: 1,
      rewardPts: 20,
      isActive: true,
      startDate: today,
      endDate: tomorrow,
    },
    // Semanales (rotan los lunes vía cron)
    {
      name: 'Semana sólida',
      description: 'Acumulá 20 km esta semana.',
      type: 'WEEKLY_DISTANCE',
      targetValue: 20,
      rewardPts: 150,
      isActive: true,
      startDate: today,
      endDate: weekEnd,
    },
    {
      name: 'Tres días en la semana',
      description: 'Entrená al menos 3 días esta semana.',
      type: 'WEEKLY_ACTIVITY_COUNT',
      targetValue: 3,
      rewardPts: 120,
      isActive: true,
      startDate: today,
      endDate: weekEnd,
    },
    {
      name: 'Check-in en un local',
      description: 'Hacé check-in en un negocio adherido del Club esta semana.',
      type: 'WEEKLY_BUSINESS_CHECK_IN',
      targetValue: 1,
      rewardPts: 40,
      isActive: true,
      startDate: today,
      endDate: weekEnd,
    },
  ];
}

async function seedMissions(client = prisma) {
  console.log('Seeding Missions...');
  const missions = buildMissionPool();

  for (const m of missions) {
    const existing = await client.mission.findFirst({ where: { name: m.name } });
    if (!existing) {
      await client.mission.create({ data: m });
      console.log(`Created mission: ${m.name}`);
    } else {
      // Actualizar tipo/ventana sin borrar progreso histórico completado
      await client.mission.update({
        where: { id: existing.id },
        data: {
          description: m.description,
          type: m.type,
          targetValue: m.targetValue,
          rewardPts: m.rewardPts,
          isActive: m.isActive,
          startDate: m.startDate,
          endDate: m.endDate,
        },
      });
      console.log(`Updated mission: ${m.name}`);
    }
  }

  console.log('Missions seeding complete!');
}

async function main() {
  await seedMissions();
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = { seedMissions, buildMissionPool };
