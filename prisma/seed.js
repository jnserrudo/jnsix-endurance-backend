const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seeder...');

  const passwordHash = await bcrypt.hash('password123', 10);

  // Crear usuario Admin
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@jnsix.com' },
    update: {},
    create: {
      email: 'admin@jnsix.com',
      password: passwordHash,
      role: 'ADMIN',
      subscriptionTier: 'ELITE',
      emailVerified: true
    },
  });

  console.log(`✅ Admin creado: ${adminUser.email} / password123`);

  // Crear usuario normal (Pruebas)
  const normalUser = await prisma.user.upsert({
    where: { email: 'user@jnsix.com' },
    update: {},
    create: {
      email: 'user@jnsix.com',
      password: passwordHash,
      role: 'ATHLETE',
      subscriptionTier: 'FREE',
      emailVerified: true
    },
  });

  console.log(`✅ Usuario normal creado: ${normalUser.email} / password123`);
  
  console.log('🌱 Seeding finalizado con éxito.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
