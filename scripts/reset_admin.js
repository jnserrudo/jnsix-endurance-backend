const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

async function main() {
  const email = 'admin@jnsix.com';
  const hashedPassword = await bcrypt.hash('Password123!', 10);
  
  await prisma.user.update({
    where: { email },
    data: { password: hashedPassword }
  });
  
  console.log(`✅ Contraseña restablecida para ${email}`);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
