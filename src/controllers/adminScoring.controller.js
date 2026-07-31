const prisma = require('../lib/prisma');
const scoringConfig = require('../services/scoringConfig.service');
const scoringService = require('../services/scoring.service');
const { APP_NAME } = require('../constants/brand');

/**
 * Administración de la economía de puntos.
 *
 * Criterio: cambiar una regla afecta de ahí en adelante y nunca reescribe puntos
 * ya otorgados. Recalcular y revertir son acciones aparte y explícitas.
 * Toda escritura queda en AuditLog por la extensión de Prisma en lib/prisma.js.
 */

const handleError = (res, error, label) => {
  if (error?.name === 'ScoringRuleError') {
    return res.status(error.status || 400).json({ error: error.message });
  }
  console.error(`[ERROR] ${label}:`, error);
  return res.status(500).json({ error: 'Error interno del servidor' });
};

const listScoringRules = async (req, res) => {
  try {
    const rules = await scoringConfig.getRules();
    res.json(rules);
  } catch (error) {
    handleError(res, error, 'listScoringRules');
  }
};

const updateScoringRule = async (req, res) => {
  try {
    const rule = await scoringConfig.setRule(req.params.key, req.body?.value, req.user.id);
    res.json({ ...rule, message: `${rule.label}: ${rule.value}${rule.unit === 'pct' ? '%' : ''}` });
  } catch (error) {
    handleError(res, error, 'updateScoringRule');
  }
};

const resetScoringRules = async (req, res) => {
  try {
    const result = await scoringConfig.resetRules(req.body?.group || null);
    res.json(result);
  } catch (error) {
    handleError(res, error, 'resetScoringRules');
  }
};

/**
 * Calcula puntos con las reglas vigentes y, si se mandan `overrides`, también con
 * los valores propuestos. Sirve para ver el impacto de un cambio antes de guardarlo.
 */
const simulateScoring = async (req, res) => {
  try {
    const body = req.body || {};
    const input = {
      type: body.type || 'RUN',
      distanceKm: Number(body.distanceKm) || 0,
      elevationM: Number(body.elevationM) || 0,
      movingTimeMin: Number(body.movingTimeMin) || 0,
      sets: Math.max(0, Math.round(Number(body.sets) || 0)),
      repsPerSet: Math.max(0, Math.round(Number(body.repsPerSet) || 0)),
      weightKg: Math.max(0, Number(body.weightKg) || 0),
    };

    const activity = {
      type: input.type,
      distanceKm: input.distanceKm,
      elevationM: input.elevationM,
      movingTime: input.movingTimeMin * 60,
    };
    const workoutSets = Array.from({ length: input.sets }, () => ({
      reps: input.repsPerSet,
      weightKg: input.weightKg,
    }));

    const currentValues = await scoringConfig.getValues();
    const evaluate = (values) => ({
      activityPoints: scoringService.calculateActivityPointsWith(activity, values),
      workoutPoints: scoringService.calculateWorkoutPointsWith(workoutSets, values),
      breakdown: {
        distance: Math.round(input.distanceKm * (values['activity.points_per_km'] ?? 0)),
        elevation: Math.round(input.elevationM * (values['activity.points_per_elevation_m'] ?? 0)),
        time: Math.round((input.movingTimeMin / 60) * (values['activity.points_per_hour'] ?? 0)),
        multiplier: scoringConfig.getMultiplier(values, input.type),
      },
    });

    const overrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : null;
    let proposed = null;
    if (overrides) {
      const proposedValues = { ...currentValues };
      for (const [key, raw] of Object.entries(overrides)) {
        if (!scoringConfig.DEFAULTS_BY_KEY.has(key)) continue;
        const value = Number(raw);
        if (Number.isFinite(value)) proposedValues[key] = value;
      }
      proposed = evaluate(proposedValues);
    }

    res.json({ input, current: evaluate(currentValues), proposed });
  } catch (error) {
    handleError(res, error, 'simulateScoring');
  }
};

/** Ajuste manual de puntos: suma o resta con motivo obligatorio y registro visible. */
const adjustUserPoints = async (req, res) => {
  try {
    const userId = req.params.id;
    const points = Math.round(Number(req.body?.points));
    const reason = String(req.body?.reason || '').trim();
    const shouldNotify = req.body?.notify === true;

    if (!Number.isFinite(points) || points === 0) {
      return res.status(400).json({ error: 'Indicá una cantidad de puntos distinta de cero.' });
    }
    if (Math.abs(points) > 1000000) {
      return res.status(400).json({ error: 'El ajuste máximo es de 1.000.000 pts.' });
    }
    if (reason.length < 3) {
      return res.status(400).json({ error: 'El motivo es obligatorio: queda visible en el historial del usuario.' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const result = await scoringService.awardPoints(userId, {
      points,
      reason: `Ajuste del equipo ${APP_NAME}: ${reason}`,
      source: scoringService.ADMIN_ADJUSTMENT,
      createdBy: req.user.id,
      silent: !shouldNotify,
    });

    res.json({
      eventId: result.event?.id || null,
      points,
      newTotalPoints: result.userScore?.totalPoints ?? null,
      rank: result.rank || null,
      rankChanged: result.rankChanged || false,
      notified: shouldNotify && points > 0,
    });
  } catch (error) {
    handleError(res, error, 'adjustUserPoints');
  }
};

const getUserPointsDetail = async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const [score, events, unscoredActivities] = await Promise.all([
      prisma.userScore.findUnique({ where: { userId }, include: { currentRank: true } }),
      prisma.scoreEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      prisma.activity.count({ where: { userId, scoreEvents: { none: {} } } }),
    ]);

    res.json({
      user,
      totalPoints: score?.totalPoints || 0,
      rank: score?.currentRank || null,
      unscoredActivities,
      events: events.map((event) => ({
        id: event.id,
        points: event.points,
        reason: event.reason,
        createdAt: event.createdAt,
        createdBy: event.createdBy,
        ...scoringService.deriveEventMeta(event),
      })),
    });
  } catch (error) {
    handleError(res, error, 'getUserPointsDetail');
  }
};

/**
 * Recalcula el saldo desde los eventos. Con `rescoreActivities` además puntúa las
 * actividades que quedaron sin evento (por ejemplo, importadas antes de un fix).
 * Puede mover al usuario de rango, así que la UI lo pide con confirmación.
 */
const recalculateUserPoints = async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const rescore = req.body?.rescoreActivities === true;
    const result = rescore
      ? await scoringService.batchScoreActivities(userId)
      : await scoringService.recalculateUserScore(userId);

    res.json({
      totalPoints: result.userScore?.totalPoints ?? null,
      rank: result.rank || null,
      rankChanged: result.rankChanged || false,
      rankDirection: result.rankDirection || null,
      activitiesScored: result.activitiesScored || 0,
      pointsFromActivities: result.totalEarned || 0,
    });
  } catch (error) {
    handleError(res, error, 'recalculateUserPoints');
  }
};

/** Revierte un ajuste creando el evento inverso: la historia queda auditable. */
const revertAdjustment = async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = await prisma.scoreEvent.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ error: 'Movimiento no encontrado' });
    if (event.source !== scoringService.ADMIN_ADJUSTMENT) {
      return res.status(400).json({
        error: 'Solo se pueden revertir ajustes manuales. Para el resto, usá recalcular.',
      });
    }

    const revertMarker = `Reversión del ajuste ${eventId}`;
    const already = await prisma.scoreEvent.findFirst({
      where: { userId: event.userId, reason: { contains: revertMarker } },
    });
    if (already) {
      return res.status(409).json({ error: 'Ese ajuste ya fue revertido.' });
    }

    const result = await scoringService.awardPoints(event.userId, {
      points: -event.points,
      reason: `${revertMarker}: ${event.reason}`,
      source: scoringService.ADMIN_ADJUSTMENT,
      createdBy: req.user.id,
      silent: true,
    });

    res.json({
      revertedEventId: eventId,
      points: -event.points,
      newTotalPoints: result.userScore?.totalPoints ?? null,
    });
  } catch (error) {
    handleError(res, error, 'revertAdjustment');
  }
};

module.exports = {
  listScoringRules,
  updateScoringRule,
  resetScoringRules,
  simulateScoring,
  adjustUserPoints,
  getUserPointsDetail,
  recalculateUserPoints,
  revertAdjustment,
};
