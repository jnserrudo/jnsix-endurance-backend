const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Missions...');

  const missions = [
    {
      name: 'Primera Carrera',
      description: 'Completa tu primera actividad en JNSIX.',
      type: 'FIRST_ACTIVITY',
      targetValue: 1,
      rewardPts: 50,
      isActive: true,
      startDate: new Date(),
      endDate: new Date(new Date().setFullYear(new Date().getFullYear() + 10))
    },
    {
      name: 'Constancia Inicial',
      description: 'Alcanza una racha de 3 días consecutivos.',
      type: 'STREAK',
      targetValue: 3,
      rewardPts: 100,
      isActive: true,
      startDate: new Date(),
      endDate: new Date(new Date().setFullYear(new Date().getFullYear() + 10))
    },
    {
      name: 'Corredor Experto',
      description: 'Acumula 50 km de distancia total.',
      type: 'TOTAL_DISTANCE',
      targetValue: 50,
      rewardPts: 300,
      isActive: true,
      startDate: new Date(),
      endDate: new Date(new Date().setFullYear(new Date().getFullYear() + 10))
    }
  ];

  for (const m of missions) {
    const existing = await prisma.mission.findFirst({
      where: { name: m.name }
    });
    
    if (!existing) {
      await prisma.mission.create({ data: m });
      console.log(`Created mission: ${m.name}`);
    } else {
      console.log(`Mission ${m.name} already exists.`);
    }
  }

  console.log('Seeding complete!');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
