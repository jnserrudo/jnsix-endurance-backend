const { prisma } = require('../lib/prisma');

const getStreak = async (req, res) => {
  try {
    const userId = req.user.id;
    let streak = await prisma.streak.findUnique({
      where: { userId }
    });

    if (!streak) {
      streak = await prisma.streak.create({
        data: {
          user: { connect: { id: userId } },
          currentStreak: 0,
          longestStreak: 0
        }
      });
    }

    res.json(streak);
  } catch (error) {
    console.error('[GET STREAK ERROR]', error);
    res.status(500).json({ error: 'Error al obtener la racha' });
  }
};

const getMissions = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Fetch all active missions
    const missions = await prisma.mission.findMany({
      where: { isActive: true },
      include: {
        userMissions: {
          where: { userId }
        }
      }
    });

    // Format missions with user progress
    const formattedMissions = missions.map(mission => {
      const userMission = mission.userMissions[0] || null;
      return {
        id: mission.id,
        name: mission.name,
        description: mission.description,
        type: mission.type,
        targetValue: mission.targetValue,
        rewardPts: mission.rewardPts,
        startDate: mission.startDate,
        endDate: mission.endDate,
        progress: userMission ? userMission.currentProgress : 0,
        completed: userMission ? userMission.completed : false,
        completedAt: userMission ? userMission.completedAt : null,
      };
    });

    res.json(formattedMissions);
  } catch (error) {
    console.error('[GET MISSIONS ERROR]', error);
    res.status(500).json({ error: 'Error al obtener las misiones' });
  }
};

const updateMissionProgress = async (req, res) => {
  try {
    const userId = req.user.id;
    const missionId = req.params.id;
    const { progress } = req.body;

    const mission = await prisma.mission.findUnique({ where: { id: missionId } });
    if (!mission) return res.status(404).json({ error: 'Misión no encontrada' });

    let userMission = await prisma.userMission.findFirst({
      where: { userId, missionId }
    });

    const newProgress = (userMission?.currentProgress || 0) + (progress || 1);
    const completed = newProgress >= mission.targetValue;

    if (!userMission) {
      userMission = await prisma.userMission.create({
        data: {
          user: { connect: { id: userId } },
          mission: { connect: { id: missionId } },
          currentProgress: newProgress,
          completed,
          completedAt: completed ? new Date() : null
        }
      });
    } else {
      userMission = await prisma.userMission.update({
        where: { id: userMission.id },
        data: {
          currentProgress: newProgress,
          completed,
          completedAt: (!userMission.completed && completed) ? new Date() : userMission.completedAt
        }
      });
    }

    res.json(userMission);
  } catch (error) {
    console.error('[UPDATE MISSION PROGRESS ERROR]', error);
    res.status(500).json({ error: 'Error al actualizar progreso de misión' });
  }
};

const checkUnlockables = async (req, res) => {
  try {
    const userId = req.user.id;
    // Check pending achievements or missions that have been fulfilled passively
    const userMissions = await prisma.userMission.findMany({
      where: { userId, completed: true },
      include: { mission: true }
    });
    
    // Simplification for the frontend that expects an array of unlocked stuff
    res.json({ newlyUnlocked: [], completedMissions: userMissions });
  } catch (error) {
    console.error('[CHECK UNLOCKABLES ERROR]', error);
    res.status(500).json({ error: 'Error al verificar desbloqueos' });
  }
};

module.exports = {
  getStreak,
  getMissions,
  updateMissionProgress,
  checkUnlockables
};
