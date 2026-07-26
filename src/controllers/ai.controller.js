const aiService = require('../services/ai.service');
const { APP_BRAND_BADGE } = require('../constants/brand');
const prisma = require('../lib/prisma');

/** Formatea zonas FC/ritmo/potencia del atleta para inyectar en prompts de IA. */
const formatAthleteZones = (user) => {
  if (!user) return '';
  const parts = [];
  if (user.hrZones) {
    parts.push(`Zonas de frecuencia cardíaca (hrZones): ${JSON.stringify(user.hrZones)}`);
  }
  if (user.paceZones) {
    parts.push(`Zonas de ritmo (paceZones): ${JSON.stringify(user.paceZones)}`);
  }
  if (user.powerZones) {
    parts.push(`Zonas de potencia (powerZones): ${JSON.stringify(user.powerZones)}`);
  }
  if (!parts.length) return '';
  return `\nZONAS DEL ATLETA (usá estas referencias al hablar de intensidad/esfuerzo):\n${parts.join('\n')}\n`;
};

const loadUserZones = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { hrZones: true, paceZones: true, powerZones: true },
  });
  return formatAthleteZones(user);
};

/** Anexa zonas al prompt; si no hay customPrompt, construye el prompt base + zonas. */
const withZonesPrompt = async (userId, activity, analysisType, customPrompt) => {
  const zonesBlock = await loadUserZones(userId);
  if (!zonesBlock) return customPrompt || null;
  const base = customPrompt || aiService.buildPrompt(activity, analysisType);
  return `${base}${zonesBlock}`;
};

const analyzeActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { analysisType = 'GENERAL_INSIGHT', customPrompt } = req.body;

    console.log('Analyze activity request:', { id, userId, analysisType });

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
      console.log('Activity not found:', id);
      return res.status(404).json({ error: 'No encontramos esa actividad.' });
    }

    console.log('Activity found, calling AI service...');
    const effectivePrompt = await withZonesPrompt(userId, activity, analysisType, customPrompt);
    const result = await aiService.analyzeActivity(activity, analysisType, effectivePrompt);
    console.log('AI service result:', { model: result.model, tokensUsed: result.tokensUsed });

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
    console.error('Error in analyzeActivity:', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const generateTrainingPlan = async (req, res) => {
  try {
    const userId = req.user.id;
    const { goal, weeks = 12, level = 'Intermedio', availability = '4-5 días/semana', currentDistance } = req.body;

    if (!goal) {
      return res.status(400).json({ error: 'Necesitamos un objetivo para continuar.' });
    }

    const zonesUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { hrZones: true, paceZones: true, powerZones: true },
    });

    const userProfile = {
      level,
      availability,
      currentDistance,
      hrZones: zonesUser?.hrZones || null,
      paceZones: zonesUser?.paceZones || null,
      powerZones: zonesUser?.powerZones || null,
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
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

Incluye secciones Markdown con ## (sin numeración) y viñetas (-):
- Estrategia de ritmo por tramos
- Gestión de energía y nutrición
- Puntos clave del recorrido
- Plan de hidratación
- Estrategia mental
`;

    const effectivePrompt = await withZonesPrompt(
      userId,
      activity || { distanceKm: raceDistance, elevationM: raceElevation },
      'RACE_STRATEGY',
      customPrompt
    );

    const result = await aiService.analyzeActivity(
      activity || { distanceKm: raceDistance, elevationM: raceElevation },
      'RACE_STRATEGY',
      effectivePrompt
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const predictTime = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityId, targetDistance } = req.body;

    if (!activityId || !targetDistance) {
      return res.status(400).json({ error: 'Faltan datos de la actividad o la distancia objetivo.' });
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
      return res.status(404).json({ error: 'No encontramos esa actividad.' });
    }

    // Obtener actividades históricas del usuario para mejor predicción
    const recentActivities = await prisma.activity.findMany({
      where: {
        userId,
        type: activity.type,
        distanceKm: { gte: targetDistance * 0.5, lte: targetDistance * 1.5 }
      },
      orderBy: { startDate: 'desc' },
      take: 10,
      select: {
        distanceKm: true,
        movingTime: true,
        elevationM: true
      }
    });

    const currentPace = activity.movingTime / 60 / activity.distanceKm;
    
    // Calcular estadísticas históricas
    const historicalPaces = recentActivities.map(a => a.movingTime / 60 / a.distanceKm);
    const avgHistoricalPace = historicalPaces.length > 0 
      ? historicalPaces.reduce((sum, p) => sum + p, 0) / historicalPaces.length 
      : currentPace;
    const bestPace = historicalPaces.length > 0 ? Math.min(...historicalPaces) : currentPace;

    // Fórmula de Riegel para predicción: T2 = T1 * (D2/D1)^1.06
    const riegelPrediction = activity.movingTime * Math.pow(targetDistance / activity.distanceKm, 1.06);
    const riegelPace = riegelPrediction / 60 / targetDistance;

    // Fórmula de Cameron: T2 = T1 * (D2/D1)^1.08 para distancias más largas
    const cameronPrediction = activity.movingTime * Math.pow(targetDistance / activity.distanceKm, 1.08);
    const cameronPace = cameronPrediction / 60 / targetDistance;

    const customPrompt = `
Analiza y predice el tiempo para una carrera de ${targetDistance} km basándote en datos REALES del usuario:

DATOS ACTUALES:
- Distancia de referencia: ${activity.distanceKm} km
- Tiempo actual: ${Math.floor(activity.movingTime / 60)} minutos (${formatTime(activity.movingTime)})
- Ritmo actual: ${currentPace.toFixed(2)} min/km
- Desnivel: ${activity.elevationM} m

HISTORIAL DEL USUARIO (${recentActivities.length} actividades similares):
- Ritmo promedio histórico: ${avgHistoricalPace.toFixed(2)} min/km
- Mejor ritmo histórico: ${bestPace.toFixed(2)} min/km

PREDICCIONES SEGÚN FÓRMULAS CIENTÍFICAS:
- Fórmula de Riegel: ${riegelPace.toFixed(2)} min/km (total: ${formatTime(riegelPrediction)})
- Fórmula de Cameron: ${cameronPace.toFixed(2)} min/km (total: ${formatTime(cameronPrediction)})

INSTRUCCIONES:
1. Usa las fórmulas de Riegel y Cameron como base (son fórmulas científicas validadas)
2. Ajusta según el historial real del usuario
3. Considera el factor de fatiga (exponente 1.06-1.08)
4. Para distancias más largas, el ritmo será MÁS LENTO (no más rápido)
5. Proporciona 3 escenarios:
   - Optimista: basado en mejor ritmo histórico + 5%
   - Realista: promedio de fórmulas Riegel/Cameron ajustado
   - Conservador: basado en ritmo promedio histórico + 10%
6. TODOS los tiempos deben ser HUMANOS y alcanzables
7. NO predigas tiempos más rápidos que el mejor ritmo del usuario
8. Formato de respuesta: "Tiempo estimado: X:XX:XX (X:XX min/km) - Escenario: [Optimista/Realista/Conservador]"

IMPORTANTE: Si el usuario corre a ${currentPace.toFixed(2)} min/km, NO puede correr ${targetDistance} km a un ritmo más rápido. El ritmo DEBE ser más lento para distancias más largas.
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

const getAnalysisHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, type, activityId, competitionGoalId } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { userId };
    if (type) where.type = type;
    if (activityId) where.activityId = activityId;
    if (competitionGoalId) where.competitionGoalId = competitionGoalId;

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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const MONTHLY_AI_LIMITS = { FREE: 20, PRO: 200 };

const resolveMonthlyAiLimit = (subscriptionTier) => {
  const tier = String(subscriptionTier || 'FREE').toUpperCase();
  if (tier === 'FREE') return MONTHLY_AI_LIMITS.FREE;
  return MONTHLY_AI_LIMITS.PRO;
};

const getUsageStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionTier: true },
    });

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [used, totalAnalyses, totalTokens, analysesByType, recentAnalyses] = await Promise.all([
      prisma.aIAnalysis.count({
        where: { userId, createdAt: { gte: startOfMonth } },
      }),
      prisma.aIAnalysis.count({ where: { userId } }),
      prisma.aIAnalysis.aggregate({
        where: { userId },
        _sum: { tokensUsed: true },
      }),
      prisma.aIAnalysis.groupBy({
        by: ['type'],
        where: { userId },
        _count: true,
      }),
      prisma.aIAnalysis.findMany({
        where: { userId },
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          createdAt: true,
          tokensUsed: true,
        },
      }),
    ]);

    const limit = resolveMonthlyAiLimit(user?.subscriptionTier);
    const remaining = Math.max(0, limit - used);

    res.json({
      used,
      limit,
      remaining,
      tier: user?.subscriptionTier || 'FREE',
      totalAnalyses,
      totalTokens: totalTokens._sum.tokensUsed || 0,
      analysesByType,
      recentAnalyses,
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const analyzeMultipleActivities = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityIds, analysisType = 'PERFORMANCE_ANALYSIS' } = req.body;

    if (!activityIds || !Array.isArray(activityIds) || activityIds.length === 0) {
      return res.status(400).json({ error: 'Elegí al menos una actividad.' });
    }

    const activities = await prisma.activity.findMany({
      where: {
        id: { in: activityIds },
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

    if (activities.length === 0) {
      return res.status(404).json({ error: 'No encontramos actividades para analizar.' });
    }

    const customPrompt = `
Analiza el siguiente conjunto de ${activities.length} actividades:

${activities.map((a, i) => `
Actividad ${i + 1}: ${a.name}
Tipo: ${a.type}
Distancia: ${a.distanceKm.toFixed(2)} km
Desnivel: ${a.elevationM.toFixed(0)} m
Tiempo: ${Math.floor(a.movingTime / 60)} minutos
Ritmo promedio: ${(a.movingTime / 60 / a.distanceKm).toFixed(2)} min/km
${a.averageHr ? `FC promedio: ${a.averageHr} bpm` : ''}
${a.maxHr ? `FC máxima: ${a.maxHr} bpm` : ''}
Fecha: ${a.startDate.toISOString().split('T')[0]}
`).join('\n')}

Responde en Markdown móvil: secciones ## sin numerar y viñetas (-):
- Análisis comparativo entre las actividades
- Tendencias y patrones observados
- Puntos fuertes y áreas de mejora
- Progresión del rendimiento
- Recomendaciones específicas basadas en el conjunto
`;

    const result = await aiService.analyzeActivity(
      { distanceKm: activities.reduce((sum, a) => sum + a.distanceKm, 0), elevationM: activities.reduce((sum, a) => sum + a.elevationM, 0) },
      analysisType,
      customPrompt
    );

    const analysis = await prisma.aIAnalysis.create({
      data: {
        userId,
        type: analysisType,
        prompt: customPrompt,
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    res.json(analysis);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const compareActivities = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityIds } = req.body;

    if (!activityIds || !Array.isArray(activityIds) || activityIds.length < 2) {
      return res.status(400).json({ error: 'Elegí al menos 2 actividades.' });
    }

    const activities = await prisma.activity.findMany({
      where: {
        id: { in: activityIds },
        OR: [
          { userId },
          { isExternal: true }
        ]
      }
    });

    if (activities.length < 2) {
      return res.status(404).json({ error: 'Elegí al menos 2 actividades.' });
    }

    const customPrompt = `
Compara detalladamente las siguientes actividades:

${activities.map((a, i) => `
Actividad ${i + 1}: ${a.name}
Tipo: ${a.type}
Distancia: ${a.distanceKm.toFixed(2)} km
Desnivel: ${a.elevationM.toFixed(0)} m
Tiempo: ${Math.floor(a.movingTime / 60)} minutos
Ritmo: ${(a.movingTime / 60 / a.distanceKm).toFixed(2)} min/km
${a.averageHr ? `FC: ${a.averageHr} bpm` : ''}
`).join('\n')}

Responde en Markdown móvil: secciones ## sin numerar y viñetas (-):
- Comparación directa de rendimiento
- Diferencias en ritmo y esfuerzo
- Factores que explicaron las diferencias
- Lecciones aprendidas de cada actividad
- Recomendaciones para futuras sesiones
`;

    const result = await aiService.analyzeActivity(
      activities[0],
      'PERFORMANCE_ANALYSIS',
      customPrompt
    );

    const analysis = await prisma.aIAnalysis.create({
      data: {
        userId,
        type: 'PERFORMANCE_ANALYSIS',
        prompt: customPrompt,
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    res.json(analysis);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const analyzeTrends = async (req, res) => {
  try {
    const userId = req.user.id;
    const { days = 30 } = req.body;

    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const activities = await prisma.activity.findMany({
      where: {
        userId,
        startDate: { gte: dateFrom }
      },
      orderBy: { startDate: 'asc' },
      include: {
        laps: {
          orderBy: { splitNum: 'asc' }
        }
      }
    });

    if (activities.length === 0) {
      return res.status(404).json({ error: 'No hay actividades en ese período.' });
    }

    const customPrompt = `
Analiza las tendencias de rendimiento de los últimos ${days} días basándote en ${activities.length} actividades:

Resumen del período:
- Total de actividades: ${activities.length}
- Distancia total: ${activities.reduce((sum, a) => sum + a.distanceKm, 0).toFixed(2)} km
- Tiempo total: ${Math.floor(activities.reduce((sum, a) => sum + a.movingTime, 0) / 60)} minutos
- Distancia promedio: ${(activities.reduce((sum, a) => sum + a.distanceKm, 0) / activities.length).toFixed(2)} km
- Ritmo promedio: ${(activities.reduce((sum, a) => sum + (a.movingTime / 60 / a.distanceKm), 0) / activities.length).toFixed(2)} min/km

Responde en Markdown móvil: secciones ## sin numerar y viñetas (-):
- Tendencias de progreso o estancamiento
- Patrones de rendimiento semanal
- Variaciones en ritmo y esfuerzo
- Áreas de mejora identificadas
- Recomendaciones para el próximo período
- Objetivos realistas basados en las tendencias
`;

    const result = await aiService.analyzeActivity(
      { distanceKm: activities.reduce((sum, a) => sum + a.distanceKm, 0) },
      'PERFORMANCE_ANALYSIS',
      customPrompt
    );

    const analysis = await prisma.aIAnalysis.create({
      data: {
        userId,
        type: 'PERFORMANCE_ANALYSIS',
        prompt: customPrompt,
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    res.json(analysis);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const DISCIPLINE_TONES = {
  trail: `Tono disciplina TRAIL: priorizá desnivel, fuerza de piernas, técnica de bajada, gestión de fatiga en ultra/trail y nutrición de montaña.`,
  tri: `Tono disciplina TRIATLÓN: equilibrá natación, bici y carrera; hablá de transiciones, brick, distribución de carga y recuperación entre disciplinas.`,
  '10k': `Tono disciplina 10K / ruta: enfocá ritmo, umbral, series, economía de carrera y progresión de volumen en asfalto.`,
  ride: `Tono disciplina CICLISMO: priorizá potencia/FTP, zonas de esfuerzo, cadencia, volumen en bici y recuperación muscular específica.`,
};

const resolveDisciplineTone = (primarySport) => {
  const s = String(primarySport || '').toUpperCase();
  if (s.includes('TRAIL')) return 'trail';
  if (s.includes('TRI') || s.includes('SWIM') || s.includes('NATAC')) return 'tri';
  if (s.includes('RIDE') || s.includes('BIKE') || s.includes('CICL') || s.includes('CYCL')) return 'ride';
  return '10k';
};

const formatCoachMemory = (coachMemory) => {
  if (!coachMemory || typeof coachMemory !== 'object') return 'Sin memoria del coach guardada.';
  try {
    const entries = Object.entries(coachMemory)
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
      .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return entries.length ? entries.join('\n') : 'Sin memoria del coach guardada.';
  } catch {
    return 'Sin memoria del coach guardada.';
  }
};

const chatWithCoach = async (req, res) => {
  try {
    const userId = req.user.id;
    let { messages, message, mode, conversationId, activityId } = req.body;
    const chatMode = mode === 'chat' ? 'chat' : 'coach';

    if (!messages && !message) {
      return res.status(400).json({ error: 'Escribí un mensaje para continuar.' });
    }

    if (!messages && message) {
      messages = [{ role: 'user', content: message }];
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Escribí un mensaje para continuar.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        coachMemory: true,
        primarySport: true,
        experienceLevel: true,
        firstName: true,
        hrZones: true,
        paceZones: true,
        powerZones: true,
      },
    });

    const zonesBlock = formatAthleteZones(user);

    let existingConversation = null;
    if (conversationId) {
      existingConversation = await prisma.aIConversation.findFirst({
        where: { id: conversationId, userId },
      });
      if (!existingConversation) {
        return res.status(404).json({ error: 'No encontramos esa conversación.' });
      }
    }

    const recentActivities = await prisma.activity.findMany({
      where: { userId },
      orderBy: { startDate: 'desc' },
      take: 15,
      select: {
        name: true,
        type: true,
        distanceKm: true,
        elevationM: true,
        movingTime: true,
        startDate: true,
        averageHr: true,
        maxHr: true,
      },
    });

    const activitiesSummary = recentActivities
      .map(
        (a) =>
          `- Fecha: ${a.startDate.toISOString().split('T')[0]} | Nombre: ${a.name} | Tipo: ${a.type} | Distancia: ${a.distanceKm.toFixed(2)} km | Desnivel: ${Math.round(a.elevationM)}m | Tiempo: ${Math.floor(a.movingTime / 60)}m ${a.movingTime % 60}s | FC Promedio: ${a.averageHr || 'N/A'} bpm`
      )
      .join('\n');

    let anchoredActivityBlock = '';
    if (activityId) {
      const activity = await prisma.activity.findFirst({
        where: {
          id: activityId,
          OR: [{ userId }, { isExternal: true }],
        },
        include: {
          laps: { orderBy: { splitNum: 'asc' }, take: 20 },
        },
      });
      if (activity) {
        const pace =
          activity.distanceKm > 0
            ? (activity.movingTime / 60 / activity.distanceKm).toFixed(2)
            : 'N/A';
        anchoredActivityBlock = `
ACTIVIDAD ANCLA (analizá prioritariamente esta sesión):
- Nombre: ${activity.name}
- Tipo: ${activity.type}
- Distancia: ${activity.distanceKm.toFixed(2)} km
- Desnivel: ${Math.round(activity.elevationM || 0)} m
- Tiempo: ${formatTime(activity.movingTime)}
- Ritmo: ${pace} min/km
- FC prom/máx: ${activity.averageHr || 'N/A'} / ${activity.maxHr || 'N/A'} bpm
- Splits: ${
          activity.laps?.length
            ? activity.laps
                .map((l) => `Km ${l.splitNum}: ${Number(l.averagePace || 0).toFixed(2)} min/km`)
                .join('; ')
            : 'Sin splits'
        }
`;
      }
    }

    const disciplineKey = resolveDisciplineTone(user?.primarySport);
    const disciplineTone = DISCIPLINE_TONES[disciplineKey];
    const memoryBlock = formatCoachMemory(user?.coachMemory);
    const athleteName = user?.firstName || 'Atleta';

    const systemPrompt =
      chatMode === 'chat'
        ? `Eres ${APP_BRAND_BADGE} AI Coach en modo conversación amigable con ${athleteName}.
Podés saludar, motivar y charlar con naturalidad. Si el atleta pregunta por entrenamiento, usá su historial reciente con criterio.
No fuerces un análisis técnico si solo está saludando o haciendo una pregunta casual.
${disciplineTone}
Memoria del coach (lesiones, preferencias, contexto persistente):
${memoryBlock}
${zonesBlock}
Historial reciente (solo si hace falta):
${activitiesSummary || 'Sin actividades aún.'}
${anchoredActivityBlock}
Respuestas cortas en Markdown legible en móvil. Sin emojis. Español rioplatense.`
        : `Eres ${APP_BRAND_BADGE} AI Coach, entrenador personal experto en triatlón, ciclismo, trail running y natación.
Atleta: ${athleteName}. Nivel: ${user?.experienceLevel || 'No especificado'}. Deporte principal: ${user?.primarySport || 'No especificado'}.
${disciplineTone}

Memoria del coach (respetá lesiones, preferencias y restricciones):
${memoryBlock}
${zonesBlock}

Historial reciente (últimas 15 actividades):
${activitiesSummary || 'El atleta no tiene actividades registradas todavía.'}
${anchoredActivityBlock}

Usá este contexto para fatiga, ritmos, recuperación y planificación.
Si preguntan algo fuera de entrenamiento, redirigilos amablemente.
Markdown móvil: ## sin numerar, viñetas (-), párrafos breves. Sin emojis. Español.`;

    const result = await aiService.chatWithCoach(systemPrompt, messages);

    const updatedMessages = [
      ...messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || ''),
      })),
      { role: 'assistant', content: result.response },
    ];

    const firstUserMsg = updatedMessages.find((m) => m.role === 'user')?.content || 'Chat con Coach';
    const title =
      existingConversation?.title ||
      (firstUserMsg.length > 60 ? `${firstUserMsg.slice(0, 57)}...` : firstUserMsg);

    const conversation = existingConversation
      ? await prisma.aIConversation.update({
          where: { id: existingConversation.id },
          data: { messages: updatedMessages, mode: chatMode, title },
        })
      : await prisma.aIConversation.create({
          data: {
            userId,
            mode: chatMode,
            title,
            messages: updatedMessages,
          },
        });

    await prisma.aIAnalysis.create({
      data: {
        userId,
        activityId: activityId || null,
        type: 'GENERAL_INSIGHT',
        prompt: messages[messages.length - 1]?.content || 'Chat con el Coach',
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed,
      },
    });

    res.json({
      response: result.response,
      conversationId: conversation.id,
      mode: chatMode,
    });
  } catch (error) {
    console.error('Error in chatWithCoach:', error);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const listConversations = async (req, res) => {
  try {
    const userId = req.user.id;
    const { q, mode } = req.query;
    const search = (typeof q === 'string' ? q.trim() : '').toLowerCase();
    const modeFilter = typeof mode === 'string' ? mode.trim().toLowerCase() : '';

    const [conversations, allCount, coachCount, chatCount] = await Promise.all([
      prisma.aIConversation.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        // Con búsqueda traemos más registros para poder filtrar por contenido
        // (los mensajes están en un campo JSON, no consultable directamente).
        take: search ? 200 : 100,
        select: {
          id: true,
          mode: true,
          title: true,
          messages: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.aIConversation.count({ where: { userId } }),
      prisma.aIConversation.count({ where: { userId, mode: { not: 'chat' } } }),
      prisma.aIConversation.count({ where: { userId, mode: 'chat' } }),
    ]);

    const mapped = conversations.map((c) => {
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const last = msgs[msgs.length - 1];
      const title = c.title || 'Conversación';
      const haystack = [
        title,
        ...msgs.map((m) => String(m?.content || '')),
      ]
        .join('\n')
        .toLowerCase();
      const normalizedMode = c.mode === 'chat' ? 'chat' : 'coach';
      return {
        id: c.id,
        mode: normalizedMode,
        title,
        preview: last?.content ? String(last.content).slice(0, 120) : '',
        messageCount: msgs.length,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        _haystack: haystack,
      };
    });

    let filtered = search ? mapped.filter((c) => c._haystack.includes(search)) : mapped;
    if (modeFilter === 'chat') {
      filtered = filtered.filter((c) => c.mode === 'chat');
    } else if (modeFilter === 'coach') {
      filtered = filtered.filter((c) => c.mode === 'coach');
    }

    const conversationsOut = filtered.slice(0, 50).map(({ _haystack, ...c }) => c);

    res.json({
      conversations: conversationsOut,
      counts: {
        all: allCount,
        coach: coachCount,
        chat: chatCount,
      },
    });
  } catch (error) {
    console.error('[ERROR] listConversations:', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const getConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const conversation = await prisma.aIConversation.findFirst({
      where: { id, userId },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'No encontramos esa conversación.' });
    }
    res.json(conversation);
  } catch (error) {
    console.error('[ERROR] getConversation:', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const deleteConversation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const conversation = await prisma.aIConversation.findFirst({
      where: { id, userId },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'No encontramos esa conversación.' });
    }
    await prisma.aIConversation.delete({ where: { id } });
    res.json({ ok: true });
  } catch (error) {
    console.error('[ERROR] deleteConversation:', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const predictRace = async (req, res) => {
  try {
    const userId = req.user.id;
    const { competitionGoalId } = req.query;

    if (!competitionGoalId) {
      return res.status(400).json({ error: 'Indicá el objetivo de competencia.' });
    }

    const competition = await prisma.competitionGoal.findFirst({
      where: { id: competitionGoalId, userId },
    });
    if (!competition) {
      return res.status(404).json({ error: 'No encontramos esa competencia.' });
    }

    const runTypes = ['RUN', 'TRAIL_RUN', 'VIRTUAL_RUN'];
    const recentRuns = await prisma.activity.findMany({
      where: {
        userId,
        type: { in: runTypes },
        distanceKm: { gte: 3 },
        movingTime: { gt: 0 },
      },
      orderBy: { startDate: 'desc' },
      take: 20,
      select: {
        id: true,
        name: true,
        type: true,
        distanceKm: true,
        movingTime: true,
        elevationM: true,
        startDate: true,
      },
    });

    if (recentRuns.length === 0) {
      return res.json({
        competitionGoalId,
        prediction: null,
        text: 'Todavía no hay carreras recientes suficientes para estimar un tiempo. Sumá unos fondos o tempo y volvé a consultar.',
        method: null,
      });
    }

    const withPace = recentRuns.map((r) => ({
      ...r,
      paceMinPerKm: r.movingTime / 60 / r.distanceKm,
    }));
    withPace.sort((a, b) => a.paceMinPerKm - b.paceMinPerKm);
    const best = withPace[0];
    const top3 = withPace.slice(0, Math.min(3, withPace.length));
    const avgBestPace =
      top3.reduce((s, r) => s + r.paceMinPerKm, 0) / top3.length;

    // Extrapolación tipo Riegel / Daniels simplificada: T2 = T1 * (D2/D1)^1.06
    const refDistance = best.distanceKm;
    const refTime = best.movingTime;
    const targetDistance = competition.distanceKm || refDistance;
    const riegelSeconds = refTime * Math.pow(targetDistance / refDistance, 1.06);

    // Ajuste por desnivel (heurística ~ +3% por cada 100 m extra relativos al km)
    const elevPerKm = (competition.elevationM || 0) / Math.max(targetDistance, 0.1);
    const elevFactor = 1 + Math.min(0.25, (elevPerKm / 100) * 0.03);
    const adjustedSeconds = riegelSeconds * elevFactor;

    // Escenarios
    const optimistic = adjustedSeconds * 0.97;
    const realistic = adjustedSeconds;
    const conservative = adjustedSeconds * 1.06;

    const fmt = (sec) => formatTime(Math.round(sec));
    const paceOf = (sec) => (sec / 60 / targetDistance).toFixed(2);

    const text = `## Predicción para ${competition.name}

Basado en ${recentRuns.length} corridas recientes (mejor referencia: ${best.name}, ${best.distanceKm.toFixed(1)} km a ${best.paceMinPerKm.toFixed(2)} min/km). Método: extrapolación Riegel (exponente 1.06) con ajuste por desnivel.

- **Optimista:** ${fmt(optimistic)} (${paceOf(optimistic)} min/km)
- **Realista:** ${fmt(realistic)} (${paceOf(realistic)} min/km)
- **Conservador:** ${fmt(conservative)} (${paceOf(conservative)} min/km)

Ritmo promedio de tus 3 mejores recientes: ${avgBestPace.toFixed(2)} min/km. Usá el escenario realista como referencia de pacing; si el terreno es técnico o hay mucho desnivel, acercate al conservador.`;

    res.json({
      competitionGoalId,
      targetDistanceKm: targetDistance,
      targetElevationM: competition.elevationM || 0,
      referenceActivity: {
        id: best.id,
        name: best.name,
        distanceKm: best.distanceKm,
        paceMinPerKm: Number(best.paceMinPerKm.toFixed(2)),
      },
      prediction: {
        optimisticSeconds: Math.round(optimistic),
        realisticSeconds: Math.round(realistic),
        conservativeSeconds: Math.round(conservative),
        optimistic: fmt(optimistic),
        realistic: fmt(realistic),
        conservative: fmt(conservative),
        realisticPaceMinPerKm: Number(paceOf(realistic)),
      },
      text,
      method: 'riegel_elevation_adjusted',
    });
  } catch (error) {
    console.error('[ERROR] predictRace:', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

// Escapa texto según RFC 5545 (comas, punto y coma, backslash y saltos de línea).
const escapeIcs = (value) =>
  String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

// Formatea una fecha como valor DATE de ICS (YYYYMMDD) en horario local del plan.
const toIcsDate = (date) => {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
};

const toIcsStamp = (date) => {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(
    d.getUTCHours()
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

const buildPlanIcs = (plan, userPlan) => {
  const startDate = new Date(userPlan.startDate || Date.now());
  startDate.setHours(0, 0, 0, 0);
  const stamp = toIcsStamp(new Date());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${APP_BRAND_BADGE}//Plan de entrenamiento//ES`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(plan.name)}`,
  ];

  for (const session of plan.sessions) {
    const offsetDays = (Math.max(1, session.week) - 1) * 7 + (Math.max(1, session.day) - 1);
    const sessionDate = new Date(startDate);
    sessionDate.setDate(sessionDate.getDate() + offsetDays);
    const endDate = new Date(sessionDate);
    endDate.setDate(endDate.getDate() + 1);

    const descParts = [];
    if (session.description) descParts.push(session.description);
    if (session.targetMetric && session.targetValue != null) {
      const unit = session.targetMetric === 'DISTANCE' ? 'km' : 'min';
      descParts.push(`Objetivo: ${session.targetValue} ${unit}`);
    }
    if (session.rationale) descParts.push(`Por qué: ${session.rationale}`);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${session.id}@jnsix-endurance`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(sessionDate)}`);
    lines.push(`DTEND;VALUE=DATE:${toIcsDate(endDate)}`);
    lines.push(`SUMMARY:${escapeIcs(`Sem ${session.week} · ${session.name}`)}`);
    if (descParts.length) lines.push(`DESCRIPTION:${escapeIcs(descParts.join('\n'))}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  // ICS usa CRLF como separador de línea.
  return lines.join('\r\n');
};

const exportPlan = async (req, res) => {
  try {
    const userId = req.user.id;
    const { userPlanId } = req.params;
    const format = String(req.query.format || '').toLowerCase();

    const userPlan = await prisma.userPlan.findFirst({
      where: { id: userPlanId, userId },
      include: {
        plan: {
          include: {
            sessions: { orderBy: [{ week: 'asc' }, { day: 'asc' }] },
          },
        },
        competitionGoal: { select: { name: true, targetDate: true, distanceKm: true } },
      },
    });

    if (!userPlan || !userPlan.plan) {
      return res.status(404).json({ error: 'No encontramos ese plan.' });
    }

    if (format === 'ics') {
      const ics = buildPlanIcs(userPlan.plan, userPlan);
      const safeName = String(userPlan.plan.name || 'plan')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'plan';
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.ics"`);
      return res.status(200).send(ics);
    }

    const plan = userPlan.plan;
    const lines = [];
    lines.push(`# ${plan.name}`);
    lines.push('');
    if (plan.description) {
      lines.push(plan.description);
      lines.push('');
    }
    lines.push(`- Nivel: ${plan.level}`);
    lines.push(`- Semanas: ${plan.weeks}`);
    lines.push(`- Inicio: ${new Date(userPlan.startDate).toLocaleDateString('es-AR')}`);
    if (userPlan.competitionGoal) {
      lines.push(
        `- Objetivo: ${userPlan.competitionGoal.name}${
          userPlan.competitionGoal.distanceKm
            ? ` (${userPlan.competitionGoal.distanceKm} km)`
            : ''
        }`
      );
    }
    lines.push('');

    let currentWeek = null;
    for (const session of plan.sessions) {
      if (session.week !== currentWeek) {
        currentWeek = session.week;
        lines.push(`## Semana ${currentWeek}`);
        lines.push('');
      }
      lines.push(`### Día ${session.day}: ${session.name}`);
      if (session.description) lines.push(session.description);
      if (session.targetMetric && session.targetValue != null) {
        const unit = session.targetMetric === 'DISTANCE' ? 'km' : 'min';
        lines.push(`- Objetivo: ${session.targetValue} ${unit}`);
      }
      if (session.rationale) lines.push(`- Por qué: ${session.rationale}`);
      lines.push(`- Estado: ${session.status || 'PENDING'}`);
      lines.push('');
    }

    lines.push('---');
    lines.push(`Exportado desde ${APP_BRAND_BADGE}`);

    const markdown = lines.join('\n');
    res.json({
      userPlanId,
      planName: plan.name,
      markdown,
      text: markdown,
      format: 'markdown',
    });
  } catch (error) {
    console.error('[ERROR] exportPlan:', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const analyzeCompetitionGoal = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params; // Competition ID

    // 1. Recuperar la competencia con sus simulaciones asociadas
    const competition = await prisma.competitionGoal.findFirst({
      where: { id, userId },
      include: {
        simulations: {
          include: {
            laps: {
              orderBy: { splitNum: 'asc' }
            }
          }
        }
      }
    });

    if (!competition) {
      return res.status(404).json({ error: 'No encontramos esa competencia.' });
    }

    // 2. Obtener las últimas 10 actividades para el contexto del historial
    const recentActivities = await prisma.activity.findMany({
      where: { userId },
      orderBy: { startDate: 'desc' },
      take: 10,
      select: {
        name: true,
        type: true,
        distanceKm: true,
        elevationM: true,
        movingTime: true,
        startDate: true,
        averageHr: true
      }
    });

    const activitiesSummary = recentActivities.map(a => 
      `- ${a.startDate.toISOString().split('T')[0]} | ${a.name} | ${a.type} | ${a.distanceKm.toFixed(1)}km | +${Math.round(a.elevationM)}m | ${Math.floor(a.movingTime/60)}m | FC: ${a.averageHr || 'N/A'}`
    ).join('\n');

    // 3. Resumir entrenamientos de simulación específicamente seleccionados
    const simulationsSummary = competition.simulations.map((s, idx) => {
      const pace = s.distanceKm > 0 ? (s.movingTime / 60) / s.distanceKm : 0;
      let minP = Math.floor(pace);
      let secP = Math.round((pace - minP) * 60);
      if (secP === 60) { minP += 1; secP = 0; }
      const formattedPace = `${minP}:${secP.toString().padStart(2, '0')}`;

      return `[Simulación #${idx+1}]
- Nombre: ${s.name}
- Tipo: ${s.type}
- Distancia Realizada: ${s.distanceKm.toFixed(2)} km
- Desnivel Realizado: ${Math.round(s.elevationM)}m
- Tiempo: ${Math.floor(s.movingTime/60)}m ${s.movingTime%60}s
- Ritmo Promedio: ${formattedPace} min/km
- FC Promedio: ${s.averageHr || 'N/A'} bpm
- Detalle por kilómetro (splits): ${s.laps.map(l => `\n  * Km ${l.splitNum}: ${l.distance.toFixed(2)}km en pace ${l.averagePace.toFixed(2)} min/km (FC: ${l.averageHr || 'N/A'})`).join('')}`;
    }).join('\n\n');

    const zonesBlock = await loadUserZones(userId);
    const systemPrompt = `Eres ${APP_BRAND_BADGE} AI Strategy Coach, un director deportivo e ingeniero de rendimiento experto en planificación, ritmo (pacing) y nutrición de ultra-distancia, trail running, ciclismo y triatlón.
Tu tarea es analizar el objetivo de competencia del atleta frente a su historial deportivo y sus entrenamientos de simulación específicos elegidos por él. Entregarás un reporte extremadamente profesional, motivador y con base científica en Markdown.
${zonesBlock}`;

    const userPrompt = `Analiza mi preparación para la siguiente competencia objetivo:

COMPETENCIA OBJETIVO:
- Nombre: ${competition.name}
- Disciplina: ${competition.type}
- Distancia Objetivo: ${competition.distanceKm} km
- Desnivel Objetivo: ${competition.elevationM} m
- Tipo de Terreno/Dificultad: ${competition.terrainType || 'No especificado'}
- Fecha del Evento: ${competition.targetDate.toISOString().split('T')[0]}
- Tiempo Objetivo de Carrera: ${competition.targetTime || 'Sin tiempo objetivo'}
- Notas Adicionales: ${competition.notes || 'Ninguna'}

MI HISTORIAL DE ENTRENAMIENTO RECIENTE (Últimas 10 sesiones):
${activitiesSummary || 'Sin historial reciente cargado.'}

ENTRENAMIENTOS DE SIMULACIÓN ESPECÍFICOS QUE HE SELECCIONADO PARA ESTA CARRERA:
${simulationsSummary || 'No he seleccionado simulaciones específicas todavía.'}

Por favor, estructura tu reporte en estas secciones exactas (títulos ## sin numerar), legibles en móvil:

## Evaluación de preparación y confianza
- Compara distancias y desniveles de mis entrenamientos (historial y simulaciones) frente a la competencia.
- Estima mi confianza y preparación (1-10) y justifica.

## Estrategia de ritmo y pendientes
- Cómo distribuir el esfuerzo (conservadora, negativa, regular).
- Pautas de ritmo/esfuerzo según pendiente (trail, bici, etc.).

## Plan de nutrición e hidratación
- Gramos de carbohidratos por hora según distancia/duración estimada.
- Hidratación y sodio según el esfuerzo.
- Carga de carbohidratos 36 h previas.

## Planificación de descarga
- Guía de tapering 2-3 semanas (porcentajes de volumen/intensidad).

## Consejos tácticos y mentales
- Tres consejos clave para el terreno/disciplina (como viñetas, sin numerar).

Reglas de formato: Markdown limpio, ## sin números, viñetas con -, sin emojis, respuestas compactas.`;

    const result = await aiService.chatWithCoach(systemPrompt, [{ role: 'user', content: userPrompt }]);

    // 5. Registrar el análisis en la base de datos
    const analysis = await prisma.aIAnalysis.create({
      data: {
        userId,
        competitionGoalId: id,
        type: 'COMPETITION_STRATEGY',
        prompt: `Analizar competencia: ${competition.name} (ID: ${id})`,
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    if (!result.response || !String(result.response).trim()) {
      return res.status(502).json({
        error: 'La estrategia quedó vacía. Intentá analizar de nuevo en unos minutos.',
      });
    }

    res.json(analysis);
  } catch (error) {
    console.error('[ERROR] [ANALYZE COMPETITION AI] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

/**
 * Sugiere ejercicios de fuerza/movilidad complementarios en base a la ultima
 * actividad de resistencia del usuario. Logica basada en reglas (sin LLM)
 * para respuesta instantanea y costo cero.
 */
const RULES_BY_TYPE = {
  RUN: { categories: ['upper legs', 'waist'], targets: ['glutes', 'abs', 'hamstrings'] },
  TRAIL_RUN: { categories: ['upper legs', 'lower legs'], targets: ['glutes', 'calves', 'quadriceps'] },
  HIKE: { categories: ['upper legs', 'lower legs'], targets: ['glutes', 'calves'] },
  RIDE: { categories: ['upper legs', 'back'], targets: ['quadriceps', 'lower back'] },
  VIRTUAL_RIDE: { categories: ['upper legs', 'back'], targets: ['quadriceps', 'lower back'] },
  SWIM: { categories: ['shoulders', 'back'], targets: ['delts', 'lats'] },
  WALK: { categories: ['waist'], targets: ['abs'] },
  VIRTUAL_RUN: { categories: ['upper legs', 'waist'], targets: ['glutes', 'abs'] },
  OTHER: { categories: ['waist'], targets: ['abs'] }
};

const suggestComplementaryExercises = async (req, res) => {
  try {
    const userId = req.user.id;

    const lastActivity = await prisma.activity.findFirst({
      where: { userId },
      orderBy: { startDate: 'desc' }
    });

    const rule = (lastActivity && RULES_BY_TYPE[lastActivity.type]) || RULES_BY_TYPE.RUN;
    const isLongSession = lastActivity ? (lastActivity.movingTime || 0) > 3600 : false;

    const exercises = await prisma.exercise.findMany({
      where: {
        OR: [
          { category: { in: rule.categories } },
          { target: { in: rule.targets } }
        ],
        equipment: isLongSession ? undefined : 'body weight'
      },
      take: 6,
      select: {
        id: true,
        name: true,
        category: true,
        target: true,
        equipment: true,
        image: true,
        gifUrl: true
      }
    });

    res.json({
      basedOnActivity: lastActivity ? { id: lastActivity.id, type: lastActivity.type, name: lastActivity.name } : null,
      exercises
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

/**
 * Briefing diario corto (reglas): carga aguda/crónica, racha y plan activo.
 */
const getDailyBriefing = async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const dayMs = 7 * 24 * 60 * 60 * 1000;
    const acuteFrom = new Date(now.getTime() - dayMs);
    const chronicFrom = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

    const [acuteActs, chronicActs, recentForStreak, activeUserPlan] = await Promise.all([
      prisma.activity.findMany({
        where: { userId, startDate: { gte: acuteFrom } },
        select: { distanceKm: true, movingTime: true },
      }),
      prisma.activity.findMany({
        where: { userId, startDate: { gte: chronicFrom } },
        select: { distanceKm: true },
      }),
      prisma.activity.findMany({
        where: { userId },
        select: { startDate: true },
        orderBy: { startDate: 'desc' },
        take: 120,
      }),
      prisma.userPlan.findFirst({
        where: { userId, isActive: true, completed: false },
        include: { plan: { select: { name: true } } },
      }),
    ]);

    const acuteKm = acuteActs.reduce((s, a) => s + (Number(a.distanceKm) || 0), 0);
    const chronicKm = chronicActs.reduce((s, a) => s + (Number(a.distanceKm) || 0), 0);
    const chronicWeeklyAvg = chronicKm / 4 || 0.1;
    const acwr = acuteKm / chronicWeeklyAvg;

    let streak = 0;
    const uniqueDays = [
      ...new Set(
        recentForStreak.map((a) => {
          const d = new Date(a.startDate);
          d.setHours(0, 0, 0, 0);
          return d.getTime();
        })
      ),
    ].sort((a, b) => b - a);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const oneDay = 24 * 60 * 60 * 1000;
    let cursor = today.getTime();
    if (uniqueDays[0] === cursor || uniqueDays[0] === cursor - oneDay) {
      cursor = uniqueDays[0];
      for (const day of uniqueDays) {
        if (day === cursor) {
          streak++;
          cursor -= oneDay;
        } else if (day < cursor) break;
      }
    }

    const planName = activeUserPlan?.plan?.name;

    let text;
    if (acuteActs.length === 0) {
      text = planName
        ? `Sin actividad esta semana: retoma con una sesión ligera alineada a tu plan «${planName}».`
        : 'Sin actividad esta semana: una salida corta hoy te devuelve el ritmo.';
    } else if (acwr > 1.35) {
      text = `Carga alta (ratio ~${acwr.toFixed(1)}): prioriza recuperación o volumen suave hoy.`;
    } else if (acwr < 0.75) {
      text = `Volumen bajo esta semana (~${acuteKm.toFixed(0)} km): buen momento para sumar kilómetros con calma.`;
    } else if (streak >= 3) {
      text = `Racha de ${streak} días y carga equilibrada: mantén la constancia con la sesión que toque en tu plan.`;
    } else if (planName) {
      text = `Carga estable (~${acuteKm.toFixed(0)} km/7d): sigue el plan «${planName}» con un día a la vez.`;
    } else {
      text = `Llevas ~${acuteKm.toFixed(0)} km en 7 días con carga moderada: escucha al cuerpo y ajusta el ritmo.`;
    }

    res.json({ text, briefing: text });
  } catch (error) {
    console.error('[ERROR] getDailyBriefing:', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

module.exports = {
  analyzeActivity,
  generateTrainingPlan,
  getRaceStrategy,
  predictTime,
  getAnalysisHistory,
  getUsageStats,
  analyzeMultipleActivities,
  compareActivities,
  analyzeTrends,
  chatWithCoach,
  listConversations,
  getConversation,
  deleteConversation,
  predictRace,
  exportPlan,
  analyzeCompetitionGoal,
  suggestComplementaryExercises,
  getDailyBriefing,
};

