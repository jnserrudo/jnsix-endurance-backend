const prisma = require('../lib/prisma');
const { notify } = require('./notifications.service');
const { calculateStreakFromDates } = require('../utils/streak');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const sumKm = (rows) => rows.reduce((total, a) => total + (Number(a.distanceKm) || 0), 0);

/**
 * Arma el resumen semanal de un atleta. Lo usan el digest por email/push y la
 * pantalla de resumen en la app, para que los dos muestren lo mismo.
 */
async function buildWeeklyRecap(userId, { now = new Date() } = {}) {
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const twoWeeksAgo = new Date(now.getTime() - 2 * WEEK_MS);

  const [thisWeek, previousWeek, allDates, pointsAgg] = await Promise.all([
    prisma.activity.findMany({
      where: { userId, startDate: { gte: weekAgo } },
      select: {
        id: true,
        name: true,
        type: true,
        distanceKm: true,
        elevationM: true,
        movingTime: true,
        startDate: true,
      },
      orderBy: { startDate: 'desc' },
    }),
    prisma.activity.findMany({
      where: { userId, startDate: { gte: twoWeeksAgo, lt: weekAgo } },
      select: { distanceKm: true },
    }),
    prisma.activity.findMany({
      where: { userId },
      select: { startDate: true },
      orderBy: { startDate: 'desc' },
      take: 400,
    }),
    prisma.scoreEvent.aggregate({
      where: { userId, createdAt: { gte: weekAgo }, points: { gt: 0 } },
      _sum: { points: true },
    }),
  ]);

  const km = sumKm(thisWeek);
  const previousKm = sumKm(previousWeek);
  const streak = calculateStreakFromDates(allDates.map((a) => a.startDate));

  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ userId }, { friendId: userId }],
    },
    select: { userId: true, friendId: true },
  });
  const friendIds = friendships.map((f) => (f.userId === userId ? f.friendId : f.userId));

  let friendsRankTip = 'Seguí sumando km esta semana.';
  let myRank = null;
  let friendCount = friendIds.length;

  if (friendIds.length > 0) {
    const cohort = [userId, ...friendIds];
    const weekKmByUser = await prisma.activity.groupBy({
      by: ['userId'],
      where: {
        userId: { in: cohort },
        startDate: { gte: weekAgo },
      },
      _sum: { distanceKm: true },
    });
    const ranked = weekKmByUser
      .map((row) => ({
        userId: row.userId,
        km: Number(row._sum.distanceKm) || 0,
      }))
      .sort((a, b) => b.km - a.km);
    const myIndex = ranked.findIndex((r) => r.userId === userId);
    myRank = myIndex >= 0 ? myIndex + 1 : ranked.length + 1;
    const above = myIndex > 0 ? ranked[myIndex - 1] : null;
    if (myRank === 1) {
      friendsRankTip = '¡Vas primero entre tus amigos esta semana!';
    } else if (above) {
      const gap = (above.km - (ranked[myIndex]?.km || 0)).toFixed(1);
      friendsRankTip = `Estás #${myRank} entre amigos. Te faltan ${gap} km para alcanzar al de arriba.`;
    } else {
      friendsRankTip = `Estás #${myRank} entre tus amigos esta semana.`;
    }
  }

  const longest = thisWeek.reduce((best, a) => {
    if (!best) return a;
    return (Number(a.distanceKm) || 0) > (Number(best.distanceKm) || 0) ? a : best;
  }, null);

  // Días con actividad, para dibujar la semana en la app.
  const activeDays = new Set(
    thisWeek.map((a) => new Date(a.startDate).toISOString().slice(0, 10))
  );

  return {
    range: { from: weekAgo.toISOString(), to: now.toISOString() },
    km: Number(km.toFixed(1)),
    previousKm: Number(previousKm.toFixed(1)),
    kmDelta: Number((km - previousKm).toFixed(1)),
    activityCount: thisWeek.length,
    previousActivityCount: previousWeek.length,
    elevationM: Math.round(
      thisWeek.reduce((total, a) => total + (Number(a.elevationM) || 0), 0)
    ),
    movingTimeSec: Math.round(
      thisWeek.reduce((total, a) => total + (Number(a.movingTime) || 0), 0)
    ),
    pointsEarned: Math.round(Number(pointsAgg?._sum?.points) || 0),
    streak,
    activeDays: Array.from(activeDays).sort(),
    longestActivity: longest
      ? {
          id: longest.id,
          name: longest.name,
          type: longest.type,
          distanceKm: Number(longest.distanceKm) || 0,
          startDate: longest.startDate,
        }
      : null,
    friendsRankTip,
    myRank,
    friendCount,
  };
}

/**
 * Digest semanal: km, racha y tip de ranking entre amigos.
 * Usa notify SYSTEM (in-app + push + email según preferencias).
 */
async function sendWeeklyDigest() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const weekKey = `${weekAgo.toISOString().slice(0, 10)}_${now.toISOString().slice(0, 10)}`;

  const activeUsers = await prisma.activity.findMany({
    where: { startDate: { gte: weekAgo }, userId: { not: null } },
    distinct: ['userId'],
    select: { userId: true },
  });

  let sent = 0;

  for (const { userId } of activeUsers) {
    if (!userId) continue;

    try {
      const recap = await buildWeeklyRecap(userId, { now });

      const title = 'Tu resumen semanal está listo';
      const body = `Metiste ${recap.km.toFixed(1)} km en ${recap.activityCount} actividades y llevás una racha de ${recap.streak} días. ${recap.friendsRankTip}`;

      await notify(userId, 'SYSTEM', {
        title,
        body,
        payload: {
          kind: 'weekly_digest',
          screen: 'WeeklyRecap',
          km: recap.km,
          streak: recap.streak,
          activityCount: recap.activityCount,
          friendsRankTip: recap.friendsRankTip,
        },
        dedupeKey: `weekly-digest-${weekKey}`,
        dedupeSeconds: 7 * 24 * 3600,
      });
      sent++;
    } catch (err) {
      console.error('[WeeklyDigest] notify failed for', userId, err.message);
    }
  }

  console.log(`[WeeklyDigest] Sent ${sent} digests (week ${weekKey}).`);
  return { sent, weekKey };
}

module.exports = { sendWeeklyDigest, buildWeeklyRecap };
