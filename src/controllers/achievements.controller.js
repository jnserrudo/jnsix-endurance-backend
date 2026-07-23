const prisma = require('../lib/prisma');
const scoringService = require('../services/scoring.service');

const getAchievements = async (req, res) => {
  try {
    const achievements = await prisma.achievement.findMany();
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

const checkAchievements = async (userId) => {
  try {
    const activities = await prisma.activity.findMany({ where: { userId } });
    let totalDistanceKm = 0;
    
    activities.forEach(act => { totalDistanceKm += act.distanceKm; });

    const achievementsToCheck = [
      { name: 'First Activity', condition: activities.length >= 1, description: 'Registraste tu primera actividad.', points: 10 },
      { name: 'First 10K', condition: activities.some(a => a.distanceKm >= 10), description: 'Completaste tu primer 10K.', points: 50 },
      { name: '100 km total', condition: totalDistanceKm >= 100, description: 'Alcanzaste 100 km totales.', points: 100 }
    ];

    const unlocked = [];

    for (const ach of achievementsToCheck) {
      if (ach.condition) {
        let achievementRecord = await prisma.achievement.findUnique({ where: { name: ach.name } });
        if (!achievementRecord) {
          achievementRecord = await prisma.achievement.create({
            data: { name: ach.name, description: ach.description, points: ach.points }
          });
        }

        const existing = await prisma.userAchievement.findUnique({
          where: { userId_achievementId: { userId, achievementId: achievementRecord.id } }
        });

        if (!existing) {
          await prisma.userAchievement.create({ data: { userId, achievementId: achievementRecord.id } });
          unlocked.push(achievementRecord);

          await scoringService.awardPoints(userId, {
            points: achievementRecord.points,
            reason: `Achievement unlocked: ${achievementRecord.name}`,
            achievementId: achievementRecord.id
          });
        }
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
  triggerCheck
};
