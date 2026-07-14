const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando carga masiva de datos de prueba...');

  const admin = await prisma.user.findUnique({ where: { email: 'admin@jnsix.com' } });
  const user = await prisma.user.findUnique({ where: { email: 'user@jnsix.com' } });

  if (!admin || !user) {
    console.error('❌ Faltan los usuarios base (admin@jnsix.com o user@jnsix.com)');
    process.exit(1);
  }

  // Limpiar datos previos de estos usuarios para evitar duplicados (excepto el usuario en sí)
  await prisma.activity.deleteMany({ where: { userId: { in: [user.id, admin.id] } } });
  await prisma.community.deleteMany({});
  await prisma.group.deleteMany({});
  await prisma.challenge.deleteMany({});
  await prisma.post.deleteMany({});

  // 1. Actividades para User
  console.log('🏃‍♂️ Creando actividades...');
  const activity1 = await prisma.activity.create({
    data: {
      userId: user.id,
      name: 'Fondo Domingo 20k',
      type: 'RUN', // ActivityType enum
      startDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // Hace 2 días
      distanceKm: 20.5,
      elevationM: 120,
      movingTime: 5400,
      averageHr: 155,
      maxHr: 172,
      calories: 1200,
      visibility: 'PUBLIC'
    }
  });

  const activity2 = await prisma.activity.create({
    data: {
      userId: user.id,
      name: 'Series en Pista 10x400',
      type: 'RUN',
      startDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      distanceKm: 8.0,
      elevationM: 10,
      movingTime: 2400,
      averageHr: 165,
      maxHr: 188,
      calories: 600,
      visibility: 'PUBLIC'
    }
  });

  const activity3 = await prisma.activity.create({
    data: {
      userId: admin.id,
      name: 'Salida Ciclismo Montaña',
      type: 'RIDE',
      startDate: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      distanceKm: 45.0,
      elevationM: 850,
      movingTime: 7200,
      averageHr: 145,
      maxHr: 180,
      calories: 1800,
      visibility: 'PUBLIC'
    }
  });

  // 2. Posts en el Feed
  console.log('📝 Creando posts y comentarios...');
  const post1 = await prisma.post.create({
    data: {
      userId: user.id,
      content: '¡Increíble fondo hoy! Preparando las piernas para la próxima maratón. 🏃‍♂️🔥',
      activityId: activity1.id,
    }
  });

  await prisma.comment.create({
    data: {
      postId: post1.id,
      userId: admin.id,
      content: '¡Qué buen ritmo llevaste! A seguir así 💪'
    }
  });

  const post2 = await prisma.post.create({
    data: {
      userId: admin.id,
      content: 'Probando la nueva bici en las subidas. ¡Un espectáculo!',
      activityId: activity3.id,
    }
  });

  // 3. Comunidades y Grupos
  console.log('👥 Creando comunidades y grupos...');
  const community = await prisma.community.create({
    data: {
      name: 'JNSIX Elite Runners',
      description: 'Comunidad oficial para corredores de élite y apasionados del asfalto.',
    }
  });

  await prisma.communityMember.createMany({
    data: [
      { communityId: community.id, userId: admin.id, role: 'ADMIN' },
      { communityId: community.id, userId: user.id, role: 'MEMBER' },
    ]
  });

  const group = await prisma.group.create({
    data: {
      name: 'Entrenamiento 21K Buenos Aires',
      description: 'Grupo focalizado en el objetivo del Medio Maratón de Buenos Aires.',
      ownerId: admin.id,
      visibility: 'PUBLIC',
    }
  });

  await prisma.groupMember.create({
    data: { groupId: group.id, userId: user.id, role: 'MEMBER' }
  });

  // 4. Retos (Challenges)
  console.log('🏆 Creando retos...');
  const challenge = await prisma.challenge.create({
    data: {
      name: 'Desafío 100K Mensuales',
      description: 'Logra correr 100 kilómetros en este mes. ¿Aceptas el reto?',
      type: 'COMMUNITY',
      metric: 'DISTANCE',
      targetValue: 100, // km
      startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1), // Principio de mes
      endDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0), // Fin de mes
      createdById: admin.id,
    }
  });

  await prisma.challengeParticipant.create({
    data: {
      challengeId: challenge.id,
      userId: user.id,
      currentProgress: 28.5,
    }
  });





  console.log('✅ ¡Carga masiva completada con éxito!');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
