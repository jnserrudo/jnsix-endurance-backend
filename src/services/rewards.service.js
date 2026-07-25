const prisma = require('../lib/prisma');
const scoringService = require('./scoring.service');
const { generateUniqueCode } = require('./redemption-code.service');
const { notify } = require('./notifications.service');

/** Descuento extra por racha (streak >= 3): 10% sobre el costo efectivo. */
const STREAK_BONUS_THRESHOLD = 3;
const STREAK_BONUS_PCT = 10;

/** Descuento extra por proximidad a competencia (J3): 5%. */
const COMPETITION_PROXIMITY_DAYS = 14;
const COMPETITION_PROGRESS_PCT = 80;
const COMPETITION_BONUS_PCT = 5;

const getEffectivePointsCost = (reward) => {
  const base = Math.max(0, Number(reward.pointsCost) || 0);
  const now = new Date();
  if (
    base > 0 &&
    reward.isFeatured &&
    reward.featuredUntil &&
    reward.featuredUntil > now &&
    reward.featuredDiscountPct
  ) {
    return Math.max(0, Math.round(base * (1 - reward.featuredDiscountPct / 100)));
  }
  return base;
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

/**
 * Bonus J3: competencia con targetDate en los próximos 14 días y trainingProgress >80%,
 * O competencia recién completada (targetDate en los últimos 14 días).
 */
const getCompetitionProximityBonus = async (tx, userId) => {
  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + COMPETITION_PROXIMITY_DAYS);
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - COMPETITION_PROXIMITY_DAYS);

  const goals = await tx.competitionGoal.findMany({
    where: {
      userId,
      targetDate: { gte: windowStart, lte: windowEnd },
    },
    include: {
      simulations: { select: { id: true }, take: 1 },
      userPlans: {
        where: { isActive: true },
        take: 1,
        include: {
          plan: {
            select: { sessions: { select: { status: true } } },
          },
        },
      },
    },
  });

  for (const goal of goals) {
    const target = new Date(goal.targetDate);
    const sessions = goal.userPlans[0]?.plan?.sessions || [];
    const doneSessions = sessions.filter((s) => s.status === 'DONE').length;
    const totalSessions = sessions.length;
    const percent = totalSessions ? Math.round((doneSessions / totalSessions) * 100) : 0;

    const competitionCompleted =
      target <= now || (goal.simulations?.length || 0) > 0;

    const nearRaceWithProgress =
      target > now && percent > COMPETITION_PROGRESS_PCT;

    if (nearRaceWithProgress || competitionCompleted) {
      return {
        applied: true,
        pct: COMPETITION_BONUS_PCT,
        reason: competitionCompleted
          ? 'competition_completed'
          : 'competition_proximity_progress',
        competitionGoalId: goal.id,
        competitionName: goal.name,
        trainingProgressPct: percent,
        targetDate: goal.targetDate,
      };
    }
  }

  return { applied: false, pct: 0 };
};

const redeemReward = async (userId, rewardId) => {
  const result = await prisma.$transaction(async (tx) => {
    const reward = await tx.reward.findUnique({
      where: { id: rewardId },
      include: { business: true }
    });

    if (!reward) {
      const err = new Error('Premio no encontrado');
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (!isRewardAvailable(reward, reward.business)) {
      const err = new Error('Este premio no está disponible');
      err.code = 'REWARD_UNAVAILABLE';
      throw err;
    }

    let effectiveCost = getEffectivePointsCost(reward);
    const baseEffectiveCost = effectiveCost;

    const streak = await tx.streak.findUnique({ where: { userId } });
    const currentStreak = streak?.currentStreak || 0;
    let streakBonusApplied = false;
    if (currentStreak >= STREAK_BONUS_THRESHOLD && effectiveCost > 0) {
      effectiveCost = Math.max(0, Math.round(effectiveCost * (1 - STREAK_BONUS_PCT / 100)));
      streakBonusApplied = true;
    }

    const competitionBonus = await getCompetitionProximityBonus(tx, userId);
    let competitionBonusApplied = false;
    if (competitionBonus.applied && effectiveCost > 0) {
      effectiveCost = Math.max(
        0,
        Math.round(effectiveCost * (1 - COMPETITION_BONUS_PCT / 100))
      );
      competitionBonusApplied = true;
    }

    if (reward.maxPerUser) {
      const userRedemptions = await tx.redemption.count({
        where: { userId, rewardId, status: { not: 'CANCELLED' } }
      });
      if (userRedemptions >= reward.maxPerUser) {
        const err = new Error('Ya alcanzaste el máximo de canjes para este premio');
        err.code = 'MAX_PER_USER';
        throw err;
      }
    }

    const userScore = await tx.userScore.findUnique({ where: { userId } });
    const totalPoints = userScore?.totalPoints || 0;
    if (totalPoints < effectiveCost) {
      const err = new Error(
        `Te faltan ${effectiveCost - totalPoints} pts para canjear este premio`
      );
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
        const err = new Error(
          requiredRank?.name
            ? `Necesitás el rank ${requiredRank.name} o superior`
            : 'No cumplís el rank requerido para este premio'
        );
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
        const err = new Error('Sin stock disponible');
        err.code = 'STOCK_EXHAUSTED';
        throw err;
      }
    }

    const code = await generateUniqueCode(tx);
    const expiresAt = reward.expiresAt || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    const reasonParts = [];
    if (streakBonusApplied) reasonParts.push('bonus racha');
    if (competitionBonusApplied) reasonParts.push('bonus competencia');
    const reasonSuffix = reasonParts.length ? ` (${reasonParts.join(', ')})` : '';

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

    if (effectiveCost > 0) {
      await tx.scoreEvent.create({
        data: {
          userId,
          points: -effectiveCost,
          reason: `Canje de premio${reasonSuffix}: ${reward.title}`,
          redemptionId: redemption.id
        }
      });
    }

    return {
      redemption,
      effectiveCost,
      baseEffectiveCost,
      reward,
      streakBonusApplied,
      currentStreak,
      streakBonusPct: streakBonusApplied ? STREAK_BONUS_PCT : 0,
      competitionBonusApplied,
      competitionBonusPct: competitionBonusApplied ? COMPETITION_BONUS_PCT : 0,
      competitionBonus,
    };
  });

  const scoreResult = await scoringService.recalculateUserScore(userId);

  const costLabel =
    result.effectiveCost === 0 ? 'gratis' : `${result.effectiveCost} pts`;
  let body = `Canjeaste "${result.reward.title}" (${costLabel}). Mostrá el código en el local.`;
  if (result.streakBonusApplied) {
    body += ` Bonus racha ×${result.currentStreak}: -${STREAK_BONUS_PCT}%.`;
  }
  if (result.competitionBonusApplied) {
    body += ` Bonus competencia: -${COMPETITION_BONUS_PCT}%.`;
  }
  if (scoreResult.rankChanged && scoreResult.rank?.name) {
    body += ` Tu rank ahora es ${scoreResult.rank.name}.`;
  }

  await notify(userId, 'REWARD_REDEEMED', {
    title: '¡Cupón canjeado!',
    body,
    payload: {
      type: 'REWARD_REDEEMED',
      redemptionId: result.redemption.id,
      rankChanged: !!scoreResult.rankChanged,
      streakBonusApplied: result.streakBonusApplied,
      competitionBonusApplied: result.competitionBonusApplied,
    },
    dedupeKey: `redeem:${result.redemption.id}`
  }).catch(console.error);

  return {
    redemption: result.redemption,
    pointsSpent: result.effectiveCost,
    baseEffectiveCost: result.baseEffectiveCost,
    /** true si se aplicó descuento por racha >= 3 */
    streakBonusApplied: result.streakBonusApplied,
    streakBonusPct: result.streakBonusPct,
    currentStreak: result.currentStreak,
    /**
     * Bonus J3: +5% dto si hay competitionGoal con targetDate ≤14 días y
     * trainingProgress >80%, o competencia completada (fecha pasada / simulación).
     */
    competitionBonusApplied: result.competitionBonusApplied,
    competitionBonusPct: result.competitionBonusPct,
    competitionBonus: result.competitionBonusApplied
      ? {
          pct: COMPETITION_BONUS_PCT,
          reason: result.competitionBonus.reason,
          competitionGoalId: result.competitionBonus.competitionGoalId,
          competitionName: result.competitionBonus.competitionName,
          trainingProgressPct: result.competitionBonus.trainingProgressPct,
        }
      : null,
    newTotalPoints: scoreResult.userScore.totalPoints,
    rankChanged: scoreResult.rankChanged,
    rank: scoreResult.rank
  };
};

module.exports = {
  getEffectivePointsCost,
  isRewardAvailable,
  redeemReward,
  getCompetitionProximityBonus,
  STREAK_BONUS_THRESHOLD,
  STREAK_BONUS_PCT,
  COMPETITION_PROXIMITY_DAYS,
  COMPETITION_PROGRESS_PCT,
  COMPETITION_BONUS_PCT,
};
