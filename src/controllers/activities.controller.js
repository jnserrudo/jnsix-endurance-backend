const { v4: uuidv4 } = require('uuid');
const path = require('path');
const polyline = require('@mapbox/polyline');
const fileParserService = require('../services/fileParser.service');
const storageService = require('../services/storage.service');
const stravaService = require('../services/strava.service');
const syncQueueService = require('../services/syncQueue.service');
const scoringService = require('../services/scoring.service');
const challengesService = require('../services/challenges.service');
const gamificationService = require('../services/gamification.service');
const achievementsController = require('./achievements.controller');
const { detectPersonalRecords } = require('../services/personalRecords.service');
const prisma = require('../lib/prisma');
const { calculateStreakFromDates } = require('../utils/streak');
const { suggestPlanSessionMatch } = require('../services/planSessionMatching.service');
const { checkAndNotifyTrainingLoad } = require('../services/trainingLoad.service');
const referralService = require('../services/referral.service');
const activityOcrService = require('../services/activityOcr.service');
const aiService = require('../services/ai.service');
const fs = require('fs');

async function safePlanSessionSuggestion(userId, activity) {
  try {
    return await suggestPlanSessionMatch(userId, activity);
  } catch (err) {
    console.error('[PlanSession] match suggestion failed:', err.message);
    return null;
  }
}

async function safeReferralReward(userId, activityId) {
  try {
    return await referralService.maybeRewardOnFirstActivity(userId, activityId);
  } catch (err) {
    console.error('[Referrals] Failed to process first activity:', err.message);
    return null;
  }
}

async function collectPostCreateExtras(userId, activity, { personalRecords = false } = {}) {
  const extras = { unlockedAchievements: [] };
  try {
    extras.unlockedAchievements = await achievementsController.checkAchievements(userId);
  } catch (err) {
    console.error('[Achievements] check after activity:', err.message);
  }
  if (personalRecords) {
    try {
      extras.personalRecords = await detectPersonalRecords(userId, activity);
    } catch (err) {
      console.error('[PersonalRecords] detect failed:', err.message);
      extras.personalRecords = [];
    }
  }
  return extras;
}

const buildActivityScoringPayload = async (userId, activity) => {
  const scoreResult = await scoringService.awardActivityPointsIfNotScored(activity.id);
  const completedMissions = await gamificationService.checkMissionsForActivity(userId, activity);
  const missionPoints = completedMissions.reduce((sum, m) => sum + (m.points || 0), 0);
  const activityPoints = scoreResult.points || 0;
  const totalEarned = activityPoints + missionPoints;

  const latestScore = await prisma.userScore.findUnique({
    where: { userId },
    include: { currentRank: true }
  });

  return {
    activityPoints,
    missionPoints,
    pointsAwarded: totalEarned,
    pointsEarned: totalEarned,
    alreadyScored: !!scoreResult.alreadyScored,
    totalPoints: latestScore?.totalPoints ?? 0,
    newTotalPoints: latestScore?.totalPoints ?? null,
    rank: latestScore?.currentRank || null,
    rankChanged: scoreResult.rankChanged || false,
    rankDirection: scoreResult.rankDirection || null,
    completedMissions: (completedMissions || []).map((m) => ({
      title: m.mission?.name || m.mission?.title || m.title || 'Misión',
      points: m.points,
      isCombo: !!m.isCombo,
    }))
  };
};

const safeScoreActivity = async (userId, activity) => {
  try {
    return await buildActivityScoringPayload(userId, activity);
  } catch (err) {
    console.error('[Scoring] Failed for activity', activity?.id, err.message);
    return { pointsAwarded: 0, error: err.message };
  }
};

const ensureValidStravaToken = async (user) => {
  const isExpired = user.stravaTokenExpiry && 
    (new Date(user.stravaTokenExpiry).getTime() - Date.now() < 5 * 60 * 1000);
  
  if (isExpired && user.stravaRefreshToken) {
    console.log(`[DEBUG] Refrescando token de Strava para usuario ${user.id}...`);
    const refreshData = await stravaService.refreshToken(user.stravaRefreshToken);
    
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        stravaAccessToken: refreshData.access_token,
        stravaRefreshToken: refreshData.refresh_token || user.stravaRefreshToken,
        stravaTokenExpiry: new Date(Date.now() + refreshData.expires_in * 1000)
      }
    });
    return updatedUser.stravaAccessToken;
  }
  return user.stravaAccessToken;
};

const getActivities = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, type, sortBy = 'startDate', order = 'desc', q, startDate, endDate } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);
    
    const where = { userId };
    
    if (type) {
      where.type = type;
    }
    
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { description: { contains: q } }
      ];
    }
    
    if (startDate || endDate) {
      where.startDate = {};
      if (startDate) where.startDate.gte = new Date(startDate);
      if (endDate) where.startDate.lte = new Date(endDate);
    }

    const activities = await prisma.activity.findMany({
      where,
      skip,
      take,
      orderBy: { [sortBy]: order },
      include: {
        laps: {
          orderBy: { splitNum: 'asc' }
        },
        _count: {
          select: { comparisons: true, aiAnalyses: true }
        }
      }
    });

    const total = await prisma.activity.count({ where });
    console.log('[SUCCESS] [GET ACTIVITIES] Encontradas:', total, 'actividades');

    res.json({
      activities,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('[ERROR] [GET ACTIVITIES] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getActivityById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    let activity = await prisma.activity.findFirst({
      where: { id, userId },
      include: {
        laps: {
          orderBy: { splitNum: 'asc' }
        },
        photos: {
          orderBy: { order: 'asc' }
        },
        effortLog: true,
        user: {
          select: { 
            id: true, 
            email: true, 
            role: true, 
            stravaAccessToken: true, 
            stravaRefreshToken: true, 
            stravaTokenExpiry: true 
          }
        }
      }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    // Si es una actividad de Strava y no tiene laps en la base de datos, intentar sincronizar detalles on-demand
    if (activity.stravaId && activity.laps.length === 0 && activity.user?.stravaAccessToken) {
      try {
        console.log(`[DEBUG] [GET DETAIL] Sincronizando detalles de Strava para actividad ${id}...`);
        let accessToken = activity.user.stravaAccessToken;
        const user = activity.user;
        
        // Verificar si el token está expirado o expira pronto (menos de 5 minutos)
        const isExpired = user.stravaTokenExpiry && 
          (new Date(user.stravaTokenExpiry).getTime() - Date.now() < 5 * 60 * 1000);
        
        if (isExpired && user.stravaRefreshToken) {
          console.log('[DEBUG] [GET DETAIL] Token de Strava expirado. Refrescando...');
          const refreshData = await stravaService.refreshToken(user.stravaRefreshToken);
          
          const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
              stravaAccessToken: refreshData.access_token,
              stravaRefreshToken: refreshData.refresh_token || user.stravaRefreshToken,
              stravaTokenExpiry: new Date(Date.now() + refreshData.expires_in * 1000)
            }
          });
          accessToken = updatedUser.stravaAccessToken;
        }

        // Obtener la actividad detallada (con laps y splits)
        const detailedActivity = await stravaService.getActivity(activity.stravaId, accessToken);
        
        if (detailedActivity) {
          const lapsToCreate = [];
          
          // 1. Extraer de laps detallados (vueltas/series)
          if (detailedActivity.laps && Array.isArray(detailedActivity.laps)) {
            detailedActivity.laps.forEach((lap, index) => {
              const distKm = (lap.distance || 0) / 1000;
              const pace = (lap.moving_time && distKm > 0) ? ((lap.moving_time / 60) / distKm) : 0;
              lapsToCreate.push({
                activityId: activity.id,
                splitNum: index + 1,
                distance: distKm,
                elevationGain: lap.total_elevation_gain || 0,
                averagePace: pace,
                averageHr: lap.average_heartrate ? Math.round(lap.average_heartrate) : null,
                maxHr: lap.max_heartrate ? Math.round(lap.max_heartrate) : null
              });
            });
          }

          // 2. Si no hay laps detallados pero hay splits de kilómetros, usarlos como fallback
          if (lapsToCreate.length === 0 && detailedActivity.splits_metric && Array.isArray(detailedActivity.splits_metric)) {
            detailedActivity.splits_metric.forEach((split, index) => {
              const distKm = (split.distance || 0) / 1000;
              const pace = (split.moving_time && distKm > 0) ? ((split.moving_time / 60) / distKm) : 0;
              lapsToCreate.push({
                activityId: activity.id,
                splitNum: index + 1,
                distance: distKm,
                elevationGain: split.elevation_difference || 0,
                averagePace: pace,
                averageHr: split.average_heartrate ? Math.round(split.average_heartrate) : null,
                maxHr: split.average_heartrate ? Math.round(split.average_heartrate) : null
              });
            });
          }

          // Guardar laps en DB
          if (lapsToCreate.length > 0) {
            await prisma.activityLap.deleteMany({
              where: { activityId: activity.id }
            });
            await prisma.activityLap.createMany({
              data: lapsToCreate
            });
          }

          // Actualizar actividad con rawData completo y métricas actualizadas
          activity = await prisma.activity.update({
            where: { id: activity.id },
            data: {
              rawData: detailedActivity,
              elevationM: detailedActivity.total_elevation_gain || activity.elevationM,
              movingTime: detailedActivity.moving_time || activity.movingTime,
              distanceKm: detailedActivity.distance ? (detailedActivity.distance / 1000) : activity.distanceKm,
              mapPolyline:
                detailedActivity.map?.summary_polyline ||
                detailedActivity.map?.polyline ||
                activity.mapPolyline ||
                null,
            },
            include: {
              laps: {
                orderBy: { splitNum: 'asc' }
              },
              photos: {
                orderBy: { order: 'asc' }
              },
              effortLog: true,
              user: {
                select: { id: true, email: true, role: true }
              }
            }
          });
          console.log(`[SUCCESS] [GET DETAIL] Actividad ${id} sincronizada con detalles de Strava y ${lapsToCreate.length} laps.`);
        }
      } catch (syncError) {
        console.error(`[ERROR] [GET DETAIL] Error al sincronizar detalles de Strava:`, syncError.message);
      }
    }

    res.json(activity);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


const createActivity = async (req, res) => {
  try {
    const userId = req.user.id;
    const activityData = req.body;

    const activity = await prisma.activity.create({
      data: {
        userId,
        name: activityData.name,
        type: activityData.type,
        distanceKm: parseFloat(activityData.distanceKm),
        elevationM: parseFloat(activityData.elevationM),
        movingTime: parseInt(activityData.movingTime),
        startDate: new Date(activityData.startDate),
        averageHr: activityData.averageHr ? parseInt(activityData.averageHr) : null,
        maxHr: activityData.maxHr ? parseInt(activityData.maxHr) : null,
        calories: activityData.calories ? parseInt(activityData.calories) : null,
        isExternal: activityData.isExternal || false
      },
      include: {
        laps: true
      }
    });

    challengesService.updateChallengeProgress(userId).catch((err) => {
      console.error('[Challenges] Failed to update progress:', err.message);
    });

    const scoring = await safeScoreActivity(userId, activity);
    await safeReferralReward(userId, activity.id);
    const extras = await collectPostCreateExtras(userId, activity);
    extras.matchSuggestion = await safePlanSessionSuggestion(userId, activity);

    res.status(201).json({ ...activity, scoring, ...extras });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const uploadActivity = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const userId = req.user.id;
    const file = req.file;
    const fileExt = path.extname(file.originalname).toLowerCase();

    let parsedData;
    
    if (fileExt === '.fit') {
      parsedData = await fileParserService.parseFitFile(file.buffer);
    } else if (fileExt === '.gpx') {
      parsedData = await fileParserService.parseGpxFile(file.buffer);
    } else if (fileExt === '.tcx') {
      parsedData = await fileParserService.parseTcxFile(file.buffer);
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    const uploadResult = await storageService.uploadFile(file, userId);

    const activity = await prisma.activity.create({
      data: {
        userId,
        name: parsedData.name,
        type: parsedData.type,
        distanceKm: parsedData.distanceKm,
        elevationM: parsedData.elevationM,
        movingTime: parsedData.movingTime,
        startDate: parsedData.startDate,
        averageHr: parsedData.averageHr,
        maxHr: parsedData.maxHr,
        calories: parsedData.calories,
        fileUrl: uploadResult.url,
        fileType: fileExt.replace('.', '').toUpperCase(),
        rawData: parsedData.rawData,
        mapPolyline: parsedData.mapPolyline || null,
        isExternal: true,
        laps: {
          create: parsedData.laps || []
        }
      },
      include: {
        laps: {
          orderBy: { splitNum: 'asc' }
        },
        photos: true
      }
    });

    challengesService.updateChallengeProgress(userId).catch((err) => {
      console.error('[Challenges] Failed to update progress:', err.message);
    });

    const scoring = await safeScoreActivity(userId, activity);
    await safeReferralReward(userId, activity.id);
    const extras = await collectPostCreateExtras(userId, activity);
    res.status(201).json({ ...activity, scoring, ...extras });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const importFromLink = async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.user.id;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const activityId = stravaService.parseStravaActivityUrl(url);
    if (!activityId) {
      return res.status(400).json({ error: 'Invalid Strava URL' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user.stravaAccessToken) {
      return res.status(400).json({ error: 'Strava account not connected' });
    }

    const stravaActivity = await stravaService.getActivity(activityId, user.stravaAccessToken);

    const lapsToCreate = [];
    if (stravaActivity.laps && Array.isArray(stravaActivity.laps)) {
      stravaActivity.laps.forEach((lap, index) => {
        const distKm = (lap.distance || 0) / 1000;
        const pace = (lap.moving_time && distKm > 0) ? ((lap.moving_time / 60) / distKm) : 0;
        lapsToCreate.push({
          splitNum: index + 1,
          distance: distKm,
          elevationGain: lap.total_elevation_gain || 0,
          averagePace: pace,
          averageHr: lap.average_heartrate ? Math.round(lap.average_heartrate) : null,
          maxHr: lap.max_heartrate ? Math.round(lap.max_heartrate) : null
        });
      });
    } else if (stravaActivity.splits_metric && Array.isArray(stravaActivity.splits_metric)) {
      stravaActivity.splits_metric.forEach((split, index) => {
        const distKm = (split.distance || 0) / 1000;
        const pace = (split.moving_time && distKm > 0) ? ((split.moving_time / 60) / distKm) : 0;
        lapsToCreate.push({
          splitNum: index + 1,
          distance: distKm,
          elevationGain: split.elevation_difference || 0,
          averagePace: pace,
          averageHr: split.average_heartrate ? Math.round(split.average_heartrate) : null,
          maxHr: split.average_heartrate ? Math.round(split.average_heartrate) : null
        });
      });
    }

    const activity = await prisma.activity.create({
      data: {
        userId,
        stravaId: stravaActivity.id.toString(),
        name: stravaActivity.name,
        type: stravaActivity.type.toUpperCase(),
        distanceKm: stravaActivity.distance / 1000,
        elevationM: stravaActivity.total_elevation_gain || 0,
        movingTime: stravaActivity.moving_time,
        startDate: new Date(stravaActivity.start_date),
        averageHr: stravaActivity.average_heartrate || null,
        maxHr: stravaActivity.max_heartrate || null,
        calories: stravaActivity.calories || null,
        isExternal: true,
        mapPolyline: stravaActivity.map?.summary_polyline || stravaActivity.map?.polyline || null,
        rawData: stravaActivity,
        laps: {
          create: lapsToCreate
        }
      },
      include: {
        laps: true
      }
    });

    challengesService.updateChallengeProgress(userId).catch((err) => {
      console.error('[Challenges] Failed to update progress:', err.message);
    });

    const scoring = await safeScoreActivity(userId, activity);
    await safeReferralReward(userId, activity.id);
    const extras = await collectPostCreateExtras(userId, activity);
    res.status(201).json({ ...activity, scoring, ...extras });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


const getSharedActivity = async (req, res) => {
  try {
    const { token } = req.params;

    const activity = await prisma.activity.findUnique({
      where: { shareToken: token },
      include: {
        laps: {
          orderBy: { splitNum: 'asc' }
        },
        user: {
          select: { email: true }
        }
      }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Shared activity not found' });
    }

    res.json(activity);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const shareActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const activity = await prisma.activity.findFirst({
      where: { id, userId }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const shareToken = activity.shareToken || uuidv4();

    const updatedActivity = await prisma.activity.update({
      where: { id },
      data: { shareToken },
      select: { id: true, shareToken: true }
    });

    const shareUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/shared/${shareToken}`;

    res.json({
      shareToken: updatedActivity.shareToken,
      shareUrl
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const updates = req.body;

    const activity = await prisma.activity.findFirst({
      where: { id, userId }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const data = {};
    if (updates.name != null) data.name = updates.name;
    if (updates.type != null) data.type = updates.type;
    if (updates.distanceKm != null) data.distanceKm = parseFloat(updates.distanceKm) || 0;
    if (updates.elevationM != null) data.elevationM = parseFloat(updates.elevationM) || 0;
    if (updates.movingTime != null) data.movingTime = parseInt(updates.movingTime, 10) || 0;
    if (updates.startDate != null) data.startDate = new Date(updates.startDate);
    if (updates.description !== undefined) data.description = updates.description || null;
    if (updates.averageHr !== undefined) data.averageHr = updates.averageHr != null ? parseInt(updates.averageHr, 10) : null;
    if (updates.maxHr !== undefined) data.maxHr = updates.maxHr != null ? parseInt(updates.maxHr, 10) : null;
    if (updates.calories !== undefined) data.calories = updates.calories != null ? parseInt(updates.calories, 10) : null;
    if (updates.visibility != null) data.visibility = updates.visibility;
    if (updates.mapPolyline !== undefined) data.mapPolyline = updates.mapPolyline || null;
    if (updates.privateNotes !== undefined) data.privateNotes = updates.privateNotes || null;

    if (updates.extraFields != null || updates.feeling != null) {
      const prev = (activity.rawData && typeof activity.rawData === 'object') ? activity.rawData : {};
      data.rawData = {
        ...prev,
        ...(updates.extraFields != null ? { extraFields: updates.extraFields } : {}),
        ...(updates.feeling != null ? { feeling: updates.feeling } : {}),
      };
    }

    const updatedActivity = await prisma.activity.update({
      where: { id },
      data,
      include: {
        laps: { orderBy: { splitNum: 'asc' } },
        photos: { orderBy: { order: 'asc' } },
        effortLog: true,
      }
    });

    if (updates.rpe != null) {
      await prisma.effortLog.upsert({
        where: { activityId: id },
        update: { rpe: parseInt(updates.rpe, 10) || 5, notes: updates.notes || null },
        create: {
          userId,
          activityId: id,
          rpe: parseInt(updates.rpe, 10) || 5,
          notes: updates.notes || null,
        },
      });
    }

    res.json(updatedActivity);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const deleteActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const activity = await prisma.activity.findFirst({
      where: { id, userId }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    if (activity.fileUrl) {
      try {
        const filePath = activity.fileUrl.split('/').slice(-2).join('/');
        await storageService.deleteFile(filePath);
      } catch (err) {
        console.error('Failed to delete file from storage:', err);
      }
    }

    await prisma.activity.delete({
      where: { id }
    });

    res.json({ message: 'Activity deleted successfully' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Función auxiliar para mapear tipos de Strava a ActivityType enum
const mapStravaTypeToActivityType = (stravaType) => {
  const typeMap = {
    'Run': 'RUN',
    'Ride': 'RIDE',
    'Swim': 'SWIM',
    'TrailRun': 'TRAIL_RUN',
    'VirtualRun': 'VIRTUAL_RUN',
    'VirtualRide': 'VIRTUAL_RIDE',
    'Hike': 'HIKE',
    'Walk': 'WALK',
    'WeightTraining': 'OTHER',
    'Workout': 'OTHER',
    'Yoga': 'OTHER',
    'Crossfit': 'OTHER',
  };
  return typeMap[stravaType] || 'OTHER';
};

const syncStravaActivities = async (req, res) => {
  try {
    console.log('[DEBUG] [SYNC STRAVA] Iniciando sincronización...');
    const userId = req.user.id;

    // Obtener el usuario con sus tokens de Strava y lastSyncDate
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user.stravaAccessToken) {
      console.log('[ERROR] [SYNC STRAVA] Usuario no conectado a Strava');
      return res.status(400).json({ error: 'No estás conectado a Strava' });
    }

    // Determinar si es sincronización incremental o completa
    const isIncremental = !!user.lastSyncDate;
    const afterDate = user.lastSyncDate ? new Date(user.lastSyncDate) : null;
    
    if (isIncremental) {
      console.log(`[DEBUG] [SYNC STRAVA] Sincronización incremental desde: ${afterDate.toISOString()}`);
    } else {
      console.log('[DEBUG] [SYNC STRAVA] Sincronización completa (todas las actividades)');
    }
    
    let allActivities = [];
    let page = 1;
    let hasMore = true;
    const perPage = 200; // Máximo permitido por Strava

    // Obtener actividades paginadas
    while (hasMore) {
      console.log(`[DEBUG] [SYNC STRAVA] Obteniendo página ${page}...`);
      
      const pageActivities = await stravaService.getActivities(
        user.stravaAccessToken,
        page,
        perPage,
        afterDate // Pasar fecha para sincronización incremental
      );

      if (pageActivities.length === 0) {
        hasMore = false;
      } else {
        allActivities = allActivities.concat(pageActivities);
        console.log(`[SUCCESS] [SYNC STRAVA] Página ${page}: ${pageActivities.length} actividades`);
        page++;
        
        // Si obtuvimos menos de perPage, es la última página
        if (pageActivities.length < perPage) {
          hasMore = false;
        }
        
        // Si es incremental y no hay más actividades después de la fecha, detener
        if (isIncremental && pageActivities.length < perPage) {
          hasMore = false;
        }
      }
    }

    console.log(`[DEBUG] [SYNC STRAVA] Total de actividades obtenidas: ${allActivities.length}`);

    // Obtener todos los stravaIds existentes en una sola query
    console.log('[DEBUG] [SYNC STRAVA] Verificando actividades existentes...');
    const existingActivities = await prisma.activity.findMany({
      where: { userId },
      select: { stravaId: true }
    });
    const existingStravaIds = new Set(existingActivities.map(a => a.stravaId));
    console.log(`[SUCCESS] [SYNC STRAVA] ${existingStravaIds.size} actividades ya existen`);

    // Filtrar solo actividades nuevas
    const newActivities = allActivities.filter(
      activity => !existingStravaIds.has(activity.id.toString())
    );
    console.log(`[DEBUG] [SYNC STRAVA] ${newActivities.length} actividades nuevas para importar`);

    if (newActivities.length === 0) {
      console.log('[SUCCESS] [SYNC STRAVA] No hay actividades nuevas');
      return res.json({
        message: 'No hay actividades nuevas',
        created: 0,
        skipped: allActivities.length,
        errors: 0,
        total: allActivities.length
      });
    }

    // Procesar en batches de 50 para optimizar
    const batchSize = 50;
    const batches = [];
    for (let i = 0; i < newActivities.length; i += batchSize) {
      batches.push(newActivities.slice(i, i + batchSize));
    }
    console.log(`[DEBUG] [SYNC STRAVA] Procesando ${batches.length} batches de ${batchSize} actividades...`);

    let created = 0;
    let skipped = existingStravaIds.size;
    let errors = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      
      try {
        // Preparar datos para batch insert
        const activitiesToCreate = batch.map(stravaActivity => ({
          userId,
          stravaId: stravaActivity.id.toString(),
          name: stravaActivity.name || 'Actividad sin nombre',
          type: mapStravaTypeToActivityType(stravaActivity.type),
          startDate: new Date(stravaActivity.start_date),
          distanceKm: (stravaActivity.distance || 0) / 1000,
          elevationM: stravaActivity.total_elevation_gain || 0,
          movingTime: stravaActivity.moving_time || 0,
          averageHr: stravaActivity.average_heartrate ? Math.round(stravaActivity.average_heartrate) : null,
          maxHr: stravaActivity.max_heartrate ? Math.round(stravaActivity.max_heartrate) : null,
          calories: stravaActivity.calories || null,
          isExternal: true,
          mapPolyline: stravaActivity.map?.summary_polyline || stravaActivity.map?.polyline || null,
          rawData: stravaActivity
        }));

        // Batch insert
        await prisma.activity.createMany({
          data: activitiesToCreate,
          skipDuplicates: true
        });

        created += batch.length;
        console.log(`[SUCCESS] [SYNC STRAVA] Batch ${batchIndex + 1}/${batches.length}: ${batch.length} actividades creadas (Total: ${created})`);
      } catch (err) {
        console.error(`[ERROR] [SYNC STRAVA] Error en batch ${batchIndex + 1}:`, err.message);
        errors += batch.length;
      }
    }

    console.log('[SUCCESS] [SYNC STRAVA] Sincronización completada');
    console.log(`[SUCCESS] [SYNC STRAVA] Creadas: ${created} | Omitidas: ${skipped} | Errores: ${errors}`);

    // Actualizar lastSyncDate del usuario
    if (created > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { lastSyncDate: new Date() }
      });
      console.log('[SUCCESS] [SYNC STRAVA] lastSyncDate actualizado');

      scoringService.batchScoreActivities(userId).catch((err) => {
        console.error('[Scoring] Failed to batch score synced activities:', err.message);
      });
      const firstActivity = await prisma.activity.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (firstActivity) await safeReferralReward(userId, firstActivity.id);

      challengesService.updateChallengeProgress(userId).catch((err) => {
        console.error('[Challenges] Failed to update progress after sync:', err.message);
      });
    }

    res.json({
      message: 'Sincronización completada',
      created,
      skipped,
      errors,
      total: allActivities.length,
      isIncremental
    });
  } catch (error) {
    console.error('[ERROR] [SYNC STRAVA] Error:', error.message);
    console.error('[ERROR] [SYNC STRAVA] Stack:', error.stack);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const checkNewActivities = async (req, res) => {
  try {
    console.log('[DEBUG] [CHECK NEW] Verificando nuevas actividades...');
    const userId = req.user.id;

    // Obtener el usuario con sus tokens de Strava y lastSyncDate
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || !user.stravaAccessToken) {
      console.log('[ERROR] [CHECK NEW] Usuario no conectado a Strava');
      return res.json({ hasNew: false, count: 0, message: 'No conectado a Strava' });
    }

    const validToken = await ensureValidStravaToken(user);

    if (!user.lastSyncDate) {
      console.log('[DEBUG] [CHECK NEW] Primera sincronización - todas las actividades son nuevas');
      // Obtener solo la primera página para estimar
      const pageActivities = await stravaService.getActivities(
        validToken,
        1,
        1
      );
      
      return res.json({
        hasNew: true,
        count: pageActivities.length > 0 ? 'Todas' : 0,
        lastActivity: pageActivities[0] || null,
        message: 'Primera sincronización - todas las actividades son nuevas'
      });
    }

    // Obtener actividades después de lastSyncDate (solo primera página para verificar)
    const afterDate = new Date(user.lastSyncDate);
    console.log(`[DEBUG] [CHECK NEW] Verificando actividades después de: ${afterDate.toISOString()}`);
    
    const newActivities = await stravaService.getActivities(
      validToken,
      1,
      30, // Solo verificar primeras 30
      afterDate
    );

    console.log(`[SUCCESS] [CHECK NEW] Encontradas: ${newActivities.length} actividades nuevas`);

    res.json({
      hasNew: newActivities.length > 0,
      count: newActivities.length,
      lastActivity: newActivities[0] || null,
      lastSyncDate: user.lastSyncDate
    });
  } catch (error) {
    console.error('[ERROR] [CHECK NEW] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


// Crear job de sincronización en background
const createSyncJob = async (req, res) => {
  try {
    const userId = req.user.id;
    const { after } = req.query;
    
    // Obtener el usuario con su token de Strava
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user || !user.stravaAccessToken) {
      return res.status(400).json({ error: 'Usuario no conectado a Strava' });
    }
    
    const validToken = await ensureValidStravaToken(user);
    const afterDate = after ? new Date(after) : user.lastSyncDate;
    
    const jobId = await syncQueueService.createJob(userId, validToken, afterDate);
    
    res.json({ jobId, status: 'PENDING' });
  } catch (error) {
    console.error('[ERROR] [CREATE SYNC JOB] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Obtener estado de un job de sincronización
const getSyncJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await syncQueueService.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job no encontrado' });
    }
    
    res.json(job);
  } catch (error) {
    console.error('[ERROR] [GET SYNC JOB] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const getDashboardMetrics = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const yearStart = new Date(now.getFullYear(), 0, 1);

    // Esta semana
    const thisWeekActivities = await prisma.activity.findMany({
      where: {
        userId,
        startDate: { gte: weekAgo }
      },
      select: {
        distanceKm: true,
        movingTime: true
      }
    });

    const thisWeekDistance = thisWeekActivities.reduce((sum, a) => sum + (a.distanceKm || 0), 0);
    const thisWeekTime = thisWeekActivities.reduce((sum, a) => sum + (a.movingTime || 0), 0);

    // Este mes
    const thisMonthActivities = await prisma.activity.findMany({
      where: {
        userId,
        startDate: { gte: monthAgo }
      },
      select: {
        distanceKm: true,
        movingTime: true
      }
    });

    const thisMonthDistance = thisMonthActivities.reduce((sum, a) => sum + (a.distanceKm || 0), 0);
    const thisMonthTime = thisMonthActivities.reduce((sum, a) => sum + (a.movingTime || 0), 0);

    // Este año
    const thisYearActivities = await prisma.activity.findMany({
      where: {
        userId,
        startDate: { gte: yearStart }
      },
      select: {
        distanceKm: true,
        movingTime: true
      }
    });

    const thisYearDistance = thisYearActivities.reduce((sum, a) => sum + (a.distanceKm || 0), 0);
    const thisYearTime = thisYearActivities.reduce((sum, a) => sum + (a.movingTime || 0), 0);

    // Récord distancia
    const longestActivity = await prisma.activity.findFirst({
      where: { userId },
      orderBy: { distanceKm: 'desc' },
      select: {
        distanceKm: true,
        name: true
      }
    });

    // Racha - misma lógica que gamification Streak
    const allActivities = await prisma.activity.findMany({
      where: { userId },
      select: {
        startDate: true
      },
      orderBy: { startDate: 'desc' }
    });

    const streak = calculateStreakFromDates(allActivities.map((a) => a.startDate));

    // Persist aligned streak so profile /gamification/streak matches dashboard
    try {
      await gamificationService.updateStreak(userId);
    } catch (streakErr) {
      console.warn('[Dashboard] streak sync skipped:', streakErr.message);
    }

    // Score y Rank
    const userScore = await prisma.userScore.findUnique({
      where: { userId },
      include: {
        currentRank: true
      }
    });

    // B9: aviso de carga elevada (ACWR-like), throttled
    checkAndNotifyTrainingLoad(userId).catch((err) => {
      console.warn('[Dashboard] training load check skipped:', err.message);
    });

    res.json({
      thisWeek: {
        distance: thisWeekDistance,
        time: thisWeekTime,
        count: thisWeekActivities.length
      },
      thisMonth: {
        distance: thisMonthDistance,
        time: thisMonthTime,
        count: thisMonthActivities.length
      },
      thisYear: {
        distance: thisYearDistance,
        time: thisYearTime,
        count: thisYearActivities.length
      },
      record: {
        distance: longestActivity?.distanceKm || 0,
        name: longestActivity?.name || 'N/A'
      },
      streak,
      score: userScore ? {
        points: userScore.totalPoints,
        rankName: userScore.currentRank?.name || 'Novato',
        iconUrl: userScore.currentRank?.iconUrl || null
      } : { points: 0, rankName: 'Novato', iconUrl: null }
    });
  } catch (error) {
    console.error('[ERROR] [GET DASHBOARD METRICS] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const syncHealthWorkouts = async (req, res) => {
  try {
    const { workouts } = req.body;
    const userId = req.user.id;

    if (!Array.isArray(workouts)) {
      return res.status(400).json({ error: 'El cuerpo de la solicitud debe contener un arreglo de entrenamientos.' });
    }

    let count = 0;

    for (const w of workouts) {
      const externalId = w.externalId || w.stravaId || null;
      const startDate = new Date(w.startDate);
      const distanceKm = parseFloat(w.distanceKm) || 0;
      const type = w.type;

      if (Number.isNaN(startDate.getTime())) {
        continue;
      }

      let existing = null;

      // 1) Duplicado por ID externo / stravaId
      if (externalId) {
        existing = await prisma.activity.findFirst({
          where: { userId, stravaId: String(externalId) },
        });
      }

      // 2) Duplicado fuzzy: startDate ±2 min + type + distanceKm ±0.1 km
      if (!existing) {
        const windowStart = new Date(startDate.getTime() - 2 * 60 * 1000);
        const windowEnd = new Date(startDate.getTime() + 2 * 60 * 1000);
        const candidates = await prisma.activity.findMany({
          where: {
            userId,
            type,
            startDate: { gte: windowStart, lte: windowEnd },
          },
          select: {
            id: true,
            distanceKm: true,
            startDate: true,
            type: true,
            stravaId: true,
          },
        });
        existing =
          candidates.find((a) => Math.abs((a.distanceKm || 0) - distanceKm) <= 0.1) || null;
      }

      if (existing) {
        continue;
      }

      const activity = await prisma.activity.create({
        data: {
          user: { connect: { id: userId } },
          name: w.name,
          type: w.type,
          distanceKm,
          elevationM: parseFloat(w.elevationM) || 0,
          movingTime: parseInt(w.movingTime) || 0,
          startDate,
          averageHr: w.averageHr ? parseInt(w.averageHr) : null,
          maxHr: w.maxHr ? parseInt(w.maxHr) : null,
          calories: w.calories ? parseInt(w.calories) : null,
          isExternal: true,
          stravaId: externalId ? String(externalId) : null,
        }
      });
      await safeReferralReward(userId, activity.id);

      count++;
    }

    if (count > 0) {
      scoringService.batchScoreActivities(userId).catch((err) => {
        console.error('[Scoring] Failed to score health workouts:', err.message);
      });

      challengesService.updateChallengeProgress(userId).catch((err) => {
        console.error('[Challenges] Failed to update progress after health sync:', err.message);
      });
    }

    res.json({ success: true, count });
  } catch (error) {
    console.error('[ERROR] [SYNC HEALTH WORKOUTS] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Error al sincronizar entrenamientos de salud' });
  }
};

function calculateStreak(activities) {
  return calculateStreakFromDates((activities || []).map((a) => a.startDate));
}

function paceMinPerKm(activity) {
  const dist = Number(activity.distanceKm) || 0;
  const secs = Number(activity.movingTime) || 0;
  if (dist <= 0 || secs <= 0) return null;
  return (secs / 60) / dist;
}

function formatPace(pace) {
  if (pace == null || !Number.isFinite(pace) || pace <= 0) return null;
  const mins = Math.floor(pace);
  const secs = Math.round((pace - mins) * 60);
  const adjMins = secs === 60 ? mins + 1 : mins;
  const adjSecs = secs === 60 ? 0 : secs;
  return `${adjMins}:${String(adjSecs).padStart(2, '0')}`;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractStartLatLng(activity) {
  try {
    if (activity.mapPolyline) {
      const decoded = polyline.decode(activity.mapPolyline);
      if (decoded?.length) {
        return { lat: decoded[0][0], lng: decoded[0][1] };
      }
    }
    const coords = activity.rawData?.coordinates;
    if (Array.isArray(coords) && coords.length > 0) {
      const first = coords[0];
      if (Array.isArray(first) && first.length >= 2) {
        return { lat: Number(first[0]), lng: Number(first[1]) };
      }
      if (first && typeof first === 'object') {
        const lat = Number(first.lat ?? first.latitude);
        const lng = Number(first.lng ?? first.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
      }
    }
    const start = activity.rawData?.start_latlng || activity.rawData?.startLatlng;
    if (Array.isArray(start) && start.length >= 2) {
      return { lat: Number(start[0]), lng: Number(start[1]) };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Ghost runner: actividad similar ~30 días atrás, mismo tipo.
 */
const getGhostComparison = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const current = await prisma.activity.findFirst({
      where: { id, userId },
    });
    if (!current) {
      return res.status(404).json({ error: 'Actividad no encontrada' });
    }

    const targetDate = new Date(current.startDate);
    targetDate.setDate(targetDate.getDate() - 30);
    const windowStart = new Date(targetDate);
    windowStart.setDate(windowStart.getDate() - 10);
    const windowEnd = new Date(targetDate);
    windowEnd.setDate(windowEnd.getDate() + 10);

    const candidates = await prisma.activity.findMany({
      where: {
        userId,
        type: current.type,
        id: { not: current.id },
        startDate: { gte: windowStart, lte: windowEnd },
        distanceKm: { gt: 0 },
        movingTime: { gt: 0 },
      },
      orderBy: { startDate: 'desc' },
      take: 40,
    });

    if (candidates.length === 0) {
      return res.json({
        found: false,
        message: 'No hay una actividad similar de hace ~30 días para comparar.',
        current: null,
        ghost: null,
      });
    }

    const currentDist = Number(current.distanceKm) || 0;
    const scored = candidates.map((c) => {
      const dist = Number(c.distanceKm) || 0;
      const distDiff = Math.abs(dist - currentDist);
      const daysDiff = Math.abs(
        (new Date(c.startDate).getTime() - targetDate.getTime()) / 86400000
      );
      const distScore = currentDist > 0 ? distDiff / currentDist : distDiff;
      const score = distScore * 2 + daysDiff * 0.05;
      return { activity: c, score, distDiff, daysDiff };
    });
    scored.sort((a, b) => a.score - b.score);
    const ghost = scored[0].activity;

    const currentPace = paceMinPerKm(current);
    const ghostPace = paceMinPerKm(ghost);
    const paceDelta =
      currentPace != null && ghostPace != null ? currentPace - ghostPace : null;
    // Negativo = más rápido ahora (mejor)
    const faster = paceDelta != null ? paceDelta < 0 : null;
    const deltaSecondsPerKm =
      paceDelta != null ? Math.round(Math.abs(paceDelta) * 60) : null;

    let message = 'Comparación con tu yo de hace ~30 días.';
    if (faster === true) {
      message = `¡Más rápido que hace ~30 días! Mejoraste ${deltaSecondsPerKm}s/km.`;
    } else if (faster === false) {
      message = `Tu ghost fue ${deltaSecondsPerKm}s/km más rápido. A por la revancha.`;
    }

    res.json({
      found: true,
      message,
      current: {
        id: current.id,
        name: current.name,
        type: current.type,
        distanceKm: current.distanceKm,
        movingTime: current.movingTime,
        startDate: current.startDate,
        paceMinPerKm: currentPace,
        paceFormatted: formatPace(currentPace),
      },
      ghost: {
        id: ghost.id,
        name: ghost.name,
        type: ghost.type,
        distanceKm: ghost.distanceKm,
        movingTime: ghost.movingTime,
        startDate: ghost.startDate,
        paceMinPerKm: ghostPace,
        paceFormatted: formatPace(ghostPace),
        daysAgo: Math.round(
          (new Date(current.startDate) - new Date(ghost.startDate)) / 86400000
        ),
      },
      delta: {
        paceMinPerKm: paceDelta,
        secondsPerKm: paceDelta != null ? Math.round(paceDelta * 60) : null,
        faster,
        distanceKm: (Number(current.distanceKm) || 0) - (Number(ghost.distanceKm) || 0),
      },
    });
  } catch (error) {
    console.error('[ERROR] getGhostComparison:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * Atletas cercanos o amigos que entrenaron hoy.
 */
const getNearbyAthletes = async (req, res) => {
  try {
    const userId = req.user.id;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusKm = Math.min(50, Math.max(1, parseFloat(req.query.radiusKm) || 15));

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ userId }, { friendId: userId }],
      },
      select: { userId: true, friendId: true },
    });
    const friendIds = friendships.map((f) => (f.userId === userId ? f.friendId : f.userId));

    const friendsToday = friendIds.length
      ? await prisma.activity.findMany({
          where: {
            userId: { in: friendIds },
            startDate: { gte: startOfDay },
            visibility: { in: ['PUBLIC', 'FRIENDS'] },
          },
          select: {
            id: true,
            userId: true,
            name: true,
            type: true,
            distanceKm: true,
            startDate: true,
            mapPolyline: true,
            rawData: true,
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                avatarUrl: true,
              },
            },
          },
          orderBy: { startDate: 'desc' },
          take: 40,
        })
      : [];

    const displayName = (u) =>
      u?.username ||
      [u?.firstName, u?.lastName].filter(Boolean).join(' ') ||
      'Atleta';

    const friendsList = [];
    const seenFriends = new Set();
    for (const a of friendsToday) {
      const fid = a.user?.id || a.userId;
      if (!fid || seenFriends.has(fid)) continue;
      seenFriends.add(fid);
      friendsList.push({
        userId: fid,
        name: displayName(a.user),
        username: a.user?.username || null,
        avatarUrl: a.user?.avatarUrl || null,
        activityId: a.id,
        activityName: a.name,
        type: a.type,
        distanceKm: a.distanceKm,
        source: 'friend',
      });
    }

    let nearbyList = [];
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const publicToday = await prisma.activity.findMany({
        where: {
          startDate: { gte: startOfDay },
          userId: { not: userId },
          visibility: 'PUBLIC',
          mapPolyline: { not: null },
        },
        select: {
          id: true,
          name: true,
          type: true,
          distanceKm: true,
          startDate: true,
          mapPolyline: true,
          rawData: true,
          userId: true,
          user: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
        orderBy: { startDate: 'desc' },
        take: 120,
      });

      const seenNearby = new Set(seenFriends);
      for (const a of publicToday) {
        const uid = a.user?.id || a.userId;
        if (!uid || seenNearby.has(uid)) continue;
        const start = extractStartLatLng(a);
        if (!start) continue;
        const dist = haversineKm(lat, lng, start.lat, start.lng);
        if (dist > radiusKm) continue;
        seenNearby.add(uid);
        nearbyList.push({
          userId: uid,
          name: displayName(a.user),
          username: a.user?.username || null,
          avatarUrl: a.user?.avatarUrl || null,
          activityId: a.id,
          activityName: a.name,
          type: a.type,
          distanceKm: a.distanceKm,
          distanceFromYouKm: Math.round(dist * 10) / 10,
          source: 'nearby',
        });
      }
      nearbyList.sort(
        (a, b) => (a.distanceFromYouKm || 99) - (b.distanceFromYouKm || 99)
      );
      nearbyList = nearbyList.slice(0, 10);
    }

    const athletes = [...friendsList, ...nearbyList].slice(0, 15);
    const names = athletes.map((a) => a.name);

    res.json({
      athletes,
      names,
      friendsCount: friendsList.length,
      nearbyCount: nearbyList.length,
      message:
        names.length > 0
          ? `Hoy también entrenaron: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}`
          : 'Nadie de tu círculo entrenó cerca hoy. ¡Sos pionero!',
    });
  } catch (error) {
    console.error('[ERROR] getNearbyAthletes:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const createManualActivity = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      name, type, distanceKm, elevationM, movingTime, elapsedTime,
      startDate, description, averageHr, maxHr, calories, cadence,
      coordinates, mapPolyline, visibility, laps, extraFields,
      rpe, feeling, notes, ocrAttemptId
    } = req.body;

    if (!name || !type || !startDate) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    let encodedPolyline = null;
    try {
      if (Array.isArray(coordinates) && coordinates.length > 0) {
        // Asegurar que sean pares [lat, lng] numéricos
        const validCoords = coordinates.filter(c => Array.isArray(c) && c.length >= 2 && !isNaN(c[0]) && !isNaN(c[1]));
        if (validCoords.length > 0) {
          encodedPolyline = polyline.encode(validCoords);
        }
      } else if (typeof mapPolyline === 'string' && mapPolyline.trim()) {
        encodedPolyline = mapPolyline;
      }
    } catch (err) {
      console.warn('[CREATE ACTIVITY] Warning: Error al parsear coordinates/mapPolyline', err.message);
    }

    const dist = parseFloat(distanceKm) || 0;
    const moveSecs = parseInt(movingTime, 10) || 0;
    const elev = parseFloat(elevationM) || 0;
    let lapsToCreate = Array.isArray(laps) && laps.length > 0
      ? laps.map((lap, index) => ({
          splitNum: lap.splitNum || index + 1,
          distance: parseFloat(lap.distance) || 0,
          elevationGain: parseFloat(lap.elevationGain) || 0,
          averagePace: parseFloat(lap.averagePace) || 0,
          averageHr: lap.averageHr ? parseInt(lap.averageHr, 10) : null,
          maxHr: lap.maxHr ? parseInt(lap.maxHr, 10) : null,
        }))
      : [];

    // Generar laps por km si hay GPS/distancia y no vinieron laps
    if (lapsToCreate.length === 0 && dist >= 1 && moveSecs > 0) {
      const paceMinPerKm = (moveSecs / 60) / dist;
      const elevPerKm = elev / dist;
      const fullKm = Math.floor(dist);
      for (let i = 1; i <= fullKm; i++) {
        lapsToCreate.push({
          splitNum: i,
          distance: 1,
          elevationGain: elevPerKm,
          averagePace: paceMinPerKm,
          averageHr: averageHr ? parseInt(averageHr, 10) : null,
          maxHr: null,
        });
      }
      const rem = dist - fullKm;
      if (rem > 0.05) {
        lapsToCreate.push({
          splitNum: fullKm + 1,
          distance: rem,
          elevationGain: elevPerKm * rem,
          averagePace: paceMinPerKm,
          averageHr: averageHr ? parseInt(averageHr, 10) : null,
          maxHr: null,
        });
      }
    }

    const activity = await prisma.activity.create({
      data: {
        user: { connect: { id: userId } },
        name,
        type,
        distanceKm: dist,
        elevationM: elev,
        movingTime: moveSecs,
        startDate: new Date(startDate),
        description: description || null,
        averageHr: averageHr ? parseInt(averageHr) : null,
        maxHr: maxHr ? parseInt(maxHr) : null,
        calories: calories ? parseInt(calories) : null,
        mapPolyline: encodedPolyline,
        visibility: visibility || 'PUBLIC',
        rawData: {
          coordinates: Array.isArray(coordinates) ? coordinates : [],
          extraFields: extraFields || null,
          elapsedTime: parseInt(elapsedTime) || parseInt(movingTime) || 0,
          cadence: cadence ? parseInt(cadence) : null
        },
        isExternal: false,
        laps: {
          create: lapsToCreate
        }
      },
      include: {
        laps: true
      }
    });

    const scoring = await safeScoreActivity(userId, activity);
    await safeReferralReward(userId, activity.id);

    if (ocrAttemptId) {
      await activityOcrService.markAttemptAccepted(ocrAttemptId, userId, activity.id).catch((err) => {
        console.warn('[CREATE MANUAL] OCR attempt mark failed:', err.message);
      });
    }

    if (rpe) {
      await prisma.effortLog.create({
        data: {
          userId,
          activityId: activity.id,
          rpe: parseInt(rpe) || 5,
          notes: notes || null
        }
      });
      checkAndNotifyTrainingLoad(userId).catch((err) => {
        console.warn('[CREATE MANUAL] training load check skipped:', err.message);
      });
    }

    const extras = await collectPostCreateExtras(userId, activity, { personalRecords: true });
    extras.matchSuggestion = await safePlanSessionSuggestion(userId, activity);
    res.status(201).json({ ...activity, scoring, ...extras });
  } catch (error) {
    console.error('[ERROR] [CREATE MANUAL ACTIVITY] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const uploadActivityPhotos = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const activity = await prisma.activity.findFirst({
      where: { id, userId }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Actividad no encontrada' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No se subieron fotos' });
    }

    const lastPhoto = await prisma.activityPhoto.findFirst({
      where: { activityId: id },
      orderBy: { order: 'desc' }
    });
    
    let currentOrder = lastPhoto ? lastPhoto.order + 1 : 0;
    
    const photosToCreate = req.files.map(file => {
      const url = `/uploads/${file.filename}`;
      return {
        activityId: id,
        url,
        order: currentOrder++
      };
    });

    await prisma.activityPhoto.createMany({
      data: photosToCreate
    });

    const newPhotos = await prisma.activityPhoto.findMany({
      where: { activityId: id }
    });

    res.status(201).json({ message: 'Fotos subidas exitosamente', photos: newPhotos });
  } catch (error) {
    console.error('[ERROR] [UPLOAD ACTIVITY PHOTOS] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const deleteActivityPhoto = async (req, res) => {
  try {
    const { id, photoId } = req.params;
    const userId = req.user.id;

    const activity = await prisma.activity.findFirst({ where: { id, userId } });
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const photo = await prisma.activityPhoto.findFirst({
      where: { id: photoId, activityId: id },
    });
    if (!photo) return res.status(404).json({ error: 'Foto no encontrada' });

    await prisma.activityPhoto.delete({ where: { id: photoId } });
    res.json({ message: 'Foto eliminada' });
  } catch (error) {
    console.error('[ERROR] deleteActivityPhoto:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const parseActivityOcr = async (req, res) => {
  try {
    const userId = req.user.id;
    const sourceHint = typeof req.body?.sourceHint === 'string' ? req.body.sourceHint.toLowerCase() : undefined;

    if (!req.file) {
      return res.status(400).json({
        error: 'Subí una captura de pantalla (jpeg, png o webp).',
        code: 'OCR_IMAGE_REQUIRED',
      });
    }

    if (!aiService.isVisionAvailable()) {
      return res.status(503).json({
        error:
          'OCR no configurado. Usá el mismo Groq del Coach: GROQ_API_KEY + GROQ_VISION_MODEL (modelo multimodal, no el de solo texto).',
        code: 'VISION_UNAVAILABLE',
        vision: aiService.getVisionStatus(),
      });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    const absolutePath = req.file.path;
    const mimeType = req.file.mimetype || 'image/jpeg';
    const imageBuffer = fs.readFileSync(absolutePath);

    const result = await activityOcrService.parseActivityScreenshot({
      userId,
      imageBuffer,
      mimeType,
      sourceHint,
      imageUrl,
    });

    const duplicates = await activityOcrService.findLikelyDuplicates(userId, {
      type: result.draft.type,
      distanceKm: result.draft.distanceKm,
      startDate: result.draft.startDate,
    });

    return res.json({
      ...result,
      possibleDuplicates: duplicates,
    });
  } catch (error) {
    console.error('[ERROR] parseActivityOcr:', error.message);
    if (error.code === 'OCR_DAILY_LIMIT') {
      return res.status(429).json({
        error: error.message,
        code: error.code,
        used: error.used,
        limit: error.limit,
      });
    }
    if (error.code === 'VISION_UNAVAILABLE') {
      return res.status(503).json({ error: error.message, code: error.code });
    }
    if (error.code === 'OCR_PROVIDER_BUSY') {
      return res.status(503).json({ error: error.message, code: error.code });
    }
    if (error.code === 'OCR_PARSE_FAILED' || error.code === 'OCR_INVALID_JSON') {
      return res.status(422).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: 'No pudimos analizar la captura. Intentá de nuevo.' });
  }
};

const checkActivityDuplicates = async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, distanceKm, startDate } = req.body || {};
    if (!type || distanceKm == null || !startDate) {
      return res.status(400).json({
        error: 'Indicá tipo, distancia y fecha para buscar duplicados.',
      });
    }
    const duplicates = await activityOcrService.findLikelyDuplicates(userId, {
      type,
      distanceKm,
      startDate,
    });
    res.json({
      duplicates,
      notice:
        duplicates.length > 0
          ? 'Puede ser un duplicado de una actividad que ya cargaste ese día (±2% distancia).'
          : null,
    });
  } catch (error) {
    console.error('[ERROR] checkActivityDuplicates:', error.message);
    res.status(500).json({ error: 'No pudimos verificar duplicados.' });
  }
};

module.exports = {
  getActivities,
  getActivityById,
  getGhostComparison,
  getNearbyAthletes,
  createActivity,
  createManualActivity,
  uploadActivity,
  uploadActivityPhotos,
  deleteActivityPhoto,
  importFromLink,
  getSharedActivity,
  shareActivity,
  syncStravaActivities,
  syncHealthWorkouts,
  checkNewActivities,

  createSyncJob,
  getSyncJobStatus,
  updateActivity,
  deleteActivity,
  getDashboardMetrics,
  parseActivityOcr,
  checkActivityDuplicates,
};
