const prisma = require('../lib/prisma');
const { notify } = require('./notifications.service');

const ACWR_HIGH_THRESHOLD = 1.5;
const THROTTLE_DAYS = 3;

function simpleLoad(activities) {
  return activities.reduce((sum, a) => {
    const distance = a.distanceKm || 0;
    const timeMin = (a.movingTime || 0) / 60;
    return sum + distance * timeMin;
  }, 0);
}

/**
 * Si week load / 4-week avg (ACWR-like) > 1.5, notifica TRAINING_LOAD.
 * Throttle: como máximo una vez cada 3 días.
 */
async function checkAndNotifyTrainingLoad(userId) {
  if (!userId) return null;

  try {
    const recentNotif = await prisma.notification.findFirst({
      where: {
        userId,
        type: 'TRAINING_LOAD',
        createdAt: { gte: new Date(Date.now() - THROTTLE_DAYS * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recentNotif) return null;

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twentyEightDaysAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

    const activities = await prisma.activity.findMany({
      where: {
        userId,
        startDate: { gte: twentyEightDaysAgo },
      },
      select: {
        distanceKm: true,
        movingTime: true,
        startDate: true,
      },
    });

    if (!activities.length) return null;

    const weekActs = activities.filter((a) => new Date(a.startDate) >= sevenDaysAgo);
    const weekLoad = simpleLoad(weekActs);
    const fourWeekLoad = simpleLoad(activities);
    const fourWeekAvg = fourWeekLoad / 4;

    if (fourWeekAvg <= 0) return null;

    const ratio = weekLoad / fourWeekAvg;
    if (ratio <= ACWR_HIGH_THRESHOLD) return null;

    return notify(userId, 'TRAINING_LOAD', {
      title: 'Carga de entrenamiento elevada',
      body: `Tu carga de esta semana es ${ratio.toFixed(2)}× el promedio de 4 semanas. Considerá bajar el volumen o priorizar recuperación.`,
      payload: {
        type: 'TRAINING_LOAD',
        ratio: Number(ratio.toFixed(2)),
        weekLoad: Math.round(weekLoad),
        fourWeekAvg: Math.round(fourWeekAvg),
        screen: 'Dashboard',
      },
      dedupeKey: `training-load-${userId}`,
      dedupeSeconds: THROTTLE_DAYS * 24 * 3600,
    });
  } catch (err) {
    console.error('[TrainingLoad] check failed:', err.message);
    return null;
  }
}

module.exports = { checkAndNotifyTrainingLoad, ACWR_HIGH_THRESHOLD };
