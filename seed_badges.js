/**
 * CLI local one-shot (gitignored). Reexporta el catálogo de src/.
 * Uso: node seed_badges.js
 */
const { PrismaClient } = require('@prisma/client');
const { seedBadges, ensureBadgesExist, DEFAULT_BADGES } = require('./src/data/defaultBadges');

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
