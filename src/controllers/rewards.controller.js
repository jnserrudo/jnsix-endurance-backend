const prisma = require('../lib/prisma');
const rewardsService = require('../services/rewards.service');
const scoringService = require('../services/scoring.service');

const listRewards = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const skip = (page - 1) * limit;
    const businessId = req.query.businessId;
    const sort = req.query.sort || 'newest';
    const now = new Date();

    const where = {
      status: 'ACTIVE',
      business: { status: 'APPROVED', isActive: true },
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      ...(businessId ? { businessId } : {})
    };

    const orderBy = sort === 'points_asc'
      ? { pointsCost: 'asc' }
      : { createdAt: 'desc' };

    const [rewards, total] = await Promise.all([
      prisma.reward.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          business: { select: { id: true, name: true, logoUrl: true, city: true } }
        }
      }),
      prisma.reward.count({ where })
    ]);

    const enriched = rewards.map((r) => ({
      ...r,
      effectiveCost: rewardsService.getEffectivePointsCost(r)
    }));

    res.json({ rewards: enriched, total, page, limit });
  } catch (error) {
    console.error('[ERROR] listRewards:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const getFeaturedReward = async (req, res) => {
  try {
    const now = new Date();
    const reward = await prisma.reward.findFirst({
      where: {
        isFeatured: true,
        featuredUntil: { gt: now },
        status: 'ACTIVE',
        business: { status: 'APPROVED', isActive: true }
      },
      include: {
        business: { select: { id: true, name: true, logoUrl: true } }
      },
      orderBy: { featuredUntil: 'asc' }
    });

    if (!reward) return res.json({ reward: null });
    res.json({
      reward: {
        ...reward,
        effectiveCost: rewardsService.getEffectivePointsCost(reward)
      }
    });
  } catch (error) {
    console.error('[ERROR] getFeaturedReward:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const getRewardById = async (req, res) => {
  try {
    const reward = await prisma.reward.findUnique({
      where: { id: req.params.id },
      include: { business: true }
    });

    if (!reward) return res.status(404).json({ error: 'Premio no encontrado' });

    const isOwner = req.user?.role === 'BUSINESS'
      && (await prisma.business.findUnique({ where: { userId: req.user.id } }))?.id === reward.businessId;

    const isPublic = rewardsService.isRewardAvailable(reward, reward.business);

    if (!isPublic && !isOwner) {
      return res.status(404).json({ error: 'Premio no encontrado' });
    }

    const effectiveCost = rewardsService.getEffectivePointsCost(reward);
    let userContext = null;

    // Cualquier usuario autenticado que no sea BUSINESS (atleta o admin en smoke test)
    if (req.user && req.user.role !== 'BUSINESS') {
      const userScore = await prisma.userScore.findUnique({
        where: { userId: req.user.id },
        include: { currentRank: true }
      });
      const totalPoints = userScore?.totalPoints || 0;
      const meetsRank = !reward.minRankOrder || (userScore?.currentRank?.order || 0) >= reward.minRankOrder;
      const inWishlist = await prisma.rewardWishlist.findUnique({
        where: { userId_rewardId: { userId: req.user.id, rewardId: reward.id } }
      });

      const canRoleRedeem = req.user.role === 'ATHLETE' || req.user.role === 'ADMIN';

      userContext = {
        userPoints: totalPoints,
        pointsNeeded: Math.max(0, effectiveCost - totalPoints),
        canRedeem: canRoleRedeem && totalPoints >= effectiveCost && meetsRank && isPublic,
        meetsRankRequirement: meetsRank,
        requiredRankOrder: reward.minRankOrder,
        inWishlist: !!inWishlist
      };
    }

    res.json({ ...reward, effectiveCost, userContext });
  } catch (error) {
    console.error('[ERROR] getRewardById:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const redeemReward = async (req, res) => {
  try {
    if (req.user.role !== 'ATHLETE' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo atletas pueden canjear premios' });
    }

    const result = await rewardsService.redeemReward(req.user.id, req.params.id);
    res.status(201).json(result);
  } catch (error) {
    if (error.code === 'NOT_FOUND') {
      return res.status(404).json({ error: error.message, code: error.code });
    }
    if (error.code === 'INSUFFICIENT_POINTS') {
      return res.status(400).json({ error: error.message, code: error.code, ...error.details });
    }
    if (error.code === 'STOCK_EXHAUSTED') {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    if (error.code === 'RANK_REQUIRED') {
      return res.status(403).json({ error: error.message, code: error.code, ...error.details });
    }
    if (error.code === 'REWARD_UNAVAILABLE' || error.code === 'MAX_PER_USER') {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    console.error('[ERROR] redeemReward:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const toggleWishlist = async (req, res) => {
  try {
    if (req.user.role !== 'ATHLETE' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo atletas pueden usar la wishlist' });
    }

    const reward = await prisma.reward.findUnique({ where: { id: req.params.id } });
    if (!reward) return res.status(404).json({ error: 'Premio no encontrado' });

    const existing = await prisma.rewardWishlist.findUnique({
      where: { userId_rewardId: { userId: req.user.id, rewardId: reward.id } }
    });

    if (existing) {
      await prisma.rewardWishlist.delete({
        where: { userId_rewardId: { userId: req.user.id, rewardId: reward.id } }
      });
      return res.json({ inWishlist: false });
    }

    await prisma.rewardWishlist.create({
      data: { userId: req.user.id, rewardId: reward.id }
    });

    res.json({ inWishlist: true });
  } catch (error) {
    console.error('[ERROR] toggleWishlist:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const getMyWishlist = async (req, res) => {
  try {
    const items = await prisma.rewardWishlist.findMany({
      where: { userId: req.user.id },
      include: {
        reward: {
          include: { business: { select: { id: true, name: true, logoUrl: true } } }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const userScore = await prisma.userScore.findUnique({
      where: { userId: req.user.id },
      include: { currentRank: true }
    });
    const totalPoints = userScore?.totalPoints || 0;
    const rankOrder = userScore?.currentRank?.order || 0;

    res.json({
      items: items.map((i) => {
        const effectiveCost = rewardsService.getEffectivePointsCost(i.reward);
        const meetsRank = !i.reward.minRankOrder || rankOrder >= i.reward.minRankOrder;
        return {
          ...i,
          reward: {
            ...i.reward,
            effectiveCost,
            pointsNeeded: Math.max(0, effectiveCost - totalPoints),
            canRedeem: totalPoints >= effectiveCost && meetsRank,
            meetsRankRequirement: meetsRank
          }
        };
      })
    });
  } catch (error) {
    console.error('[ERROR] getMyWishlist:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = {
  listRewards,
  getFeaturedReward,
  getRewardById,
  redeemReward,
  toggleWishlist,
  getMyWishlist
};
