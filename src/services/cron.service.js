const cron = require('node-cron');
const prisma = require('../lib/prisma');
const { rotateFeaturedReward, expireRedemptions } = require('./marketplace.service');

const startCronJobs = () => {
  // Run every day at midnight (00:00)
  cron.schedule('0 0 * * *', async () => {
    console.log('Running daily cron jobs...');
    try {
      // 1. Expire Subscriptions
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

      // Demote users with expired subscriptions back to FREE
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

    } catch (error) {
      console.error('Error in daily cron jobs:', error);
    }
  });

  console.log('Cron jobs scheduled.');
};

module.exports = { startCronJobs };
