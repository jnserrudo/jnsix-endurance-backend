const prisma = require('../lib/prisma');

const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

const isMonday = (d = new Date()) => d.getDay() === 1;

/**
 * Activa/desactiva misiones según ventana de fechas y rota diarias/semanales.
 * - DAILY_*: ventana de 1 día (hoy → mañana)
 * - WEEKLY_*: ventana de 7 días (lunes → domingo+1); se reabre los lunes
 * - Otras: solo se desactivan si endDate ya pasó
 */
async function rotateMissions() {
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 7);

  // Expirar misiones con ventana vencida
  const expired = await prisma.mission.updateMany({
    where: {
      isActive: true,
      endDate: { lt: now },
    },
    data: { isActive: false },
  });

  // Rotar diarias: reactivar y resetear ventana
  const dailyMissions = await prisma.mission.findMany({
    where: { type: { startsWith: 'DAILY_' } },
  });

  for (const mission of dailyMissions) {
    await prisma.mission.update({
      where: { id: mission.id },
      data: {
        isActive: true,
        startDate: today,
        endDate: tomorrow,
      },
    });
    // Limpiar progreso del período anterior para que sea jugable de nuevo
    await prisma.userMission.deleteMany({
      where: { missionId: mission.id, completed: false },
    });
  }

  // Rotar semanales solo los lunes (o si ninguna está activa)
  const weeklyMissions = await prisma.mission.findMany({
    where: { type: { startsWith: 'WEEKLY_' } },
  });

  const anyWeeklyActive = weeklyMissions.some(
    (m) => m.isActive && m.endDate && m.endDate > now
  );

  if (isMonday(now) || !anyWeeklyActive) {
    for (const mission of weeklyMissions) {
      await prisma.mission.update({
        where: { id: mission.id },
        data: {
          isActive: true,
          startDate: today,
          endDate: weekEnd,
        },
      });
      await prisma.userMission.deleteMany({
        where: { missionId: mission.id, completed: false },
      });
    }
  }

  console.log(
    `[rotateMissions] expired=${expired.count}, daily=${dailyMissions.length}, weekly=${weeklyMissions.length}`
  );

  return {
    expired: expired.count,
    daily: dailyMissions.length,
    weekly: weeklyMissions.length,
  };
}

/** Filtro Prisma para misiones vigentes (activas + dentro de fechas). */
function activeMissionWhere(now = new Date()) {
  return {
    isActive: true,
    AND: [
      { OR: [{ startDate: null }, { startDate: { lte: now } }] },
      { OR: [{ endDate: null }, { endDate: { gte: now } }] },
    ],
  };
}

/**
 * Misión destacada del día (ruleta): prioriza DAILY_*, sino rota entre activas.
 */
async function getTodayMissionForUser(userId, now = new Date()) {
  const active = await prisma.mission.findMany({
    where: activeMissionWhere(now),
    include: {
      userMissions: { where: { userId } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!active.length) return null;

  const daily = active.filter((m) => String(m.type || '').startsWith('DAILY_'));
  const pool = daily.length ? daily : active;

  const dayIndex = Math.floor(startOfDay(now).getTime() / 86400000);
  const picked = pool[dayIndex % pool.length];
  const userMission = picked.userMissions[0] || null;

  return {
    id: picked.id,
    name: picked.name,
    description: picked.description,
    type: picked.type,
    targetValue: picked.targetValue,
    rewardPts: picked.rewardPts,
    startDate: picked.startDate,
    endDate: picked.endDate,
    progress: userMission ? userMission.currentProgress : 0,
    completed: userMission ? userMission.completed : false,
    completedAt: userMission ? userMission.completedAt : null,
    pool: pool.map((m) => ({ id: m.id, name: m.name, type: m.type })),
  };
}

module.exports = {
  rotateMissions,
  activeMissionWhere,
  startOfDay,
  addDays,
  getTodayMissionForUser,
};
