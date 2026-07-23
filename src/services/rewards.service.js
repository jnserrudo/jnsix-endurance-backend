const prisma = require('../lib/prisma');
const scoringService = require('./scoring.service');
const { generateUniqueCode } = require('./redemption-code.service');
const { notify } = require('./notifications.service');

const getEffectivePointsCost = (reward) => {
  const now = new Date();
  if (reward.isFeatured && reward.featuredUntil && reward.featuredUntil > now && reward.featuredDiscountPct) {
    return Math.max(1, Math.round(reward.pointsCost * (1 - reward.featuredDiscountPct / 100)));
  }
  return reward.pointsCost;
};

const isRewardAvailable = (reward, business) => {
  const now = new Date();
  if (business.status !== 'APPROVED' || !business.isActive) return false;
  if (reward.status !== 'ACTIVE') return false;
  if (reward.startsAt && reward.startsAt > now) return false;
  if (reward.expiresAt && reward.expiresAt <= now) return false;
  if (reward.stockRemaining != null && reward.stockRemaining <= 0) return false;
  return true;
};

const redeemReward = async (userId, rewardId) => {
  const result = await prisma.$transaction(async (tx) => {
    const reward = await tx.reward.findUnique({
      where: { id: rewardId },
      include: { business: true }
    });

    if (!reward) {
      const err = new Error('Reward not found');
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (!isRewardAvailable(reward, reward.business)) {
      const err = new Error('Reward is not available');
      err.code = 'REWARD_UNAVAILABLE';
      throw err;
    }

    const effectiveCost = getEffectivePointsCost(reward);

    if (reward.maxPerUser) {
      const userRedemptions = await tx.redemption.count({
        where: { userId, rewardId, status: { not: 'CANCELLED' } }
      });
      if (userRedemptions >= reward.maxPerUser) {
        const err = new Error('Maximum redemptions reached for this reward');
        err.code = 'MAX_PER_USER';
        throw err;
      }
    }

    const userScore = await tx.userScore.findUnique({ where: { userId } });
    const totalPoints = userScore?.totalPoints || 0;
    if (totalPoints < effectiveCost) {
      const err = new Error('Insufficient points');
      err.code = 'INSUFFICIENT_POINTS';
      err.details = { pointsNeeded: effectiveCost - totalPoints, effectiveCost };
      throw err;
    }

    if (reward.minRankOrder != null) {
      const rank = userScore?.currentRankId
        ? await tx.rank.findUnique({ where: { id: userScore.currentRankId } })
        : null;
      if (!rank || rank.order < reward.minRankOrder) {
        const requiredRank = await tx.rank.findFirst({ where: { order: reward.minRankOrder } });
        const err = new Error('Rank requirement not met');
        err.code = 'RANK_REQUIRED';
        err.details = { requiredRankName: requiredRank?.name || null };
        throw err;
      }
    }

    if (reward.stockRemaining != null) {
      const updated = await tx.reward.updateMany({
        where: { id: rewardId, stockRemaining: { gt: 0 } },
        data: { stockRemaining: { decrement: 1 } }
      });
      if (updated.count === 0) {
        const err = new Error('Out of stock');
        err.code = 'STOCK_EXHAUSTED';
        throw err;
      }
    }

    const code = await generateUniqueCode(tx);
    const expiresAt = reward.expiresAt || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    const redemption = await tx.redemption.create({
      data: {
        userId,
        rewardId: reward.id,
        businessId: reward.businessId,
        code,
        pointsSpent: effectiveCost,
        expiresAt,
        status: 'ACTIVE'
      },
      include: {
        reward: { include: { business: { select: { id: true, name: true, logoUrl: true } } } }
      }
    });

    await tx.scoreEvent.create({
      data: {
        userId,
        points: -effectiveCost,
        reason: `Reward redemption: ${reward.title}`,
        redemptionId: redemption.id
      }
    });

    return { redemption, effectiveCost, reward };
  });

  const scoreResult = await scoringService.recalculateUserScore(userId);

  if (scoreResult.rankChanged && scoreResult.rankDirection === 'DOWN') {
    const { notify } = require('./notifications.service');
    await notify(userId, 'RANK_CHANGED', {
      title: 'Canje exitoso',
      body: `Canjeaste un premio. Tu rank ahora es ${scoreResult.rank?.name || 'actualizado'}.`,
      payload: { type: 'RANK_CHANGED' }
    }).catch(console.error);
  }

  await notify(userId, 'REWARD_REDEEMED', {
    title: '¡Cupón canjeado!',
    body: `Canjeaste "${result.reward.title}" por ${result.effectiveCost} pts`,
    payload: { type: 'REWARD_REDEEMED', redemptionId: result.redemption.id }
  }).catch(console.error);

  return {
    redemption: result.redemption,
    pointsSpent: result.effectiveCost,
    newTotalPoints: scoreResult.userScore.totalPoints,
    rankChanged: scoreResult.rankChanged,
    rank: scoreResult.rank
  };
};

module.exports = {
  getEffectivePointsCost,
  isRewardAvailable,
  redeemReward
};
