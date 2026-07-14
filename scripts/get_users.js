const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: {
      email: true,
      username: true,
      role: true
    }
  });
  
  console.log("=== USUARIOS EN BASE DE DATOS ===");
  users.forEach(u => {
    console.log(`Email: ${u.email} | Usuario: ${u.username || '(no definido)'} | Rol: ${u.role}`);
  });
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
