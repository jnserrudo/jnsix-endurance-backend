const prisma = require('../lib/prisma');
const scoringService = require('./scoring.service');
const { generateUniqueCode } = require('./redemption-code.service');
const { notify } = require('./notifications.service');
const scoringConfig = require('./scoringConfig.service');

/**
 * Descuentos al canjear (racha y proximidad a competencia). Los valores se
 * configuran desde el admin; acá solo se leen.
 */
const loadRewardRules = async () => {
  const values = await scoringConfig.getValues();
  return {
    streakThreshold: values['reward.streak_bonus_threshold'] ?? 0,
    streakPct: values['reward.streak_bonus_pct'] ?? 0,
    competitionProximityDays: values['reward.competition_proximity_days'] ?? 0,
    competitionProgressPct: values['reward.competition_progress_pct'] ?? 0,
    competitionBonusPct: values['reward.competition_bonus_pct'] ?? 0,
  };
};

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
 * Bonus J3: competencia con targetDate dentro de la ventana configurada y
 * progreso del plan por encima del mínimo, o competencia recién completada.
 */
const getCompetitionProximityBonus = async (tx, userId, preloadedRules) => {
  const rules = preloadedRules || (await loadRewardRules());
  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + rules.competitionProximityDays);
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - rules.competitionProximityDays);

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
      target > now && percent > rules.competitionProgressPct;

    if (nearRaceWithProgress || competitionCompleted) {
      return {
        applied: true,
        pct: rules.competitionBonusPct,
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
  // Fuera de la transacción: leer configuración no debería mantener la tx abierta.
  const rules = await loadRewardRules();

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
    if (currentStreak >= rules.streakThreshold && effectiveCost > 0) {
      effectiveCost = Math.max(0, Math.round(effectiveCost * (1 - rules.streakPct / 100)));
      streakBonusApplied = true;
    }

    const competitionBonus = await getCompetitionProximityBonus(tx, userId, rules);
    let competitionBonusApplied = false;
    if (competitionBonus.applied && effectiveCost > 0) {
      effectiveCost = Math.max(
        0,
        Math.round(effectiveCost * (1 - rules.competitionBonusPct / 100))
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
          redemptionId: redemption.id,
          source: 'REDEMPTION'
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
      streakBonusPct: streakBonusApplied ? rules.streakPct : 0,
      competitionBonusApplied,
      competitionBonusPct: competitionBonusApplied ? rules.competitionBonusPct : 0,
      competitionBonus,
    };
  });

  const scoreResult = await scoringService.recalculateUserScore(userId);

  const costLabel =
    result.effectiveCost === 0 ? 'gratis' : `${result.effectiveCost} pts`;
  let body = `Canjeaste "${result.reward.title}" (${costLabel}). Mostrá el código en el local.`;
  if (result.streakBonusApplied) {
    body += ` Bonus racha ×${result.currentStreak}: -${result.streakBonusPct}%.`;
  }
  if (result.competitionBonusApplied) {
    body += ` Bonus competencia: -${result.competitionBonusPct}%.`;
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
          pct: result.competitionBonusPct,
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

/**
 * Preview de costo con descuentos de featured + racha + competencia (sin canjear).
 */
const previewUserPricing = async (userId, reward) => {
  const rules = await loadRewardRules();
  const baseCost = Math.max(0, Number(reward.pointsCost) || 0);
  const featuredCost = getEffectivePointsCost(reward);
  const featuredDiscountPct =
    baseCost > 0 && featuredCost < baseCost
      ? Math.round((1 - featuredCost / baseCost) * 100)
      : 0;

  let effectiveCost = featuredCost;
  let streakBonusApplied = false;
  let currentStreak = 0;
  let competitionBonusApplied = false;
  let competitionBonus = null;

  if (userId) {
    const streak = await prisma.streak.findUnique({ where: { userId } });
    currentStreak = streak?.currentStreak || 0;
    if (currentStreak >= rules.streakThreshold && effectiveCost > 0) {
      effectiveCost = Math.max(0, Math.round(effectiveCost * (1 - rules.streakPct / 100)));
      streakBonusApplied = true;
    }
    competitionBonus = await getCompetitionProximityBonus(prisma, userId, rules);
    if (competitionBonus.applied && effectiveCost > 0) {
      effectiveCost = Math.max(
        0,
        Math.round(effectiveCost * (1 - rules.competitionBonusPct / 100))
      );
      competitionBonusApplied = true;
    }
  }

  return {
    baseCost,
    featuredCost,
    featuredDiscountPct,
    effectiveCost,
    streakBonusApplied,
    streakBonusPct: streakBonusApplied ? rules.streakPct : 0,
    currentStreak,
    competitionBonusApplied,
    competitionBonusPct: competitionBonusApplied ? rules.competitionBonusPct : 0,
    competitionBonus: competitionBonusApplied
      ? {
          pct: rules.competitionBonusPct,
          reason: competitionBonus.reason,
          competitionName: competitionBonus.competitionName,
          trainingProgressPct: competitionBonus.trainingProgressPct,
        }
      : null,
  };
};

module.exports = {
  getEffectivePointsCost,
  isRewardAvailable,
  redeemReward,
  getCompetitionProximityBonus,
  previewUserPricing,
  loadRewardRules,
};
