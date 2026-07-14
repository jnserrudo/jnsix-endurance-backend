const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Iniciando actualización de usernames...');
  
  const users = await prisma.user.findMany({
    where: {
      username: null
    }
  });

  if (users.length === 0) {
    console.log('✅ Todos los usuarios ya tienen username.');
    return;
  }

  let updatedCount = 0;

  for (const user of users) {
    if (user.email) {
      // Intentar usar lo que está antes del @
      let baseUsername = user.email.split('@')[0];
      let newUsername = baseUsername;
      
      // Asegurar que sea único (por si hay duplicados en el prefijo)
      let counter = 1;
      while (true) {
        const existing = await prisma.user.findUnique({ where: { username: newUsername } });
        if (!existing) {
          break;
        }
        newUsername = `${baseUsername}${counter}`;
        counter++;
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { username: newUsername }
      });
      console.log(`✅ Actualizado: ${user.email} -> username: ${newUsername}`);
      updatedCount++;
    }
  }

  console.log(`🎉 ¡Listo! Se actualizaron ${updatedCount} usuarios.`);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
