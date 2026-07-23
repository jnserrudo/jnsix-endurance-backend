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
        }
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
      availability = '4 dias/semana', 
      currentDistance = 0 
    } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    // Generar JSON
    const planData = await aiService.generateTrainingPlan(
      { level, availability, currentDistance },
      goal,
      weeks
    );

    // Guardar en DB
    const trainingPlan = await prisma.trainingPlan.create({
      data: {
        name: planData.name,
        description: planData.description,
        level: planData.level,
        weeks: planData.weeks,
        sessions: {
          create: planData.sessions.map(s => ({
            week: s.week,
            day: s.day,
            name: s.name,
            description: s.description,
            targetMetric: s.targetMetric,
            targetValue: s.targetValue
          }))
        }
      }
    });

    // Asignar al usuario
    const userPlan = await prisma.userPlan.create({
      data: {
        userId,
        trainingPlanId: trainingPlan.id,
        startDate: new Date(),
        isActive: true
      }
    });

    res.json({ trainingPlan, userPlan });
  } catch (error) {
    console.error('[GENERATE PLAN ERROR]', error);
    res.status(500).json({ error: 'Error al generar plan' });
  }
};

module.exports = {
  getCurrentPlan,
  logEffort,
  getEffortHistory,
  generatePlan
};
