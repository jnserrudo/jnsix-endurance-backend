const prisma = require('../lib/prisma');
const gamificationService = require('../services/gamification.service');
const scoringService = require('../services/scoring.service');
const { getTodayPlanSession } = require('../services/planSessionMatching.service');
const { buildWeeklyRecap } = require('../services/weeklyDigest.service');

const EARTH_RADIUS_KM = 6371;
const NEARBY_RADIUS_KM = 5;

const toRad = (deg) => (deg * Math.PI) / 180;

const distanceKm = (lat1, lon1, lat2, lon2) => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
};

/**
 * Cada bloque va en su propio try: si falla la racha no queremos perder la
 * sesión del plan. La tarjeta de Hoy tiene que aparecer siempre con algo.
 */
const safely = async (label, fn) => {
  try {
    return await fn();
  } catch (error) {
    console.error(`[ME/TODAY] ${label} falló:`, error.message);
    return null;
  }
};

/**
 * `getTodayPlanSession` devuelve `{ userPlan, session, scheduledDate }`; el móvil
 * solo necesita lo justo para pintar la tarjeta y navegar al plan.
 */
const flattenPlanSession = (raw) => {
  if (!raw?.session) return null;
  const { session, userPlan, scheduledDate } = raw;
  return {
    id: session.id,
    name: session.name,
    description: session.description,
    week: session.week,
    day: session.day,
    targetMetric: session.targetMetric,
    targetValue: session.targetValue,
    status: session.status,
    done: session.status === 'DONE',
    scheduledDate,
    planId: userPlan.trainingPlanId,
    userPlanId: userPlan.id,
    planName: userPlan.plan?.name || null,
  };
};

const findNearbyBusiness = async (lat, lng) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const businesses = await prisma.business.findMany({
    where: {
      status: 'APPROVED',
      isActive: true,
      latitude: { not: null },
      longitude: { not: null },
    },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      category: true,
      latitude: true,
      longitude: true,
      rewards: {
        where: { status: 'ACTIVE' },
        select: { id: true, title: true, pointsCost: true },
        orderBy: { pointsCost: 'asc' },
        take: 1,
      },
    },
    take: 200,
  });

  const withDistance = businesses
    .map((b) => ({
      ...b,
      distanceKm: distanceKm(lat, lng, Number(b.latitude), Number(b.longitude)),
    }))
    .filter((b) => b.distanceKm <= NEARBY_RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const closest = withDistance[0];
  if (!closest) return null;

  return {
    id: closest.id,
    name: closest.name,
    logoUrl: closest.logoUrl,
    category: closest.category,
    distanceKm: Number(closest.distanceKm.toFixed(2)),
    reward: closest.rewards[0] || null,
  };
};

/**
 * GET /api/me/today
 *
 * Junta en una sola respuesta todo lo que la app necesita para responder "¿qué
 * hago ahora?" y devuelve además una acción sugerida ya priorizada, para que el
 * móvil no tenga que replicar ese criterio.
 */
const getToday = async (req, res) => {
  try {
    const userId = req.user.id;
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    const [rawPlanSession, streak, mission, suggestions, nearbyBusiness, activeChallenge] =
      await Promise.all([
        safely('sesión del plan', () => getTodayPlanSession(userId)),
        safely('racha', () => gamificationService.getStreakAtRiskStatus(userId)),
        safely('misión del día', () => gamificationService.getTodayMission(userId)),
        safely('recompensas', () => scoringService.getRewardSuggestions(userId)),
        safely('negocio cerca', () => findNearbyBusiness(lat, lng)),
        safely('reto activo', () =>
          prisma.challengeParticipant.findFirst({
            where: {
              userId,
              completed: false,
              challenge: { isActive: true, deletedAt: null, endDate: { gte: new Date() } },
            },
            select: {
              currentProgress: true,
              challenge: {
                select: {
                  id: true,
                  name: true,
                  targetValue: true,
                  metric: true,
                  endDate: true,
                },
              },
            },
            orderBy: { challenge: { endDate: 'asc' } },
          })
        ),
      ]);

    const planSession = flattenPlanSession(rawPlanSession);
    const almostThere = suggestions?.almostThere?.[0] || suggestions?.nearest || null;

    // Prioridad: lo que se pierde hoy primero, después lo que construye hábito.
    let action = null;

    if (planSession && !planSession.done) {
      action = {
        kind: 'PLAN_SESSION',
        title: `Hoy toca: ${planSession.name}`,
        body: planSession.description || 'Abrí tu plan para ver el detalle de la sesión.',
        ctaLabel: 'Ver la sesión',
        screen: 'PlanDetail',
        params: { planId: planSession.planId },
      };
    } else if (streak?.atRisk) {
      action = {
        kind: 'STREAK_AT_RISK',
        title: `Tu racha de ${streak.currentStreak} días está en riesgo`,
        body: 'Registrá una actividad hoy para no perderla.',
        ctaLabel: 'Registrar actividad',
        screen: 'RecordActivity',
      };
    } else if (mission && !mission.completed) {
      action = {
        kind: 'MISSION',
        title: mission.name || 'Tenés una misión para hoy',
        body: mission.description || `Completala y sumás ${mission.rewardPts || 0} pts.`,
        ctaLabel: 'Ver misiones',
        screen: 'Achievements',
      };
    } else if (almostThere) {
      action = {
        kind: 'REWARD_CLOSE',
        title: `Te faltan ${almostThere.pointsNeeded} pts para un beneficio`,
        body: `${almostThere.title} en ${almostThere.business?.name || 'un local del club'}.`,
        ctaLabel: 'Ver el beneficio',
        screen: 'RewardDetail',
        params: { rewardId: almostThere.id },
      };
    } else if (nearbyBusiness) {
      action = {
        kind: 'BUSINESS_NEARBY',
        title: `${nearbyBusiness.name} está a ${nearbyBusiness.distanceKm} km`,
        body: nearbyBusiness.reward
          ? `Tienen ${nearbyBusiness.reward.title} por ${nearbyBusiness.reward.pointsCost} pts.`
          : 'Hacé check-in cuando pases y sumá puntos.',
        ctaLabel: 'Ver el local',
        screen: 'BusinessDetail',
        params: { businessId: nearbyBusiness.id },
      };
    } else if (activeChallenge) {
      const { name, targetValue } = activeChallenge.challenge;
      const done = Number(activeChallenge.currentProgress) || 0;
      const remaining = Math.max(0, (Number(targetValue) || 0) - done);
      action = {
        kind: 'CHALLENGE',
        title: name,
        body: remaining > 0
          ? `Te falta completar ${Math.round(remaining)} para cerrar este reto.`
          : 'Ya alcanzaste el objetivo de este reto.',
        ctaLabel: 'Ver el reto',
        screen: 'Challenges',
      };
    } else {
      action = {
        kind: 'FALLBACK',
        title: 'Hoy no tenés nada pendiente',
        body: 'Registrá una actividad para empezar a sumar puntos y armar tu racha.',
        ctaLabel: 'Registrar actividad',
        screen: 'RecordActivity',
      };
    }

    res.json({
      action,
      planSession: planSession || null,
      streak: streak || null,
      mission: mission || null,
      rewardClose: almostThere
        ? {
            id: almostThere.id,
            title: almostThere.title,
            pointsNeeded: almostThere.pointsNeeded,
            effectiveCost: almostThere.effectiveCost,
            business: almostThere.business || null,
          }
        : null,
      totalPoints: suggestions?.totalPoints ?? null,
      redeemableCount: suggestions?.redeemable?.length ?? 0,
      nearbyBusiness: nearbyBusiness || null,
      challenge: activeChallenge || null,
    });
  } catch (error) {
    console.error('[ERROR] [GET /me/today]', error);
    res.status(500).json({ error: 'No pudimos armar tu resumen de hoy. Intentá de nuevo.' });
  }
};

/** GET /api/me/weekly-recap */
const getWeeklyRecap = async (req, res) => {
  try {
    const recap = await buildWeeklyRecap(req.user.id);
    res.json(recap);
  } catch (error) {
    console.error('[ERROR] [GET /me/weekly-recap]', error);
    res.status(500).json({ error: 'No pudimos armar tu resumen semanal. Intentá de nuevo.' });
  }
};

module.exports = { getToday, getWeeklyRecap };
