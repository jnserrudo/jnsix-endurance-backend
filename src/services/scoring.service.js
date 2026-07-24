const prisma = require('../lib/prisma');
const { notify } = require('./notifications.service');
const { notifyWishlistEligible } = require('./marketplace.service');

const TYPE_MULTIPLIERS = {
  RUN: 1,
  TRAIL_RUN: 1.3,
  RIDE: 0.8,
  VIRTUAL_RUN: 0.9,
  VIRTUAL_RIDE: 0.7,
  SWIM: 1.5,
  HIKE: 1.1,
  WALK: 0.6,
  OTHER: 0.5
};

const STREAK_BONUSES = {
  7: 50,
  30: 200
};

const deriveEventMeta = (event) => {
  if (event.redemptionId) return { type: 'SPENT', source: 'REDEMPTION' };
  if (event.activityId) return { type: 'EARNED', source: 'ACTIVITY' };
  if (event.workoutId) return { type: 'EARNED', source: 'WORKOUT' };
  if (event.achievementId) return { type: 'EARNED', source: 'ACHIEVEMENT' };
  if (event.missionId) return { type: 'EARNED', source: 'MISSION' };
  if (event.points < 0) return { type: 'SPENT', source: 'OTHER' };
  if (event.reason?.toLowerCase().includes('streak')) return { type: 'EARNED', source: 'STREAK' };
  return { type: event.points >= 0 ? 'EARNED' : 'SPENT', source: 'OTHER' };
};

const calculateActivityPoints = (activity) => {
  const distanceKm = Number(activity.distanceKm) || 0;
  const elevationM = Number(activity.elevationM) || 0;
  const movingTime = Number(activity.movingTime) || 0;
  const distancePoints = distanceKm * 10;
  const elevationPoints = elevationM * 0.5;
  const timePoints = (movingTime / 3600) * 20;
  const multiplier = TYPE_MULTIPLIERS[activity.type] || TYPE_MULTIPLIERS.OTHER;
  const total = (distancePoints + elevationPoints + timePoints) * multiplier;
  if (!Number.isFinite(total)) return 0;
  // Mínimo 1 pt si hay actividad con distancia o tiempo medible
  const rounded = Math.round(total);
  if (rounded <= 0 && (distanceKm > 0.05 || movingTime >= 60)) return 1;
  return Math.max(0, rounded);
};

const recalculateUserScore = async (userId) => {
  const aggregate = await prisma.scoreEvent.aggregate({
    where: { userId },
    _sum: { points: true }
  });

  const totalPoints = aggregate._sum.points || 0;

  const previousScore = await prisma.userScore.findUnique({
    where: { userId },
    include: { currentRank: true }
  });

  const rank = await prisma.rank.findFirst({
    where: {
      isActive: true,
      deletedAt: null,
      minPoints: { lte: totalPoints },
      OR: [{ maxPoints: null }, { maxPoints: { gte: totalPoints } }]
    },
    orderBy: { order: 'desc' }
  });

  const userScore = await prisma.userScore.upsert({
    where: { userId },
    update: {
      totalPoints,
      currentRankId: rank?.id || null
    },
    create: {
      userId,
      totalPoints,
      currentRankId: rank?.id || null
    },
    include: { currentRank: true }
  });

  const rankChanged = previousScore?.currentRankId !== userScore.currentRankId;
  const rankDirection = rankChanged
    ? (rank?.order || 0) > (previousScore?.currentRank?.order || 0) ? 'UP' : 'DOWN'
    : null;

  return { userScore, rank, rankChanged, rankDirection, previousRank: previousScore?.currentRank || null };
};

const awardPoints = async (userId, { points, reason, activityId, missionId, achievementId, workoutId, redemptionId }) => {
  if (!points || points === 0) return { points: 0, scoreResult: await recalculateUserScore(userId) };

  const event = await prisma.scoreEvent.create({
    data: {
      userId,
      points,
      reason,
      activityId: activityId || null,
      missionId: missionId || null,
      achievementId: achievementId || null,
      workoutId: workoutId || null,
      redemptionId: redemptionId || null
    }
  });

  const scoreResult = await recalculateUserScore(userId);

  if (points > 0) {
    await notify(userId, 'POINTS_EARNED', {
      title: `+${points} pts`,
      body: reason,
      payload: { type: 'POINTS_EARNED', points, reason },
      dedupeKey: activityId
        ? `pts:activity:${activityId}`
        : workoutId
          ? `pts:workout:${workoutId}`
          : missionId
            ? `pts:mission:${missionId}`
            : achievementId
              ? `pts:achievement:${achievementId}`
              : `pts:${userId}:${points}:${reason}`
    }).catch(console.error);

    await notifyWishlistEligible(userId, scoreResult.userScore.totalPoints).catch(console.error);

    if (scoreResult.rankChanged && scoreResult.rankDirection === 'UP') {
      await notify(userId, 'RANK_UP', {
        title: '¡Subiste de rank!',
        body: `Ahora sos ${scoreResult.rank?.name || 'nuevo rank'}`,
        payload: { type: 'RANK_UP' },
        dedupeKey: `rankup:${userId}:${scoreResult.rank?.id || scoreResult.rank?.name}`
      }).catch(console.error);
    }
    // No notificar RANK_CHANGED al ganar puntos (imposible bajar); canje ya avisa en REWARD_REDEEMED.
  }

  return { event, points, ...scoreResult };
};

const deductPoints = async (userId, { points, reason, redemptionId }) => {
  return awardPoints(userId, {
    points: -Math.abs(points),
    reason,
    redemptionId
  });
};

const getPointsSummary = async (userId) => {
  const userScore = await prisma.userScore.findUnique({
    where: { userId },
    include: { currentRank: true }
  });

  const totalPoints = userScore?.totalPoints || 0;

  let nextRank = null;
  if (userScore?.currentRank) {
    nextRank = await prisma.rank.findFirst({
      where: {
        isActive: true,
        deletedAt: null,
        order: { gt: userScore.currentRank.order }
      },
      orderBy: { order: 'asc' }
    });
  } else {
    nextRank = await prisma.rank.findFirst({
      where: { isActive: true, deletedAt: null },
      orderBy: { order: 'asc' }
    });
  }

  const recentEvents = await prisma.scoreEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 5
  });

  const pointsToNextRank = nextRank ? Math.max(0, nextRank.minPoints - totalPoints) : null;

  return {
    totalPoints,
    rank: userScore?.currentRank || null,
    nextRank,
    pointsToNextRank,
    recentEvents: recentEvents.map((e) => ({
      ...e,
      ...deriveEventMeta(e)
    }))
  };
};

const getPointsHistory = async (userId, { page = 1, limit = 20, type = 'all' } = {}) => {
  const skip = (page - 1) * limit;
  const events = await prisma.scoreEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    skip,
    take: limit
  });

  const filtered = events.filter((e) => {
    const meta = deriveEventMeta(e);
    if (type === 'earned') return meta.type === 'EARNED';
    if (type === 'spent') return meta.type === 'SPENT';
    return true;
  });

  return filtered.map((e) => ({
    id: e.id,
    points: e.points,
    reason: e.reason,
    createdAt: e.createdAt,
    ...deriveEventMeta(e)
  }));
};

const getRewardSuggestions = async (userId) => {
  const totalPoints = (await prisma.userScore.findUnique({ where: { userId } }))?.totalPoints || 0;
  const now = new Date();

  const rewards = await prisma.reward.findMany({
    where: {
      status: 'ACTIVE',
      business: { status: 'APPROVED', isActive: true },
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }]
    },
    include: {
      business: { select: { id: true, name: true, logoUrl: true } }
    },
    orderBy: { pointsCost: 'asc' },
    take: 50
  });

  const withEffectiveCost = rewards.map((r) => {
    let effectiveCost = Math.max(0, Number(r.pointsCost) || 0);
    if (r.isFeatured && r.featuredUntil && r.featuredUntil > now && r.featuredDiscountPct && effectiveCost > 0) {
      effectiveCost = Math.max(0, Math.round(effectiveCost * (1 - r.featuredDiscountPct / 100)));
    }
    return { ...r, effectiveCost, pointsNeeded: Math.max(0, effectiveCost - totalPoints), canRedeem: totalPoints >= effectiveCost };
  });

  const nearest = withEffectiveCost.find((r) => !r.canRedeem) || null;
  const redeemable = withEffectiveCost.filter((r) => r.canRedeem);
  const almostThere = withEffectiveCost.filter(
    (r) => !r.canRedeem && r.effectiveCost > 0 && r.pointsNeeded <= r.effectiveCost * 0.2
  );

  return { totalPoints, nearest, redeemable, almostThere };
};

const awardActivityPoints = async (activityId) => {
  const activity = await prisma.activity.findUnique({
    where: { id: activityId },
    include: { user: true }
  });

  if (!activity || !activity.userId) return { points: 0 };

  const existing = await prisma.scoreEvent.findFirst({ where: { activityId } });
  if (existing) return { points: existing.points, alreadyScored: true };

  const points = calculateActivityPoints(activity);
  const result = await awardPoints(activity.userId, {
    points,
    reason: require('../constants/copy.es').copy.activityCompleted(activity.name),
    activityId: activity.id
  });

  return { points, ...result };
};

const awardActivityPointsIfNotScored = async (activityId) => {
  const existing = await prisma.scoreEvent.findFirst({ where: { activityId } });
  if (existing) return { points: existing.points, alreadyScored: true };
  return awardActivityPoints(activityId);
};

const batchScoreActivities = async (userId) => {
  const unscoredActivities = await prisma.activity.findMany({
    where: { userId, scoreEvents: { none: {} } }
  });

  let totalEarned = 0;
  for (const activity of unscoredActivities) {
    const result = await awardActivityPoints(activity.id);
    totalEarned += result.points || 0;
  }

  const scoreResult = await recalculateUserScore(userId);
  return { totalEarned, activitiesScored: unscoredActivities.length, ...scoreResult };
};

const calculateWorkoutPoints = (sets) => {
  const setPoints = sets.length * 5;
  const volumePoints = sets.reduce((sum, s) => sum + ((s.reps || 0) * (s.weightKg || 1) * 0.05), 0);
  return Math.max(0, Math.round(setPoints + volumePoints));
};

const awardWorkoutPoints = async (sessionId) => {
  const session = await prisma.workoutSession.findUnique({
    where: { id: sessionId },
    include: { sets: true }
  });

  if (!session || session.sets.length === 0) return { points: 0 };

  const existing = await prisma.scoreEvent.findFirst({ where: { workoutId: sessionId } });
  if (existing) return { points: existing.points, alreadyScored: true };

  const points = calculateWorkoutPoints(session.sets);
  const result = await awardPoints(session.userId, {
    points,
    reason: require('../constants/copy.es').copy.workoutCompleted(session.name),
    workoutId: sessionId
  });

  return { points, ...result };
};

const awardStreakBonusIfEligible = async (userId, currentStreak) => {
  const bonusPoints = STREAK_BONUSES[currentStreak];
  if (!bonusPoints) return null;

  const { copy } = require('../constants/copy.es');
  const reason = copy.streakBonus(currentStreak);

  const existing = await prisma.scoreEvent.findFirst({
    where: {
      userId,
      reason: { contains: copy.streakBonusContains(currentStreak) }
    }
  });
  if (existing) return null;

  return awardPoints(userId, {
    points: bonusPoints,
    reason
  });
};

const buildScoringResponse = (awardResult) => {
  if (!awardResult || awardResult.points === 0) {
    return { pointsEarned: 0, newTotalPoints: null, rankChanged: false, rank: null };
  }

  return {
    pointsEarned: awardResult.points,
    newTotalPoints: awardResult.userScore?.totalPoints ?? null,
    rankChanged: awardResult.rankChanged || false,
    rankDirection: awardResult.rankDirection || null,
    rank: awardResult.rank || null,
    previousRank: awardResult.previousRank || null
  };
};

module.exports = {
  TYPE_MULTIPLIERS,
  STREAK_BONUSES,
  deriveEventMeta,
  calculateActivityPoints,
  awardPoints,
  deductPoints,
  awardActivityPoints,
  awardActivityPointsIfNotScored,
  batchScoreActivities,
  recalculateUserScore,
  calculateWorkoutPoints,
  awardWorkoutPoints,
  awardStreakBonusIfEligible,
  getPointsSummary,
  getPointsHistory,
  getRewardSuggestions,
  buildScoringResponse
};
