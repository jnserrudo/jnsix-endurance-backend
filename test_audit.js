const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const logs = await prisma.auditLog.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { user: true }
    });
    console.log('Success:', logs.length);
  } catch (err) {
    console.error('Error fetching audit logs:', err.message);
  }
}

main().finally(() => prisma.$disconnect());
