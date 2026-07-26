/**
 * Compatibilidad VPS / CLI. El código nuevo usa src/data/defaultBadges.js.
 * Si el servidor aún tiene un gamification.service viejo que pide
 * require('../../seed_badges'), este archivo evita el crash MODULE_NOT_FOUND.
 *
 * Uso CLI: node seed_badges.js
 */
const { PrismaClient } = require('@prisma/client');
const {
  seedBadges,
  ensureBadgesExist,
  DEFAULT_BADGES,
} = require('./src/data/defaultBadges');

const prisma = new PrismaClient();

async function main() {
  await seedBadges(prisma);
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

module.exports = { seedBadges, ensureBadgesExist, DEFAULT_BADGES };
