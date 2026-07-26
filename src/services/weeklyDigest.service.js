const prisma = require('../lib/prisma');
const { notify } = require('./notifications.service');
const { calculateStreakFromDates } = require('../utils/streak');

/**
 * Digest semanal: km, racha y tip de ranking entre amigos.
 * Usa notify SYSTEM (in-app + push + email según preferencias).
 */
async function sendWeeklyDigest() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekKey = `${weekAgo.toISOString().slice(0, 10)}_${now.toISOString().slice(0, 10)}`;

  const activeUsers = await prisma.activity.findMany({
    where: { startDate: { gte: weekAgo }, userId: { not: null } },
    distinct: ['userId'],
    select: { userId: true },
  });

  let sent = 0;

  for (const { userId } of activeUsers) {
    if (!userId) continue;

    const activities = await prisma.activity.findMany({
      where: { userId, startDate: { gte: weekAgo } },
      select: { distanceKm: true, startDate: true },
    });

    const km = activities.reduce((sum, a) => sum + (Number(a.distanceKm) || 0), 0);
    const activityCount = activities.length;

    const allDates = await prisma.activity.findMany({
      where: { userId },
      select: { startDate: true },
      orderBy: { startDate: 'desc' },
      take: 400,
    });
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
      const myRank = myIndex >= 0 ? myIndex + 1 : ranked.length + 1;
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

    const title = 'Tu resumen semanal está listo';
    const body = `Metiste ${km.toFixed(1)} km en ${activityCount} actividades y llevás una racha de ${streak} días. ${friendsRankTip}`;

    try {
      await notify(userId, 'SYSTEM', {
        title,
        body,
        payload: {
          kind: 'weekly_digest',
          km,
          streak,
          activityCount,
          friendsRankTip,
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

module.exports = { sendWeeklyDigest };
