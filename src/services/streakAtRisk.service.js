const prisma = require('../lib/prisma');
const { notify } = require('./notifications.service');

/**
 * Avisa a usuarios con racha activa (>=2) cuya última actividad fue ayer
 * (si no entrenan hoy, pierden la racha).
 */
async function sendStreakAtRiskNotifications() {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const dayBefore = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
  const dayKey = today.toISOString().slice(0, 10);

  const recentActs = await prisma.activity.findMany({
    where: { startDate: { gte: dayBefore } },
    select: { userId: true, startDate: true },
    orderBy: { startDate: 'desc' },
  });

  /** @type {Map<string, Date[]>} */
  const byUser = new Map();
  for (const a of recentActs) {
    if (!byUser.has(a.userId)) byUser.set(a.userId, []);
    byUser.get(a.userId).push(new Date(a.startDate));
  }

  let sent = 0;

  for (const [userId, dates] of byUser.entries()) {
    const daySet = new Set(
      dates.map((d) => {
        const x = new Date(d);
        x.setHours(0, 0, 0, 0);
        return x.getTime();
      })
    );

    const trainedToday = daySet.has(today.getTime());
    const trainedYesterday = daySet.has(yesterday.getTime());
    if (trainedToday || !trainedYesterday) continue;

    // Estimar racha mirando hacia atrás desde ayer
    const hist = await prisma.activity.findMany({
      where: { userId },
      select: { startDate: true },
      orderBy: { startDate: 'desc' },
      take: 60,
    });
    const unique = [
      ...new Set(
        hist.map((a) => {
          const d = new Date(a.startDate);
          d.setHours(0, 0, 0, 0);
          return d.getTime();
        })
      ),
    ].sort((a, b) => b - a);

    let streak = 0;
    let cursor = yesterday.getTime();
    for (const day of unique) {
      if (day === cursor) {
        streak++;
        cursor -= 24 * 60 * 60 * 1000;
      } else if (day < cursor) {
        break;
      }
    }

    if (streak < 2) continue;

    try {
      await notify(userId, 'SYSTEM', {
        title: 'Tu racha está en riesgo',
        body: `Llevás ${streak} días. Si no registrás una actividad hoy, se reinicia.`,
        payload: { kind: 'streak_at_risk', streak },
        dedupeKey: `streak-at-risk-${dayKey}`,
        dedupeSeconds: 20 * 3600,
      });
      sent++;
    } catch (err) {
      console.error('[StreakAtRisk] notify failed for', userId, err.message);
    }
  }

  console.log(`[StreakAtRisk] Sent ${sent} notifications.`);
  return sent;
}

module.exports = { sendStreakAtRiskNotifications };
