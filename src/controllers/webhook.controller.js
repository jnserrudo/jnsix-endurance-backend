const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const stravaService = require('../services/strava.service');
const scoringService = require('../services/scoring.service');
const challengesService = require('../services/challenges.service');
const referralService = require('../services/referral.service');

const verifyStravaWebhook = async (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': verifyToken, 'hub.challenge': challenge } = req.query;
  
  console.log('[WARN] [STRAVA WEBHOOK] Verificación:', { mode, verifyToken });
  
  // Token de verificación de Strava (debería estar en variables de entorno)
  const STRAVA_VERIFY_TOKEN = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN || 'STRAVA_VERIFY_TOKEN';
  
  if (mode === 'subscribe' && verifyToken === STRAVA_VERIFY_TOKEN) {
    console.log('[SUCCESS] [STRAVA WEBHOOK] Verificación exitosa');
    return res.status(200).send(challenge);
  }

  if (!mode && !verifyToken) {
    // Ping sin parámetros de verificación (ej. health check de Strava) - responder 200
    return res.status(200).json({ status: 'ok' });
  }

  console.error('[ERROR] [STRAVA WEBHOOK] Verificación fallida');
  return res.status(403).json({ error: 'Verification failed' });
};

const handleStravaWebhook = async (req, res) => {
  const { object_type, aspect_type, owner_id, object_id, time } = req.body;
  
  console.log('[WARN] [STRAVA WEBHOOK] Evento recibido:', { object_type, aspect_type, owner_id, object_id });
  
  try {
    // Solo procesar eventos de actividad
    if (object_type !== 'activity') {
      console.log('[WARN] [STRAVA WEBHOOK] Ignorando evento no-activity:', object_type);
      return res.status(200).json({ status: 'ignored' });
    }
    
    // Solo procesar eventos de creación
    if (aspect_type !== 'create') {
      console.log('[WARN] [STRAVA WEBHOOK] Ignorando evento no-create:', aspect_type);
      return res.status(200).json({ status: 'ignored' });
    }
    
    // Buscar usuario por Strava ID
    const user = await prisma.user.findFirst({
      where: { stravaId: owner_id.toString() }
    });
    
    if (!user) {
      console.log('[WARN] [STRAVA WEBHOOK] Usuario no encontrado para Strava ID:', owner_id);
      return res.status(200).json({ status: 'user_not_found' });
    }
    
    console.log('[SUCCESS] [STRAVA WEBHOOK] Usuario encontrado:', user.id);

    // Check if activity already exists (Strava can send duplicate webhooks)
    const existingActivity = await prisma.activity.findUnique({
      where: { stravaId: object_id.toString() }
    });
    if (existingActivity) {
      console.log('[WARN] [STRAVA WEBHOOK] Actividad ya existe, ignorando:', object_id);
      return res.status(200).json({ status: 'already_exists' });
    }

    // Refresh Strava token if expired
    let accessToken = user.stravaAccessToken;
    if (user.stravaTokenExpiry && new Date(user.stravaTokenExpiry) <= new Date()) {
      try {
        console.log('[DEBUG] [STRAVA WEBHOOK] Token expirado, refrescando...');
        const refreshed = await stravaService.refreshToken(user.stravaRefreshToken);
        accessToken = refreshed.access_token;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            stravaAccessToken: refreshed.access_token,
            stravaRefreshToken: refreshed.refresh_token,
            stravaTokenExpiry: new Date(refreshed.expires_at * 1000)
          }
        });
      } catch (refreshErr) {
        console.error('[ERROR] [STRAVA WEBHOOK] Error refrescando token:', refreshErr.message);
        return res.status(200).json({ status: 'token_refresh_failed' });
      }
    }
    
    // Sincronizar la nueva actividad
    const newActivity = await stravaService.getActivity(
      object_id,
      accessToken
    );
    
    if (newActivity) {
      const lapsToCreate = [];
      if (newActivity.laps && Array.isArray(newActivity.laps)) {
        newActivity.laps.forEach((lap, index) => {
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
      } else if (newActivity.splits_metric && Array.isArray(newActivity.splits_metric)) {
        newActivity.splits_metric.forEach((split, index) => {
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

      // Crear la actividad en la base de datos
      const activityData = {
        userId: user.id,
        stravaId: object_id.toString(),
        name: newActivity.name || 'Strava Activity',
        type: newActivity.type?.toUpperCase() || 'RUN',
        startDate: new Date(newActivity.start_date),
        distanceKm: newActivity.distance ? newActivity.distance / 1000 : 0,
        movingTime: newActivity.moving_time || 0,
        elevationM: newActivity.total_elevation_gain || 0,
        averageHr: newActivity.average_heartrate ? Math.round(newActivity.average_heartrate) : 0,
        maxHr: newActivity.max_heartrate ? Math.round(newActivity.max_heartrate) : 0,
        calories: newActivity.calories || 0,
        rawData: newActivity,
        laps: {
          create: lapsToCreate
        }
      };
      
      const createdActivity = await prisma.activity.create({ data: activityData });
      
      // Actualizar lastSyncDate
      await prisma.user.update({
        where: { id: user.id },
        data: { lastSyncDate: new Date() }
      });

      scoringService.awardActivityPoints(createdActivity.id).catch((err) => {
        console.error('[Scoring] Failed to award points from webhook:', err.message);
      });
      referralService.maybeRewardOnFirstActivity(user.id, createdActivity.id).catch((err) => {
        console.error('[Referrals] Failed to reward first webhook activity:', err.message);
      });

      challengesService.updateChallengeProgress(user.id).catch((err) => {
        console.error('[Challenges] Failed to update progress from webhook:', err.message);
      });
      
      console.log('[SUCCESS] [STRAVA WEBHOOK] Actividad sincronizada:', object_id);
    }
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('[ERROR] [STRAVA WEBHOOK] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  verifyStravaWebhook,
  handleStravaWebhook
};
