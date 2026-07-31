const prisma = require('../lib/prisma');
const { notify } = require('./notifications.service');
const crypto = require('crypto');

/**
 * Recalcula el progreso de todos los challenges activos de un usuario.
 * Se invoca después de crear/sincronizar una actividad.
 */
const updateChallengeProgress = async (userId) => {
  const now = new Date();

  const participations = await prisma.challengeParticipant.findMany({
    where: {
      userId,
      completed: false,
      challenge: {
        isActive: true,
        deletedAt: null,
        startDate: { lte: now },
        endDate: { gte: now },
      },
    },
    include: {
      challenge: {
        include: {
          sponsorBusiness: { select: { id: true, name: true } },
          sponsorReward: { select: { id: true, title: true, businessId: true, status: true } },
        },
      },
    },
  });

  for (const participation of participations) {
    const challenge = participation.challenge;
    const progress = await calculateProgress(userId, challenge);

    const updateData = { currentProgress: progress };
    const justCompleted = progress >= challenge.targetValue;

    if (justCompleted) {
      updateData.completed = true;
      updateData.completedAt = now;
    }

    await prisma.challengeParticipant.update({
      where: {
        challengeId_userId: {
          challengeId: challenge.id,
          userId,
        },
      },
      data: updateData,
    });

    if (justCompleted) {
      const sponsorGrant = await grantSponsorRewardIfEligible(userId, challenge);

      const sponsorSuffix = sponsorGrant?.redemption
        ? ` ${challenge.sponsorBusiness?.name || 'El sponsor'} te dejó un cupón: ${sponsorGrant.redemption.code}.`
        : '';

      await notify(userId, 'CHALLENGE_COMPLETE', {
        title: 'Reto completado',
        body: `Completaste el reto "${challenge.name}".${sponsorSuffix}`,
        payload: {
          challengeId: challenge.id,
          screen: sponsorGrant?.redemption ? 'MyCoupons' : 'Challenges',
          redemptionId: sponsorGrant?.redemption?.id || null,
        },
      });
    }
  }
};

/**
 * Si el reto tiene un premio patrocinado y todavía no se otorgó, genera un
 * canje a costo 0. El negocio paga con el beneficio, el atleta no gasta puntos.
 */
const grantSponsorRewardIfEligible = async (userId, challenge) => {
  if (!challenge.sponsorRewardId || !challenge.sponsorBusinessId) return null;

  const participation = await prisma.challengeParticipant.findUnique({
    where: { challengeId_userId: { challengeId: challenge.id, userId } },
  });
  if (!participation || participation.sponsorRewardGranted) return null;

  const reward = await prisma.reward.findUnique({
    where: { id: challenge.sponsorRewardId },
  });
  if (!reward || reward.status !== 'ACTIVE') {
    console.warn(
      `[Challenge] premio patrocinado ${challenge.sponsorRewardId} no disponible para el reto ${challenge.id}`
    );
    return null;
  }
  if (reward.businessId !== challenge.sponsorBusinessId) {
    console.warn(
      `[Challenge] el premio ${reward.id} no pertenece al sponsor ${challenge.sponsorBusinessId}`
    );
    return null;
  }

  // Stock: si hay tope y ya no queda, no entregamos el canje.
  if (reward.stockRemaining != null && reward.stockRemaining <= 0) {
    console.warn(`[Challenge] sin stock del premio patrocinado ${reward.id}`);
    return null;
  }

  const code = `SPN-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  const redemption = await prisma.$transaction(async (tx) => {
    const created = await tx.redemption.create({
      data: {
        userId,
        rewardId: reward.id,
        businessId: challenge.sponsorBusinessId,
        code,
        pointsSpent: 0,
        status: 'ACTIVE',
        expiresAt: reward.expiresAt || null,
      },
    });

    if (reward.stockRemaining != null) {
      await tx.reward.update({
        where: { id: reward.id },
        data: { stockRemaining: { decrement: 1 } },
      });
    }

    await tx.challengeParticipant.update({
      where: { challengeId_userId: { challengeId: challenge.id, userId } },
      data: { sponsorRewardGranted: true },
    });

    return created;
  });

  // Aviso al dueño del local: alguien completó su reto patrocinado.
  try {
    const business = await prisma.business.findUnique({
      where: { id: challenge.sponsorBusinessId },
      select: { userId: true, name: true },
    });
    if (business?.userId) {
      await notify(business.userId, 'SYSTEM', {
        title: 'Alguien completó tu reto patrocinado',
        body: `Un atleta terminó "${challenge.name}" y recibió el cupón ${redemption.code}.`,
        payload: {
          kind: 'sponsored_challenge_complete',
          challengeId: challenge.id,
          redemptionId: redemption.id,
          screen: 'BusinessRedemptions',
        },
        dedupeKey: `sponsored-challenge-${challenge.id}-${userId}`,
        dedupeSeconds: 30 * 24 * 3600,
      });
    }
  } catch (err) {
    console.warn('[Challenge] notify al sponsor falló:', err.message);
  }

  return { redemption };
};

/**
 * Calcula el progreso actual de un usuario en un challenge sumando
 * las actividades dentro del rango de fechas del reto.
 */
const calculateProgress = async (userId, challenge) => {
  const activities = await prisma.activity.findMany({
    where: {
      userId,
      startDate: {
        gte: challenge.startDate,
        lte: challenge.endDate,
      },
    },
  });

  switch (challenge.metric) {
    case 'DISTANCE':
      return activities.reduce((sum, a) => sum + (a.distanceKm || 0), 0);
    case 'ELEVATION':
      return activities.reduce((sum, a) => sum + (a.elevationM || 0), 0);
    case 'TIME':
      return activities.reduce((sum, a) => sum + ((a.movingTime || 0) / 3600), 0);
    case 'FREQUENCY':
      return activities.length;
    default:
      return 0;
  }
};

/**
 * Valida que el negocio y el premio existan, estén activos y se pertenezcan.
 * Lo usan el alta y la edición del reto.
 */
const resolveSponsor = async ({ sponsorBusinessId, sponsorRewardId, sponsorLabel }) => {
  if (!sponsorBusinessId && !sponsorRewardId) {
    return {
      sponsorBusinessId: null,
      sponsorRewardId: null,
      sponsorLabel: sponsorLabel || null,
    };
  }

  if (!sponsorBusinessId || !sponsorRewardId) {
    const err = new Error(
      'Un reto patrocinado necesita el negocio y el beneficio que se entrega al completar.'
    );
    err.status = 400;
    throw err;
  }

  const business = await prisma.business.findUnique({
    where: { id: sponsorBusinessId },
    select: { id: true, name: true, status: true, isActive: true },
  });
  if (!business || business.status !== 'APPROVED' || !business.isActive) {
    const err = new Error('El negocio sponsor tiene que estar aprobado y activo.');
    err.status = 400;
    throw err;
  }

  const reward = await prisma.reward.findUnique({
    where: { id: sponsorRewardId },
    select: { id: true, businessId: true, status: true, title: true },
  });
  if (!reward || reward.businessId !== business.id) {
    const err = new Error('El beneficio sponsor tiene que pertenecer a ese negocio.');
    err.status = 400;
    throw err;
  }
  if (reward.status !== 'ACTIVE') {
    const err = new Error('El beneficio sponsor tiene que estar activo.');
    err.status = 400;
    throw err;
  }

  return {
    sponsorBusinessId: business.id,
    sponsorRewardId: reward.id,
    sponsorLabel: sponsorLabel || `Premiado por ${business.name}`,
  };
};

module.exports = {
  updateChallengeProgress,
  calculateProgress,
  grantSponsorRewardIfEligible,
  resolveSponsor,
};
