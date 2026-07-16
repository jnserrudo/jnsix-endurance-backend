const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fileParserService = require('../services/fileParser.service');
const storageService = require('../services/storage.service');
const stravaService = require('../services/strava.service');
const syncQueueService = require('../services/syncQueue.service');
const scoringService = require('../services/scoring.service');
const challengesService = require('../services/challenges.service');
const prisma = require('../lib/prisma');

const ensureValidStravaToken = async (user) => {
  const isExpired = user.stravaTokenExpiry && 
    (new Date(user.stravaTokenExpiry).getTime() - Date.now() < 5 * 60 * 1000);
  
  if (isExpired && user.stravaRefreshToken) {
    console.log(`🔵 Refrescando token de Strava para usuario ${user.id}...`);
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
    console.log('✅ [GET ACTIVITIES] Encontradas:', total, 'actividades');

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
    console.error('🔴 [GET ACTIVITIES] Error:', error.message);
    res.status(500).json({ error: error.message });
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
        console.log(`🔵 [GET DETAIL] Sincronizando detalles de Strava para actividad ${id}...`);
        let accessToken = activity.user.stravaAccessToken;
        const user = activity.user;
        
        // Verificar si el token está expirado o expira pronto (menos de 5 minutos)
        const isExpired = user.stravaTokenExpiry && 
          (new Date(user.stravaTokenExpiry).getTime() - Date.now() < 5 * 60 * 1000);
        
        if (isExpired && user.stravaRefreshToken) {
          console.log('🔵 [GET DETAIL] Token de Strava expirado. Refrescando...');
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
              distanceKm: detailedActivity.distance ? (detailedActivity.distance / 1000) : activity.distanceKm
            },
            include: {
              laps: {
                orderBy: { splitNum: 'asc' }
              },
              user: {
                select: { id: true, email: true, role: true }
              }
            }
          });
          console.log(`✅ [GET DETAIL] Actividad ${id} sincronizada con detalles de Strava y ${lapsToCreate.length} laps.`);
        }
      } catch (syncError) {
        console.error(`🔴 [GET DETAIL] Error al sincronizar detalles de Strava:`, syncError.message);
      }
    }

    res.json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    scoringService.awardActivityPoints(activity.id).catch((err) => {
      console.error('[Scoring] Failed to award points:', err.message);
    });

    challengesService.updateChallengeProgress(userId).catch((err) => {
      console.error('[Challenges] Failed to update progress:', err.message);
    });

    res.status(201).json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
        isExternal: true,
        laps: {
          create: parsedData.laps || []
        }
      },
      include: {
        laps: {
          orderBy: { splitNum: 'asc' }
        }
      }
    });

    scoringService.awardActivityPoints(activity.id).catch((err) => {
      console.error('[Scoring] Failed to award points:', err.message);
    });

    challengesService.updateChallengeProgress(userId).catch((err) => {
      console.error('[Challenges] Failed to update progress:', err.message);
    });

    res.status(201).json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
        rawData: stravaActivity,
        laps: {
          create: lapsToCreate
        }
      },
      include: {
        laps: true
      }
    });

    scoringService.awardActivityPoints(activity.id).catch((err) => {
      console.error('[Scoring] Failed to award points:', err.message);
    });

    challengesService.updateChallengeProgress(userId).catch((err) => {
      console.error('[Challenges] Failed to update progress:', err.message);
    });

    res.status(201).json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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

    const updatedActivity = await prisma.activity.update({
      where: { id },
      data: {
        name: updates.name,
        type: updates.type
      },
      include: {
        laps: {
          orderBy: { splitNum: 'asc' }
        }
      }
    });

    res.json(updatedActivity);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    console.log('🔵 [SYNC STRAVA] Iniciando sincronización...');
    const userId = req.user.id;

    // Obtener el usuario con sus tokens de Strava y lastSyncDate
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user.stravaAccessToken) {
      console.log('🔴 [SYNC STRAVA] Usuario no conectado a Strava');
      return res.status(400).json({ error: 'No estás conectado a Strava' });
    }

    // Determinar si es sincronización incremental o completa
    const isIncremental = !!user.lastSyncDate;
    const afterDate = user.lastSyncDate ? new Date(user.lastSyncDate) : null;
    
    if (isIncremental) {
      console.log(`🔵 [SYNC STRAVA] Sincronización incremental desde: ${afterDate.toISOString()}`);
    } else {
      console.log('🔵 [SYNC STRAVA] Sincronización completa (todas las actividades)');
    }
    
    let allActivities = [];
    let page = 1;
    let hasMore = true;
    const perPage = 200; // Máximo permitido por Strava

    // Obtener actividades paginadas
    while (hasMore) {
      console.log(`🔵 [SYNC STRAVA] Obteniendo página ${page}...`);
      
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
        console.log(`✅ [SYNC STRAVA] Página ${page}: ${pageActivities.length} actividades`);
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

    console.log(`🔵 [SYNC STRAVA] Total de actividades obtenidas: ${allActivities.length}`);

    // Obtener todos los stravaIds existentes en una sola query
    console.log('🔵 [SYNC STRAVA] Verificando actividades existentes...');
    const existingActivities = await prisma.activity.findMany({
      where: { userId },
      select: { stravaId: true }
    });
    const existingStravaIds = new Set(existingActivities.map(a => a.stravaId));
    console.log(`✅ [SYNC STRAVA] ${existingStravaIds.size} actividades ya existen`);

    // Filtrar solo actividades nuevas
    const newActivities = allActivities.filter(
      activity => !existingStravaIds.has(activity.id.toString())
    );
    console.log(`🔵 [SYNC STRAVA] ${newActivities.length} actividades nuevas para importar`);

    if (newActivities.length === 0) {
      console.log('✅ [SYNC STRAVA] No hay actividades nuevas');
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
    console.log(`🔵 [SYNC STRAVA] Procesando ${batches.length} batches de ${batchSize} actividades...`);

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
          rawData: stravaActivity
        }));

        // Batch insert
        await prisma.activity.createMany({
          data: activitiesToCreate,
          skipDuplicates: true
        });

        created += batch.length;
        console.log(`✅ [SYNC STRAVA] Batch ${batchIndex + 1}/${batches.length}: ${batch.length} actividades creadas (Total: ${created})`);
      } catch (err) {
        console.error(`🔴 [SYNC STRAVA] Error en batch ${batchIndex + 1}:`, err.message);
        errors += batch.length;
      }
    }

    console.log('✅ [SYNC STRAVA] Sincronización completada');
    console.log(`✅ [SYNC STRAVA] Creadas: ${created} | Omitidas: ${skipped} | Errores: ${errors}`);

    // Actualizar lastSyncDate del usuario
    if (created > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { lastSyncDate: new Date() }
      });
      console.log('✅ [SYNC STRAVA] lastSyncDate actualizado');

      scoringService.batchScoreActivities(userId).catch((err) => {
        console.error('[Scoring] Failed to batch score synced activities:', err.message);
      });

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
    console.error('🔴 [SYNC STRAVA] Error:', error.message);
    console.error('🔴 [SYNC STRAVA] Stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
};

const checkNewActivities = async (req, res) => {
  try {
    console.log('🔵 [CHECK NEW] Verificando nuevas actividades...');
    const userId = req.user.id;

    // Obtener el usuario con sus tokens de Strava y lastSyncDate
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || !user.stravaAccessToken) {
      console.log('🔴 [CHECK NEW] Usuario no conectado a Strava');
      return res.json({ hasNew: false, count: 0, message: 'No conectado a Strava' });
    }

    const validToken = await ensureValidStravaToken(user);

    if (!user.lastSyncDate) {
      console.log('🔵 [CHECK NEW] Primera sincronización - todas las actividades son nuevas');
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
    console.log(`🔵 [CHECK NEW] Verificando actividades después de: ${afterDate.toISOString()}`);
    
    const newActivities = await stravaService.getActivities(
      validToken,
      1,
      30, // Solo verificar primeras 30
      afterDate
    );

    console.log(`✅ [CHECK NEW] Encontradas: ${newActivities.length} actividades nuevas`);

    res.json({
      hasNew: newActivities.length > 0,
      count: newActivities.length,
      lastActivity: newActivities[0] || null,
      lastSyncDate: user.lastSyncDate
    });
  } catch (error) {
    console.error('🔴 [CHECK NEW] Error:', error.message);
    res.status(500).json({ error: error.message });
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
    
    const jobId = syncQueueService.createJob(userId, validToken, afterDate);
    
    res.json({ jobId, status: 'created' });
  } catch (error) {
    console.error('🔴 [CREATE SYNC JOB] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

// Obtener estado de un job de sincronización
const getSyncJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = syncQueueService.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job no encontrado' });
    }
    
    res.json(job);
  } catch (error) {
    console.error('🔴 [GET SYNC JOB] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const getDashboardMetrics = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

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

    // Récord distancia
    const longestActivity = await prisma.activity.findFirst({
      where: { userId },
      orderBy: { distanceKm: 'desc' },
      select: {
        distanceKm: true,
        name: true
      }
    });

    // Racha - días consecutivos con actividad
    const allActivities = await prisma.activity.findMany({
      where: { userId },
      select: {
        startDate: true
      },
      orderBy: { startDate: 'desc' }
    });

    const streak = calculateStreak(allActivities);

    // Score y Rank
    const userScore = await prisma.userScore.findUnique({
      where: { userId },
      include: {
        currentRank: true
      }
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
    console.error('🔴 [GET DASHBOARD METRICS] Error:', error.message);
    res.status(500).json({ error: error.message });
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
      // Buscar duplicado por ID externo o combinación única
      const existing = await prisma.activity.findFirst({
        where: {
          userId,
          OR: [
            { stravaId: w.externalId },
            {
              startDate: new Date(w.startDate),
              type: w.type
            }
          ]
        }
      });

      if (existing) {
        continue;
      }

      await prisma.activity.create({
        data: {
          userId,
          name: w.name,
          type: w.type,
          distanceKm: parseFloat(w.distanceKm) || 0,
          elevationM: parseFloat(w.elevationM) || 0,
          movingTime: parseInt(w.movingTime) || 0,
          startDate: new Date(w.startDate),
          averageHr: w.averageHr ? parseInt(w.averageHr) : null,
          maxHr: w.maxHr ? parseInt(w.maxHr) : null,
          calories: w.calories ? parseInt(w.calories) : null,
          isExternal: true,
          stravaId: w.externalId
        }
      });

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
    console.error('🔴 [SYNC HEALTH WORKOUTS] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

function calculateStreak(activities) {
  if (activities.length === 0) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const activityDates = activities
    .map(a => {
      const date = new Date(a.startDate);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    })
    .sort((a, b) => b - a);

  let streak = 0;
  let currentDate = today.getTime();
  const oneDay = 24 * 60 * 60 * 1000;

  for (const date of activityDates) {
    if (date === currentDate) {
      streak++;
      currentDate -= oneDay;
    } else if (date === currentDate - oneDay) {
      currentDate -= oneDay;
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

const createManualActivity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, type, distanceKm, movingTime, startDate, description } = req.body;
    
    if (!name || !type || !startDate) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const activity = await prisma.activity.create({
      data: {
        userId,
        name,
        type,
        distanceKm: parseFloat(distanceKm) || 0,
        elevationM: 0,
        movingTime: parseInt(movingTime) || 0,
        startDate: new Date(startDate),
        description: description || null,
        isExternal: false
      }
    });

    // Otorgar puntos
    scoringService.awardActivityPointsIfNotScored(activity.id).catch(console.error);

    res.status(201).json(activity);
  } catch (error) {
    console.error('🔴 [CREATE MANUAL ACTIVITY] Error:', error.message);
    res.status(500).json({ error: error.message });
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
    console.error('🔴 [UPLOAD ACTIVITY PHOTOS] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getActivities,
  getActivityById,
  createActivity,
  createManualActivity,
  uploadActivity,
  uploadActivityPhotos,
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
  getDashboardMetrics
};
