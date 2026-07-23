const prisma = require('../lib/prisma');
const { notify } = require('./notifications.service');

const rotateFeaturedReward = async () => {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  await prisma.reward.updateMany({
    where: { isFeatured: true },
    data: { isFeatured: false, featuredUntil: null }
  });

  const candidates = await prisma.reward.findMany({
    where: {
      status: 'ACTIVE',
      business: { status: 'APPROVED', isActive: true },
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }]
    },
    orderBy: { createdAt: 'desc' },
    take: 20
  });

  if (candidates.length === 0) return;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];

  await prisma.reward.update({
    where: { id: pick.id },
    data: {
      isFeatured: true,
      featuredUntil: tomorrow,
      featuredDiscountPct: pick.featuredDiscountPct ?? 10
    }
  });

  console.log(`[Marketplace] Featured reward: ${pick.title} until ${tomorrow.toISOString()}`);
};

const expireRedemptions = async () => {
  const now = new Date();
  const result = await prisma.redemption.updateMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { lte: now }
    },
    data: { status: 'EXPIRED' }
  });
  if (result.count > 0) {
    console.log(`[Marketplace] Expired ${result.count} redemptions`);
  }
};

const notifyWishlistEligible = async (userId, totalPoints) => {
  const wishlist = await prisma.rewardWishlist.findMany({
    where: { userId },
    include: {
      reward: {
        include: { business: { select: { status: true, isActive: true } } }
      }
    }
  });

  for (const item of wishlist) {
    const r = item.reward;
    if (r.status !== 'ACTIVE' || r.business.status !== 'APPROVED') continue;

    let cost = r.pointsCost;
    if (r.isFeatured && r.featuredUntil && r.featuredUntil > new Date() && r.featuredDiscountPct) {
      cost = Math.max(1, Math.round(r.pointsCost * (1 - r.featuredDiscountPct / 100)));
    }

    if (totalPoints >= cost) {
      const recent = await prisma.notification.findFirst({
        where: {
          userId,
          type: 'REWARD_AVAILABLE',
          body: { contains: r.title },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }
      });
      if (!recent) {
        await notify(userId, 'REWARD_AVAILABLE', {
          title: '¡Podés canjear un premio!',
          body: `Ya tenés puntos para "${r.title}"`,
          payload: { type: 'REWARD_AVAILABLE', rewardId: r.id }
        }).catch(console.error);
      }
    }
  }
};

module.exports = {
  rotateFeaturedReward,
  expireRedemptions,
  notifyWishlistEligible
};
