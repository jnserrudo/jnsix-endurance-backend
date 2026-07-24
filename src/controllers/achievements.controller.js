const prisma = require('../lib/prisma');
const scoringService = require('../services/scoring.service');
const { copy, ACHIEVEMENT_DEFS } = require('../constants/copy.es');

const getAchievements = async (req, res) => {
  try {
    const achievements = await prisma.achievement.findMany({ orderBy: { points: 'asc' } });
    res.json(achievements);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getUserAchievements = async (req, res) => {
  try {
    const userId = req.params.userId || req.user.id;
    const userAchievements = await prisma.userAchievement.findMany({
      where: { userId },
      include: { achievement: true },
      orderBy: { unlockedAt: 'desc' }
    });
    res.json(userAchievements);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

async function findOrMigrateAchievement(def) {
  let record = await prisma.achievement.findUnique({ where: { name: def.name } });
  if (record) return record;

  for (const legacy of def.legacyNames || []) {
    const old = await prisma.achievement.findUnique({ where: { name: legacy } });
    if (old) {
      return prisma.achievement.update({
        where: { id: old.id },
        data: {
          name: def.name,
          description: def.description,
          points: def.points,
        },
      });
    }
  }

  return prisma.achievement.create({
    data: {
      name: def.name,
      description: def.description,
      points: def.points,
    },
  });
}

/** Días únicos con actividad y racha actual / máxima histórica. */
function computeStreakStats(activities) {
  if (!activities.length) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const uniqueDays = [
    ...new Set(
      activities.map((a) => {
        const d = new Date(a.startDate);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      })
    ),
  ].sort((a, b) => a - b);

  let longestStreak = 1;
  let run = 1;
  for (let i = 1; i < uniqueDays.length; i++) {
    if (uniqueDays[i] - uniqueDays[i - 1] === dayMs) {
      run++;
    } else {
      longestStreak = Math.max(longestStreak, run);
      run = 1;
    }
  }
  longestStreak = Math.max(longestStreak, run);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const sortedDesc = [...uniqueDays].sort((a, b) => b - a);

  let currentStreak = 0;
  let cursor = todayMs;
  if (sortedDesc[0] === todayMs || sortedDesc[0] === todayMs - dayMs) {
    cursor = sortedDesc[0];
    for (const day of sortedDesc) {
      if (day === cursor) {
        currentStreak++;
        cursor -= dayMs;
      } else if (day < cursor) {
        break;
      }
    }
  }

  return { currentStreak, longestStreak };
}

function buildAchievementConditions(
  activities,
  streakStats,
  totalElevationM,
  strengthWorkoutCount,
  redemptionCount = 0
) {
  let totalDistanceKm = 0;
  activities.forEach((act) => {
    totalDistanceKm += act.distanceKm || 0;
  });

  const count = activities.length;
  const hasMinDistance = (km) => activities.some((a) => (a.distanceKm || 0) >= km);
  const hasType = (type) => activities.some((a) => a.type === type);
  const maxElevationSession = activities.reduce((m, a) => Math.max(m, a.elevationM || 0), 0);
  const isEarlyBird = activities.some((a) => {
    const d = a.startDate instanceof Date ? a.startDate : new Date(a.startDate);
    return d.getHours() < 7;
  });

  const { currentStreak, longestStreak } = streakStats;

  return {
    'Primera Actividad': count >= 1,
    'Primer 10K': hasMinDistance(10),
    '100 km totales': totalDistanceKm >= 100,
    'Primera 5K': hasMinDistance(5),
    'Primer 21K': hasMinDistance(21),
    '50 km totales': totalDistanceKm >= 50,
    '500 km totales': totalDistanceKm >= 500,
    '1000 km': totalDistanceKm >= 1000,
    'Primera carrera trail': hasType('TRAIL_RUN'),
    'Primer ride': hasType('RIDE') || hasType('VIRTUAL_RIDE'),
    '10 actividades': count >= 10,
    '50 actividades': count >= 50,
    'Racha 7 días': currentStreak >= 7 || longestStreak >= 7,
    'Racha 30 días': currentStreak >= 30 || longestStreak >= 30,
    'Elevación 1000m en una sesión': maxElevationSession >= 1000,
    'Elevación 10k total': totalElevationM >= 10000,
    'Natación debut': hasType('SWIM'),
    'Primer workout fuerza': strengthWorkoutCount >= 1,
    'Madrugador': isEarlyBird,
    'Primer Canje': redemptionCount >= 1,
  };
}

const checkAchievements = async (userId) => {
  try {
    const [activities, strengthWorkoutCount, redemptionCount] = await Promise.all([
      prisma.activity.findMany({
        where: { userId },
        select: {
          distanceKm: true,
          elevationM: true,
          type: true,
          startDate: true,
        },
      }),
      prisma.workoutSession.count({
        where: { userId, completedAt: { not: null } },
      }),
      prisma.redemption.count({ where: { userId } }),
    ]);

    let totalElevationM = 0;
    activities.forEach((act) => {
      totalElevationM += act.elevationM || 0;
    });

    const streakStats = computeStreakStats(activities);
    const conditions = buildAchievementConditions(
      activities,
      streakStats,
      totalElevationM,
      strengthWorkoutCount,
      redemptionCount
    );

    const unlocked = [];

    for (const def of ACHIEVEMENT_DEFS) {
      if (!conditions[def.name]) continue;

      const achievementRecord = await findOrMigrateAchievement(def);

      const existing = await prisma.userAchievement.findUnique({
        where: {
          userId_achievementId: {
            userId,
            achievementId: achievementRecord.id,
          },
        },
      });

      if (!existing) {
        await prisma.userAchievement.create({
          data: { userId, achievementId: achievementRecord.id },
        });
        unlocked.push(achievementRecord);

        await scoringService.awardPoints(userId, {
          points: achievementRecord.points,
          reason: copy.achievementUnlocked(achievementRecord.name),
          achievementId: achievementRecord.id,
        });
      }
    }
    return unlocked;
  } catch (error) {
    console.error('Error checking achievements:', error);
    throw error;
  }
};

const triggerCheck = async (req, res) => {
  try {
    const userId = req.user.id;
    const newAchievements = await checkAchievements(userId);
    res.json({ success: true, unlocked: newAchievements });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  getAchievements,
  getUserAchievements,
  checkAchievements,
  triggerCheck,
  findOrMigrateAchievement,
  computeStreakStats,
};
