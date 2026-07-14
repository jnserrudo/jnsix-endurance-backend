const bcrypt = require('bcrypt');
const prisma = require('./src/lib/prisma');

(async () => {
  try {
    const hash = await bcrypt.hash('password123', 10);
    const u = await prisma.user.update({
      where: { email: 'admin@jnsix.com' },
      data: { password: hash }
    });
    console.log('Admin password reset:', u.email);

    const u2 = await prisma.user.update({
      where: { email: 'user@jnsix.com' },
      data: { password: hash }
    });
    console.log('User password reset:', u2.email);
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
})();
