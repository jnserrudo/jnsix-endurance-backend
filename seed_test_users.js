const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

async function createTestUsers() {
  try {
    const passwordHash = await bcrypt.hash('password123', 10);

    // 1. Admin User
    let admin = await prisma.user.findUnique({ where: { email: 'admin@test.com' } });
    if (!admin) {
      admin = await prisma.user.create({
        data: {
          email: 'admin@test.com',
          password: passwordHash
        }
      });
      console.log('Created Admin User:', admin.email);
    } else {
      console.log('Admin User exists:', admin.email);
    }

    // 2. Regular PRO User
    let proUser = await prisma.user.findUnique({ where: { email: 'pro@test.com' } });
    if (!proUser) {
      proUser = await prisma.user.create({
        data: {
          email: 'pro@test.com',
          password: passwordHash
        }
      });
      console.log('Created PRO User:', proUser.email);
    } else {
      console.log('PRO User exists:', proUser.email);
    }

    // 3. Regular FREE User
    let freeUser = await prisma.user.findUnique({ where: { email: 'free@test.com' } });
    if (!freeUser) {
      freeUser = await prisma.user.create({
        data: {
          email: 'free@test.com',
          password: passwordHash
        }
      });
      console.log('Created FREE User:', freeUser.email);
    } else {
      console.log('FREE User exists:', freeUser.email);
    }

    console.log('Test users are ready with password: password123');

  } catch (error) {
    console.error('Error creating test users:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createTestUsers();
