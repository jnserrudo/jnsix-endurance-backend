const prisma = require('../lib/prisma');
const { notify } = require('./notifications.service');

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
        endDate: { gte: now }
      }
    },
    include: { challenge: true }
  });

  for (const participation of participations) {
    const challenge = participation.challenge;
    const progress = await calculateProgress(userId, challenge);

    const updateData = { currentProgress: progress };

    if (progress >= challenge.targetValue) {
      updateData.completed = true;
      updateData.completedAt = now;
    }

    await prisma.challengeParticipant.update({
      where: {
        challengeId_userId: {
          challengeId: challenge.id,
          userId
        }
      },
      data: updateData
    });

    if (updateData.completed) {
      await notify(userId, 'CHALLENGE_COMPLETE', {
        title: 'Reto completado',
        body: `Completaste el reto "${challenge.name}"`,
        payload: { challengeId: challenge.id }
      });
    }
  }
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
        lte: challenge.endDate
      }
    }
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

module.exports = {
  updateChallengeProgress,
  calculateProgress
};
