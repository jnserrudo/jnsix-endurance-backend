const { PrismaClient } = require('@prisma/client');
const aiService = require('../services/ai.service');

const prisma = new PrismaClient();

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
      return res.status(404).json({ error: 'Activity not found' });
    }

    console.log('Activity found, calling AI service...');
    const result = await aiService.analyzeActivity(activity, analysisType, customPrompt);
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
    res.status(500).json({ error: error.message, details: error.stack });
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
    res.status(500).json({ error: error.message });
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

const analyzeMultipleActivities = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityIds, analysisType = 'PERFORMANCE_ANALYSIS' } = req.body;

    if (!activityIds || !Array.isArray(activityIds) || activityIds.length === 0) {
      return res.status(400).json({ error: 'Activity IDs are required' });
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
      return res.status(404).json({ error: 'No activities found' });
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

Proporciona:
1. Análisis comparativo entre las actividades
2. Tendencias y patrones observados
3. Puntos fuertes y áreas de mejora
4. Progresión del rendimiento
5. Recomendaciones específicas basadas en el conjunto
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
    res.status(500).json({ error: error.message });
  }
};

const compareActivities = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityIds } = req.body;

    if (!activityIds || !Array.isArray(activityIds) || activityIds.length < 2) {
      return res.status(400).json({ error: 'At least 2 activity IDs are required' });
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
      return res.status(404).json({ error: 'At least 2 activities are required' });
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

Proporciona:
1. Comparación directa de rendimiento
2. Diferencias en ritmo y esfuerzo
3. Factores que explicaron las diferencias
4. Lecciones aprendidas de cada actividad
5. Recomendaciones para futuras sesiones
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
    res.status(500).json({ error: error.message });
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
      return res.status(404).json({ error: 'No activities found in the specified period' });
    }

    const customPrompt = `
Analiza las tendencias de rendimiento de los últimos ${days} días basándote en ${activities.length} actividades:

Resumen del período:
- Total de actividades: ${activities.length}
- Distancia total: ${activities.reduce((sum, a) => sum + a.distanceKm, 0).toFixed(2)} km
- Tiempo total: ${Math.floor(activities.reduce((sum, a) => sum + a.movingTime, 0) / 60)} minutos
- Distancia promedio: ${(activities.reduce((sum, a) => sum + a.distanceKm, 0) / activities.length).toFixed(2)} km
- Ritmo promedio: ${(activities.reduce((sum, a) => sum + (a.movingTime / 60 / a.distanceKm), 0) / activities.length).toFixed(2)} min/km

Proporciona:
1. Tendencias de progreso o estancamiento
2. Patrones de rendimiento semanal
3. Variaciones en ritmo y esfuerzo
4. Áreas de mejora identificadas
5. Recomendaciones para el próximo período
6. Objetivos realistas basados en las tendencias
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
    res.status(500).json({ error: error.message });
  }
};

const chatWithCoach = async (req, res) => {
  try {
    const userId = req.user.id;
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Obtener las últimas 15 actividades del atleta para el contexto de entrenamiento
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
        maxHr: true
      }
    });

    const activitiesSummary = recentActivities.map(a => 
      `- Fecha: ${a.startDate.toISOString().split('T')[0]} | Nombre: ${a.name} | Tipo: ${a.type} | Distancia: ${a.distanceKm.toFixed(2)} km | Desnivel: ${Math.round(a.elevationM)}m | Tiempo: ${Math.floor(a.movingTime/60)}m ${a.movingTime%60}s | FC Promedio: ${a.averageHr || 'N/A'} bpm`
    ).join('\n');

    const systemPrompt = `Eres JNSIX AI Coach, un entrenador personal y consultor deportivo experto en triatlón, ciclismo, trail running y natación.
Tu objetivo es guiar al atleta con respuestas basadas en la ciencia del deporte, siendo alentador, profesional y muy técnico.

Aquí tienes el historial reciente de las últimas 15 actividades del atleta en la plataforma:
${activitiesSummary || 'El atleta no tiene actividades registradas todavía.'}

Usa este historial deportivo como contexto principal para responder preguntas sobre su volumen de entrenamiento, fatiga, consejos de recuperación, ritmos, progresiones y planeamiento de sesiones.
Si te preguntan algo fuera de su contexto o de entrenamiento, redirígelos amablemente hacia su preparación física.
Proporciona respuestas cortas, directas y formateadas en Markdown claras y legibles en dispositivos móviles. No utilices ningún tipo de emoji en tus respuestas, solo texto plano o markdown.`;

    const result = await aiService.chatWithCoach(systemPrompt, messages);

    // Registrar en el historial de uso de IA
    await prisma.aIAnalysis.create({
      data: {
        userId,
        type: 'GENERAL_INSIGHT',
        prompt: messages[messages.length - 1]?.content || 'Chat con el Coach',
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    res.json({ response: result.response });
  } catch (error) {
    console.error('Error in chatWithCoach:', error);
    res.status(500).json({ error: error.message });
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
      return res.status(404).json({ error: 'Competencia no encontrada.' });
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

    // 4. Formular el prompt científico-deportivo integral
    const systemPrompt = `Eres JNSIX AI Strategy Coach, un director deportivo e ingeniero de rendimiento experto en planificación, ritmo (pacing) y nutrición de ultra-distancia, trail running, ciclismo y triatlón.
Tu tarea es analizar el objetivo de competencia del atleta frente a su historial deportivo y sus entrenamientos de simulación específicos elegidos por él. Entregarás un reporte extremadamente profesional, motivador y con base científica en Markdown.`;

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

Por favor, estructura tu reporte en las siguientes secciones exactas y legibles para móviles:

### 1. EVALUACION DE PREPARACION Y CONFIANZA
- Compara las distancias y desniveles de mis entrenamientos (tanto del historial como especialmente de las simulaciones seleccionadas) frente a los requisitos de la competencia.
- Estima mi nivel de confianza y preparación física actual (escala del 1 al 10) y justifica el por qué.

### 2. ESTRATEGIA DE RITMO Y PENDIENTES
- Define cómo debo distribuir mi esfuerzo a lo largo de la carrera (estrategia conservadora, negativa, regular).
- Ofrece pautas específicas de ritmo o esfuerzo según la pendiente (ej: cómo afrontar subidas duras y cuándo caminar activamente en Trail, o potencia en ciclismo).

### 3. PLAN DE NUTRICION E HIDRATACION CIENTIFICA
- Recomienda los gramos de carbohidratos óptimos por hora basados en la distancia y duración estimada.
- Detalla un esquema de hidratación y reposición de sales minerales (sodio) según el esfuerzo.
- Ofrece un plan de carga de carbohidratos para las 36 horas previas.

### 4. PLANIFICACION DE DESCARGA
- Diseña una guía compacta de tapering para las últimas 2 o 3 semanas anteriores a la competencia, indicando a qué porcentajes reducir el volumen e intensidad de mis entrenamientos.

### 5. CONSEJOS TACTICOS Y MENTALES
- Brinda 3 consejos clave específicos para el tipo de terreno/disciplina que me ayudarán a rendir al máximo.`;

    const result = await aiService.chatWithCoach(systemPrompt, [{ role: 'user', content: userPrompt }]);

    // 5. Registrar el análisis en la base de datos
    const analysis = await prisma.aIAnalysis.create({
      data: {
        userId,
        type: 'COMPETITION_STRATEGY',
        prompt: `Analizar competencia: ${competition.name} (ID: ${id})`,
        response: result.response,
        model: result.model,
        tokensUsed: result.tokensUsed
      }
    });

    res.json(analysis);
  } catch (error) {
    console.error('🔴 [ANALYZE COMPETITION AI] Error:', error.message);
    res.status(500).json({ error: error.message });
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
  analyzeCompetitionGoal
};

