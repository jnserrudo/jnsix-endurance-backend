const prisma = require('../lib/prisma');
const { notify } = require('./notifications.service');

/**
 * Resumen semanal in-app para usuarios con actividad en los últimos 7 días.
 */
async function sendWeeklyRecapNotifications() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekKey = `${weekAgo.toISOString().slice(0, 10)}_${now.toISOString().slice(0, 10)}`;

  const activeUsers = await prisma.activity.findMany({
    where: { startDate: { gte: weekAgo } },
    distinct: ['userId'],
    select: { userId: true },
  });

  let sent = 0;

  for (const { userId } of activeUsers) {
    const activities = await prisma.activity.findMany({
      where: { userId, startDate: { gte: weekAgo } },
      select: { distanceKm: true },
    });

    const km = activities.reduce((sum, a) => sum + (Number(a.distanceKm) || 0), 0);
    const pointsAgg = await prisma.scoreEvent.aggregate({
      where: { userId, createdAt: { gte: weekAgo }, points: { gt: 0 } },
      _sum: { points: true },
    });
    const points = pointsAgg._sum.points || 0;

    const title = 'Resumen semanal';
    const body = `Esta semana: ${km.toFixed(1)} km y ${points} puntos en ${activities.length} actividades.`;

    try {
      await notify(userId, 'SYSTEM', {
        title,
        body,
        payload: { kind: 'weekly_recap', km, points, activityCount: activities.length },
        dedupeKey: `weekly-recap-${weekKey}`,
        dedupeSeconds: 7 * 24 * 3600,
      });
      sent++;
    } catch (err) {
      console.error('[WeeklyRecap] notify failed for', userId, err.message);
    }
  }

  console.log(`[WeeklyRecap] Sent ${sent} recap notifications (week ${weekKey}).`);
  return sent;
}

module.exports = { sendWeeklyRecapNotifications };
