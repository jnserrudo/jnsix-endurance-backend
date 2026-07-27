const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { rotateFeaturedReward, expireRedemptions } = require('./marketplace.service');
const { rotateMissions } = require('./missionRotation.service');
const { sendWeeklyRecapNotifications } = require('./weeklyRecap.service');
const { sendStreakAtRiskNotifications } = require('./streakAtRisk.service');

const startCronJobs = () => {
  // Run every day at midnight (00:00)
  cron.schedule('0 0 * * *', async () => {
    console.log('Running daily cron jobs...');
    try {
      const now = new Date();
      const expiredSubscriptions = await prisma.subscription.updateMany({
        where: {
          isActive: true,
          status: 'ACTIVE',
          endDate: { lte: now }
        },
        data: {
          isActive: false,
          status: 'EXPIRED'
        }
      });
      console.log(`Expired ${expiredSubscriptions.count} subscriptions.`);

      const usersToDemote = await prisma.user.findMany({
        where: {
          subscriptionTier: { not: 'FREE' },
          subscriptions: {
            none: { isActive: true, status: 'ACTIVE' }
          }
        }
      });

      if (usersToDemote.length > 0) {
        await prisma.user.updateMany({
          where: { id: { in: usersToDemote.map(u => u.id) } },
          data: { subscriptionTier: 'FREE' }
        });
        console.log(`Demoted ${usersToDemote.length} users to FREE tier.`);
      }

      await expireRedemptions();
      await rotateFeaturedReward();
      await rotateMissions();

    } catch (error) {
      console.error('Error in daily cron jobs:', error);
    }
  });

  // Todos los días 18:00 — racha en riesgo
  cron.schedule('0 18 * * *', async () => {
    console.log('Running streak-at-risk notifications...');
    try {
      await sendStreakAtRiskNotifications();
    } catch (error) {
      console.error('Error in streak-at-risk job:', error);
    }
  });

  // Lunes 09:00 — digest semanal (km, racha, tip amigos) via SYSTEM notify/email
  cron.schedule('0 9 * * 1', async () => {
    console.log('Running weekly digest...');
    try {
      await sendWeeklyRecapNotifications();
    } catch (error) {
      console.error('Error in weekly digest job:', error);
    }
  });

  // Cada 30 min: cerrar lives zombie (>6h sin update)
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { cleanupStaleLiveRuns } = require('../controllers/liveRuns.controller');
      const n = await cleanupStaleLiveRuns();
      if (n > 0) console.log(`[LiveRun] Cleaned ${n} stale sessions`);
    } catch (error) {
      console.error('[LiveRun] stale cleanup error:', error.message);
    }
  });

  console.log('Cron jobs scheduled.');
};

module.exports = { startCronJobs };
