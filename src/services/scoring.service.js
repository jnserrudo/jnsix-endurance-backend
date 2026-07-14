const prisma = require('../lib/prisma');

// Puntos base por tipo de actividad (multiplicador de esfuerzo relativo)
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

/**
 * Calcula puntos para una actividad basada en distancia (km), elevacion (m),
 * tiempo (segundos) y tipo. Redondeado a enteros.
 */
const calculateActivityPoints = (activity) => {
  const distancePoints = activity.distanceKm * 10;
  const elevationPoints = activity.elevationM * 0.5;
  const timePoints = (activity.movingTime / 3600) * 20;
  const multiplier = TYPE_MULTIPLIERS[activity.type] || 1;

  const total = (distancePoints + elevationPoints + timePoints) * multiplier;
  return Math.max(0, Math.round(total));
};

/**
 * Asigna puntos por una actividad y actualiza el UserScore del usuario.
 * Se llama automaticamente desde activities.controller.js al crear actividad.
 */
const awardActivityPoints = async (activityId) => {
  const activity = await prisma.activity.findUnique({
    where: { id: activityId },
    include: { user: true }
  });

  if (!activity || !activity.userId) return;

  const points = calculateActivityPoints(activity);

  await prisma.scoreEvent.create({
    data: {
      userId: activity.userId,
      activityId: activity.id,
      points,
      reason: `Activity completed: ${activity.name}`
    }
  });

  await recalculateUserScore(activity.userId);
};

/**
 * Recalcula el total de puntos y el rango actual de un usuario.
 */
const recalculateUserScore = async (userId) => {
  const aggregate = await prisma.scoreEvent.aggregate({
    where: { userId },
    _sum: { points: true }
  });

  const totalPoints = aggregate._sum.points || 0;

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
    }
  });

  return { userScore, rank };
};

/**
 * Idempotente: otorga puntos solo si no existe un ScoreEvent previo para esta actividad.
 * Util para sync y upserts donde no sabemos si se creo o actualizo.
 */
const awardActivityPointsIfNotScored = async (activityId) => {
  const existing = await prisma.scoreEvent.findUnique({ where: { activityId } });
  if (!existing) {
    await awardActivityPoints(activityId);
  }
};

/**
 * Recalcula y otorga ScoreEvents para un lote de actividades de un usuario.
 * Util al finalizar una sincronizacion batch (createMany).
 */
const batchScoreActivities = async (userId) => {
  const unscoredActivities = await prisma.activity.findMany({
    where: { userId, scoreEvents: { none: {} } }
  });

  for (const activity of unscoredActivities) {
    await awardActivityPoints(activity.id);
  }

  await recalculateUserScore(userId);
};

/**
 * Calcula puntos para una sesion de entrenamiento de fuerza en base a
 * numero de series completadas y volumen (reps * peso).
 */
const calculateWorkoutPoints = (sets) => {
  const setPoints = sets.length * 5;
  const volumePoints = sets.reduce((sum, s) => sum + ((s.reps || 0) * (s.weightKg || 1) * 0.05), 0);
  return Math.max(0, Math.round(setPoints + volumePoints));
};

/**
 * Asigna puntos por una sesion de entrenamiento de fuerza completada.
 * Se llama al marcar una WorkoutSession como completada.
 */
const awardWorkoutPoints = async (sessionId) => {
  const session = await prisma.workoutSession.findUnique({
    where: { id: sessionId },
    include: { sets: true }
  });

  if (!session || session.sets.length === 0) return;

  const points = calculateWorkoutPoints(session.sets);

  await prisma.scoreEvent.create({
    data: {
      userId: session.userId,
      points,
      reason: `Workout session completed: ${session.name}`
    }
  });

  await recalculateUserScore(session.userId);
};

module.exports = {
  calculateActivityPoints,
  awardActivityPoints,
  awardActivityPointsIfNotScored,
  batchScoreActivities,
  recalculateUserScore,
  calculateWorkoutPoints,
  awardWorkoutPoints
};
