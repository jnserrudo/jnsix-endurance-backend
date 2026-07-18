const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.user.updateMany({
    where: { email: { not: 'jnserrudo@gmail.com' } },
    data: { role: 'ATHLETE' }
  });
  console.log('Fixed users roles');
}

main().catch(console.error).finally(() => prisma.$disconnect());
