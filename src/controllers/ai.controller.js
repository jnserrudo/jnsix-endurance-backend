const { PrismaClient } = require('@prisma/client');
const aiService = require('../services/ai.service');

const prisma = new PrismaClient();

const analyzeActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { analysisType = 'GENERAL_INSIGHT', customPrompt } = req.body;

    const activity = await prisma.activity.findFirst({
      where: {
        id,
        OR: [
          { userId },
          { isExternal: true }
        ]
      },
      include: {
        laps: {
          orderBy: { splitNum: 'asc' }
        }
      }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const result = await aiService.analyzeActivity(activity, analysisType, customPrompt);

    const analysis = await prisma.aIAnalysis.create({
      data: {
        userId,
        activityId: id,
        type: analysisType,
        prompt: customPrompt || `Analysis type: ${analysisType}`,
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    res.json(analysis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const generateTrainingPlan = async (req, res) => {
  try {
    const userId = req.user.id;
    const { goal, weeks = 12, level = 'Intermedio', availability = '4-5 días/semana', currentDistance } = req.body;

    if (!goal) {
      return res.status(400).json({ error: 'Goal is required' });
    }

    const userProfile = {
      level,
      availability,
      currentDistance
    };

    const result = await aiService.generateTrainingPlan(userProfile, goal, weeks);

    const analysis = await prisma.aIAnalysis.create({
      data: {
        userId,
        type: 'TRAINING_RECOMMENDATION',
        prompt: `Generate training plan: ${goal}, ${weeks} weeks`,
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    res.json(analysis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getRaceStrategy = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityId, raceDistance, raceElevation, targetTime } = req.body;

    let activity = null;
    if (activityId) {
      activity = await prisma.activity.findFirst({
        where: {
          id: activityId,
          OR: [
            { userId },
            { isExternal: true }
          ]
        }
      });
    }

    const customPrompt = `
Genera una estrategia de carrera detallada para:
${activity ? `Basándote en la actividad: ${activity.name}` : ''}
Distancia de carrera: ${raceDistance} km
Desnivel: ${raceElevation} m
${targetTime ? `Tiempo objetivo: ${targetTime}` : ''}

Incluye:
1. Estrategia de ritmo por tramos
2. Gestión de energía y nutrición
3. Puntos clave del recorrido
4. Plan de hidratación
5. Estrategia mental
`;

    const result = await aiService.analyzeActivity(
      activity || { distanceKm: raceDistance, elevationM: raceElevation },
      'RACE_STRATEGY',
      customPrompt
    );

    const analysis = await prisma.aIAnalysis.create({
      data: {
        userId,
        activityId: activityId || null,
        type: 'RACE_STRATEGY',
        prompt: customPrompt,
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    res.json(analysis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const predictTime = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityId, targetDistance } = req.body;

    if (!activityId || !targetDistance) {
      return res.status(400).json({ error: 'Activity ID and target distance are required' });
    }

    const activity = await prisma.activity.findFirst({
      where: {
        id: activityId,
        OR: [
          { userId },
          { isExternal: true }
        ]
      }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const customPrompt = `
Basándote en esta actividad:
- Distancia: ${activity.distanceKm} km
- Tiempo: ${Math.floor(activity.movingTime / 60)} minutos
- Desnivel: ${activity.elevationM} m
- Ritmo promedio: ${(activity.movingTime / 60 / activity.distanceKm).toFixed(2)} min/km

Predice el tiempo para una carrera de ${targetDistance} km, considerando:
1. Ritmo sostenible para la distancia objetivo
2. Factor de fatiga
3. Condiciones del terreno
4. Margen de mejora realista
5. Rango de tiempo (mejor caso, caso probable, peor caso)
`;

    const result = await aiService.analyzeActivity(activity, 'TIME_PREDICTION', customPrompt);

    const analysis = await prisma.aIAnalysis.create({
      data: {
        userId,
        activityId,
        type: 'TIME_PREDICTION',
        prompt: customPrompt,
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    res.json(analysis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getAnalysisHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, type, activityId } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { userId };
    if (type) where.type = type;
    if (activityId) where.activityId = activityId;

    const analyses = await prisma.aIAnalysis.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        activity: {
          select: {
            id: true,
            name: true,
            type: true,
            distanceKm: true,
            startDate: true
          }
        }
      }
    });

    const total = await prisma.aIAnalysis.count({ where });

    res.json({
      analyses,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getUsageStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const totalAnalyses = await prisma.aIAnalysis.count({
      where: { userId }
    });

    const totalTokens = await prisma.aIAnalysis.aggregate({
      where: { userId },
      _sum: { tokensUsed: true }
    });

    const analysesByType = await prisma.aIAnalysis.groupBy({
      by: ['type'],
      where: { userId },
      _count: true
    });

    const recentAnalyses = await prisma.aIAnalysis.findMany({
      where: { userId },
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        createdAt: true,
        tokensUsed: true
      }
    });

    res.json({
      totalAnalyses,
      totalTokens: totalTokens._sum.tokensUsed || 0,
      analysesByType,
      recentAnalyses
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  analyzeActivity,
  generateTrainingPlan,
  getRaceStrategy,
  predictTime,
  getAnalysisHistory,
  getUsageStats
};
