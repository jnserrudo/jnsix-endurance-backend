const prisma = require('../lib/prisma');
const {
  getTodayPlanSession,
  suggestPlanSessionMatch,
} = require('../services/planSessionMatching.service');
const { checkAndNotifyTrainingLoad } = require('../services/trainingLoad.service');

const SESSION_STATUSES = new Set(['PENDING', 'DONE', 'SKIPPED', 'MOVED']);

// Obtener el plan de entrenamiento actual del usuario
const getCurrentPlan = async (req, res) => {
  try {
    const userId = req.user.id;

    const userPlan = await prisma.userPlan.findFirst({
      where: { userId, isActive: true },
      include: {
        plan: {
          include: {
            sessions: {
              orderBy: [
                { week: 'asc' },
                { day: 'asc' }
              ]
            }
          }
        },
        competitionGoal: true
      }
    });

    if (!userPlan) {
      return res.status(200).json(null);
    }

    res.json(userPlan);
  } catch (error) {
    console.error('[GET CURRENT PLAN ERROR]', error);
    res.status(500).json({
      error: 'No pudimos cargar tu plan ahora. Intentá de nuevo en unos minutos.',
    });
  }
};

const getTodaySession = async (req, res) => {
  try {
    const result = await getTodayPlanSession(req.user.id);
    if (!result) return res.json(null);

    const { userPlan, session, scheduledDate } = result;
    res.json({
      session,
      scheduledDate,
      plan: {
        id: userPlan.plan.id,
        name: userPlan.plan.name,
        level: userPlan.plan.level,
        weeks: userPlan.plan.weeks,
      },
      userPlanId: userPlan.id,
      competitionGoal: userPlan.competitionGoal,
    });
  } catch (error) {
    console.error('[GET TODAY PLAN SESSION ERROR]', error);
    res.status(500).json({ error: 'No pudimos cargar la sesión de hoy.' });
  }
};

const updateSession = async (req, res) => {
  try {
    const { planId, sessionId } = req.params;
    const status = String(req.body.status || '').toUpperCase();
    const { completedActivityId, rescheduledTo } = req.body;

    if (!SESSION_STATUSES.has(status)) {
      return res.status(400).json({ error: 'El estado de la sesión no es válido.' });
    }

    const userPlan = await prisma.userPlan.findFirst({
      where: { userId: req.user.id, trainingPlanId: planId },
      select: { id: true },
    });
    if (!userPlan) return res.status(404).json({ error: 'No encontramos ese plan.' });

    const session = await prisma.planSession.findFirst({
      where: { id: sessionId, trainingPlanId: planId },
    });
    if (!session) return res.status(404).json({ error: 'No encontramos esa sesión.' });

    if (completedActivityId) {
      const activity = await prisma.activity.findFirst({
        where: { id: completedActivityId, userId: req.user.id },
        select: { id: true },
      });
      if (!activity) return res.status(404).json({ error: 'No encontramos esa actividad.' });
    }

    let movedDate = null;
    if (status === 'MOVED') {
      movedDate = new Date(rescheduledTo);
      if (!rescheduledTo || Number.isNaN(movedDate.getTime())) {
        return res.status(400).json({ error: 'Elegí una fecha válida para mover la sesión.' });
      }
    }

    const updated = await prisma.planSession.update({
      where: { id: sessionId },
      data: {
        status,
        completedActivityId: status === 'DONE' ? completedActivityId || session.completedActivityId : null,
        completedAt: status === 'DONE' ? new Date() : null,
        rescheduledTo: status === 'MOVED' ? movedDate : null,
      },
    });
    res.json(updated);
  } catch (error) {
    console.error('[UPDATE PLAN SESSION ERROR]', error);
    res.status(500).json({ error: 'No pudimos actualizar la sesión.' });
  }
};

const matchSession = async (req, res) => {
  try {
    const { activityId, autoComplete = false } = req.body;
    if (!activityId) return res.status(400).json({ error: 'Falta la actividad.' });

    const activity = await prisma.activity.findFirst({
      where: { id: activityId, userId: req.user.id },
    });
    if (!activity) return res.status(404).json({ error: 'No encontramos esa actividad.' });

    const suggestion = await suggestPlanSessionMatch(req.user.id, activity, Boolean(autoComplete));
    res.json({ suggestedSession: suggestion?.session || null, matchSuggestion: suggestion });
  } catch (error) {
    console.error('[MATCH PLAN SESSION ERROR]', error);
    res.status(500).json({ error: 'No pudimos buscar una sesión compatible.' });
  }
};

const regenerateWeek = async (req, res) => {
  try {
    const { planId } = req.params;
    const week = parseInt(req.body.week, 10);
    if (!Number.isInteger(week) || week < 1) {
      return res.status(400).json({ error: 'La semana no es válida.' });
    }

    const userPlan = await prisma.userPlan.findFirst({
      where: { userId: req.user.id, trainingPlanId: planId },
      include: { plan: { include: { sessions: true } } },
    });
    if (!userPlan) return res.status(404).json({ error: 'No encontramos ese plan.' });
    if (week > userPlan.plan.weeks) {
      return res.status(400).json({ error: 'La semana está fuera del plan.' });
    }

    const allSessions = userPlan.plan.sessions;
    const current = allSessions.filter((session) => session.week === week);
    const otherWeeks = [...new Set(allSessions.map((session) => session.week).filter((w) => w !== week))]
      .sort((a, b) => Math.abs(a - week) - Math.abs(b - week));
    const pattern = current.length
      ? current
      : allSessions.filter((session) => session.week === otherWeeks[0]);
    if (!pattern.length) {
      return res.status(400).json({ error: 'El plan no tiene un patrón para regenerar.' });
    }

    const regenerated = await prisma.$transaction(async (tx) => {
      await tx.planSession.deleteMany({ where: { trainingPlanId: planId, week } });
      await tx.planSession.createMany({
        data: pattern.map((session) => ({
          trainingPlanId: planId,
          week,
          day: session.day,
          name: session.name,
          description: session.description,
          rationale: session.rationale || 'Sesión regenerada según el patrón y la carga del plan.',
          targetMetric: session.targetMetric,
          targetValue: session.targetValue,
          status: 'PENDING',
        })),
      });
      return tx.planSession.findMany({
        where: { trainingPlanId: planId, week },
        orderBy: { day: 'asc' },
      });
    });
    res.json({ week, sessions: regenerated });
  } catch (error) {
    console.error('[REGENERATE PLAN WEEK ERROR]', error);
    res.status(500).json({ error: 'No pudimos regenerar esa semana.' });
  }
};

// Log de esfuerzo (RPE)
const logEffort = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityId, perceivedExertion, feeling, notes } = req.body;
    const rpe = parseInt(perceivedExertion, 10);
    if (!activityId || !Number.isInteger(rpe) || rpe < 1 || rpe > 10) {
      return res.status(400).json({ error: 'Elegí una actividad y un RPE entre 1 y 10.' });
    }
    const activity = await prisma.activity.findFirst({
      where: { id: activityId, userId },
      select: { id: true },
    });
    if (!activity) return res.status(404).json({ error: 'No encontramos esa actividad.' });

    const effort = await prisma.effortLog.upsert({
      where: { activityId },
      create: {
        userId,
        activityId,
        rpe,
        notes
      },
      update: { rpe, notes },
    });

    checkAndNotifyTrainingLoad(userId).catch((err) => {
      console.warn('[LOG EFFORT] training load check skipped:', err.message);
    });

    res.status(201).json({ ...effort, perceivedExertion: effort.rpe, feeling: feeling || null });
  } catch (error) {
    console.error('[LOG EFFORT ERROR]', error);
    res.status(500).json({ error: 'No pudimos guardar tu esfuerzo. Intentá de nuevo.' });
  }
};

// Obtener historial de esfuerzo (para graficas en Dashboard)
const getEffortHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const efforts = await prisma.effortLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: 30, // Ultimos 30 esfuerzos
      include: {
        activity: { select: { name: true, startDate: true } }
      }
    });

    res.json(efforts.map((effort) => ({
      ...effort,
      perceivedExertion: effort.rpe,
    })));
  } catch (error) {
    console.error('[GET EFFORT HISTORY ERROR]', error);
    res.status(500).json({ error: 'No pudimos cargar el historial de esfuerzo.' });
  }
};

const aiService = require('../services/ai.service');

function defaultSessionRationale(session) {
  const name = String(session?.name || '').toLowerCase();
  if (/descanso|rest|off|libre/.test(name)) {
    return 'Permite que el cuerpo se recupere y consolide las adaptaciones del entrenamiento.';
  }
  if (/fácil|suave|easy|recovery|regener|z2|aeróbic/.test(name)) {
    return 'Mantiene el volumen aeróbico sin acumular fatiga residual.';
  }
  if (/tempo|umbral|threshold|ritmo/.test(name)) {
    return 'Mejora la capacidad de sostener ritmo de carrera cerca del umbral.';
  }
  if (/serie|intervalo|interval|vo2|repetici/.test(name)) {
    return 'Estimula la potencia aeróbica y la economía a ritmos altos.';
  }
  if (/largo|long|fondo/.test(name)) {
    return 'Desarrolla la resistencia específica y la tolerancia a la fatiga.';
  }
  if (/fuerza|strength|gym|gimnasio|core/.test(name)) {
    return 'Refuerza la musculatura de soporte y reduce el riesgo de lesión.';
  }
  if (/bici|cicl|ride|spin/.test(name)) {
    return 'Aporta carga cardiovascular con menor impacto articular.';
  }
  if (/nada|swim|pileta/.test(name)) {
    return 'Trabaja capacidad aeróbica y técnica con bajo estrés mecánico.';
  }
  return 'Sesión alineada con la progresión semanal del plan hacia tu objetivo.';
}

// Generar un nuevo plan con IA
const generatePlan = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      goal,
      weeks = 4,
      level = 'Intermedio',
      availability = '4 días/semana',
      currentDistance = 0,
      competitionGoalId = null,
      sportType = 'RUN',
      targetDistance = null,
      targetElevation = null,
      targetDate = null,
      targetTime = null,
      terrainType = null,
      notes = null,
      preferredDays = [],
      currentWeeklyVolume = null,
      targetWeeklyVolume = null,
      preferredRpe = null,
      includeStrength = true,
      savedSessionIds = [],
    } = req.body;

    if (!goal?.trim()) {
      return res.status(400).json({ error: 'Necesitamos un objetivo para armar tu plan.' });
    }

    const parsedWeeks = Math.max(4, Math.min(52, parseInt(weeks, 10) || 4));
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        experienceLevel: true,
        primarySport: true,
        weightKg: true,
        heightCm: true,
        birthDate: true,
        gender: true,
        hrZones: true,
        paceZones: true,
        powerZones: true,
      },
    });

    let competitionGoal = null;
    if (competitionGoalId) {
      competitionGoal = await prisma.competitionGoal.findFirst({
        where: { id: competitionGoalId, userId },
        include: {
          simulations: {
            select: {
              name: true,
              type: true,
              distanceKm: true,
              movingTime: true,
              elevationM: true,
              startDate: true,
            },
          },
        },
      });
      if (!competitionGoal) {
        return res.status(404).json({ error: 'No encontramos ese objetivo de competencia.' });
      }
    }

    const ids = Array.isArray(savedSessionIds)
      ? savedSessionIds.filter((id) => typeof id === 'string' && id.trim())
      : [];
    const savedSessions = ids.length
      ? await prisma.savedSession.findMany({
          where: { userId, id: { in: ids } },
          select: {
            name: true,
            description: true,
            targetMetric: true,
            targetValue: true,
            sportType: true,
          },
        })
      : [];

    let strengthExercises = [];
    if (includeStrength !== false) {
      try {
        strengthExercises = await prisma.exercise.findMany({
          take: 8,
          orderBy: { name: 'asc' },
          select: { name: true, muscleGroup: true, equipment: true, target: true },
        });
      } catch (exErr) {
        console.warn('[GENERATE PLAN] exercise fetch skipped:', exErr.message);
      }
    }

    const goalInput = {
      goal: competitionGoal?.name || goal.trim(),
      sportType: competitionGoal?.type || sportType,
      targetDistance: competitionGoal?.distanceKm ?? numericOrNull(targetDistance),
      targetElevation: competitionGoal?.elevationM ?? numericOrNull(targetElevation),
      targetDate: competitionGoal?.targetDate?.toISOString() || targetDate || null,
      targetTime: competitionGoal?.targetTime || targetTime || null,
      terrainType: competitionGoal?.terrainType || terrainType || null,
      notes: competitionGoal?.notes || notes || null,
      weeks: parsedWeeks,
      level,
      availability,
      currentDistance,
      preferredDays: Array.isArray(preferredDays) ? preferredDays : [],
      currentWeeklyVolume: numericOrNull(currentWeeklyVolume),
      targetWeeklyVolume: numericOrNull(targetWeeklyVolume),
      preferredRpe: numericOrNull(preferredRpe),
      includeStrength: includeStrength !== false,
      savedSessions,
      strengthExercises,
    };

    const planData = await aiService.generateTrainingPlan(
      {
        ...user,
        level: level || user?.experienceLevel || 'Intermedio',
        availability,
        currentDistance,
      },
      goalInput,
      parsedWeeks,
      competitionGoal?.simulations || []
    );

    const result = await prisma.$transaction(async (tx) => {
      await tx.userPlan.updateMany({
        where: { userId, isActive: true },
        data: { isActive: false },
      });

      const trainingPlan = await tx.trainingPlan.create({
        data: {
          name: planData.name || `Plan para ${goalInput.goal}`,
          description: planData.description || null,
          level: planData.level || level,
          weeks: parsedWeeks,
          sessions: {
            create: (planData.sessions || []).map((session) => ({
              week: Math.max(1, Math.min(parsedWeeks, parseInt(session.week, 10) || 1)),
              day: Math.max(1, Math.min(7, parseInt(session.day, 10) || 1)),
              name: session.name || 'Sesión de entrenamiento',
              description: session.description || null,
              rationale: session.rationale || defaultSessionRationale(session),
              targetMetric: session.targetMetric || null,
              targetValue: numericOrNull(session.targetValue),
            })),
          },
        },
      });

      const userPlan = await tx.userPlan.create({
        data: {
          userId,
          trainingPlanId: trainingPlan.id,
          competitionGoalId: competitionGoal?.id || null,
          goalSnapshot: goalInput,
          startDate: new Date(),
          isActive: true,
        },
        include: {
          plan: {
            include: { sessions: { orderBy: [{ week: 'asc' }, { day: 'asc' }] } },
          },
          competitionGoal: true,
        },
      });

      return { trainingPlan, userPlan };
    });

    res.json(result);
  } catch (error) {
    console.error('[GENERATE PLAN ERROR]', error);
    res.status(500).json({
      error: 'No pudimos generar tu plan ahora. Intentá de nuevo en unos minutos.',
    });
  }
};

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  getCurrentPlan,
  getTodaySession,
  updateSession,
  matchSession,
  regenerateWeek,
  logEffort,
  getEffortHistory,
  generatePlan
};
