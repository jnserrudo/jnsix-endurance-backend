const prisma = require('../lib/prisma');
const gamificationService = require('../services/gamification.service');
const seasonService = require('../services/season.service');

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

    const atRisk = await gamificationService.getStreakAtRiskStatus(userId);
    res.json({ ...streak, atRisk: atRisk.atRisk, atRiskDetail: atRisk });
  } catch (error) {
    console.error('[GET STREAK ERROR]', error);
    res.status(500).json({ error: 'Error al obtener la racha' });
  }
};

const getMissions = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activeMissionWhere } = require('../services/missionRotation.service');
    const now = new Date();

    const missions = await prisma.mission.findMany({
      where: activeMissionWhere(now),
      include: {
        userMissions: {
          where: { userId }
        }
      }
    });

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

const getTodayMission = async (req, res) => {
  try {
    const mission = await gamificationService.getTodayMission(req.user.id);
    if (!mission) {
      return res.json({ mission: null, message: 'No hay misión del día' });
    }
    res.json({ mission });
  } catch (error) {
    console.error('[GET TODAY MISSION ERROR]', error);
    res.status(500).json({ error: 'Error al obtener la misión de hoy' });
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
    const newlyEarnedBadges = await gamificationService.checkAndAwardBadges(userId);
    const combo = await gamificationService.checkDailyComboBonus(userId);
    const userMissions = await prisma.userMission.findMany({
      where: { userId, completed: true },
      include: { mission: true }
    });

    res.json({
      newlyUnlocked: newlyEarnedBadges.map((ub) => ({
        type: 'badge',
        id: ub.badge.id,
        code: ub.badge.code,
        name: ub.badge.name,
      })),
      combo,
      completedMissions: userMissions,
    });
  } catch (error) {
    console.error('[CHECK UNLOCKABLES ERROR]', error);
    res.status(500).json({ error: 'Error al verificar desbloqueos' });
  }
};

const getBadges = async (req, res) => {
  try {
    const data = await gamificationService.getBadgesCatalog(req.user.id);
    res.json(data);
  } catch (error) {
    console.error('[GET BADGES ERROR]', error);
    res.status(500).json({ error: 'Error al obtener insignias' });
  }
};

const getCurrentSeason = async (req, res) => {
  try {
    const now = new Date();
    let season = await prisma.season.findFirst({
      where: {
        isActive: true,
        startDate: { lte: now },
        endDate: { gte: now },
      },
      orderBy: { startDate: 'desc' },
    });

    if (!season) {
      season = await prisma.season.findFirst({
        where: { isActive: true },
        orderBy: { startDate: 'desc' },
      });
    }

    res.json({ season: season || null });
  } catch (error) {
    console.error('[GET CURRENT SEASON ERROR]', error);
    res.status(500).json({ error: 'Error al obtener la temporada actual' });
  }
};

const handleSeasonError = (res, error, fallback) => {
  if (error instanceof seasonService.SeasonError) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error('[SEASON ERROR]', error);
  return res.status(500).json({ error: fallback });
};

/** Quién cobraría qué si la temporada se cerrara ahora. No tiene efectos. */
const previewSeasonClose = async (req, res) => {
  try {
    res.json(await seasonService.previewClose(req.params.id));
  } catch (error) {
    handleSeasonError(res, error, 'No pudimos calcular el cierre de la temporada.');
  }
};

const closeSeason = async (req, res) => {
  try {
    const result = await seasonService.closeSeason(req.params.id, req.user.id);
    res.json({
      message: `Temporada ${result.season.name} cerrada. Premiamos a ${result.podium.length} atletas.`,
      ...result,
    });
  } catch (error) {
    handleSeasonError(res, error, 'No pudimos cerrar la temporada.');
  }
};

/**
 * Resultado final de una temporada cerrada. Si todavía está abierta devolvemos
 * la tabla en vivo, así la pantalla sirve en los dos momentos.
 */
const getSeasonResults = async (req, res) => {
  try {
    const season = await prisma.season.findUnique({ where: { id: req.params.id } });
    if (!season) {
      return res.status(404).json({ error: 'No encontramos esa temporada.' });
    }

    const standings = await seasonService.getStandings(season, { limit: 20 });

    res.json({
      season: {
        id: season.id,
        name: season.name,
        startDate: season.startDate,
        endDate: season.endDate,
        isActive: season.isActive,
        closedAt: season.closedAt,
      },
      closed: !!season.closedAt,
      podium: season.podium || null,
      standings,
    });
  } catch (error) {
    handleSeasonError(res, error, 'No pudimos cargar los resultados de la temporada.');
  }
};

const listSeasons = async (req, res) => {
  try {
    const seasons = await prisma.season.findMany({
      orderBy: { startDate: 'desc' },
    });
    res.json(seasons);
  } catch (error) {
    console.error('[LIST SEASONS ERROR]', error);
    res.status(500).json({ error: 'Error al listar temporadas' });
  }
};

const createSeason = async (req, res) => {
  try {
    const { name, startDate, endDate, isActive } = req.body;
    if (!name || !startDate || !endDate) {
      return res.status(400).json({ error: 'name, startDate y endDate son requeridos' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return res.status(400).json({ error: 'Fechas inválidas' });
    }

    if (isActive) {
      await prisma.season.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });
    }

    const season = await prisma.season.create({
      data: {
        name,
        startDate: start,
        endDate: end,
        isActive: !!isActive,
      },
    });

    res.status(201).json(season);
  } catch (error) {
    console.error('[CREATE SEASON ERROR]', error);
    res.status(500).json({ error: 'Error al crear temporada' });
  }
};

const getStreakAtRisk = async (req, res) => {
  try {
    const status = await gamificationService.getStreakAtRiskStatus(req.user.id);
    res.json(status);
  } catch (error) {
    console.error('[GET STREAK AT RISK ERROR]', error);
    res.status(500).json({ error: 'Error al verificar racha en riesgo' });
  }
};

module.exports = {
  getStreak,
  getMissions,
  getTodayMission,
  updateMissionProgress,
  checkUnlockables,
  getBadges,
  getCurrentSeason,
  listSeasons,
  createSeason,
  previewSeasonClose,
  closeSeason,
  getSeasonResults,
  getStreakAtRisk,
};
