const prisma = require('../lib/prisma');

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
    res.status(500).json({ error: 'Error al obtener plan de entrenamiento' });
  }
};

// Log de esfuerzo (RPE)
const logEffort = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityId, perceivedExertion, feeling, notes } = req.body;

    const effort = await prisma.effortLog.create({
      data: {
        userId,
        activityId,
        rpe: parseInt(perceivedExertion) || 5, // Rate of Perceived Exertion 1-10
        notes
      }
    });

    res.status(201).json(effort);
  } catch (error) {
    console.error('[LOG EFFORT ERROR]', error);
    res.status(500).json({ error: 'Error al registrar esfuerzo' });
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

    res.json(efforts);
  } catch (error) {
    console.error('[GET EFFORT HISTORY ERROR]', error);
    res.status(500).json({ error: 'Error al obtener historial de esfuerzo' });
  }
};

const aiService = require('../services/ai.service');

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
    } = req.body;

    if (!goal?.trim()) {
      return res.status(400).json({ error: 'El objetivo principal es requerido.' });
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
        return res.status(404).json({ error: 'Objetivo vinculado no encontrado.' });
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
    res.status(500).json({ error: 'Error al generar plan' });
  }
};

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  getCurrentPlan,
  logEffort,
  getEffortHistory,
  generatePlan
};
