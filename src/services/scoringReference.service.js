const prisma = require('../lib/prisma');
const scoringConfig = require('./scoringConfig.service');
const { calculateActivityPointsWith, calculateWorkoutPointsWith } = require('./scoring.service');

/**
 * Referencia de puntos para que un negocio pueda ponerle precio a su beneficio
 * con criterio. Todo se deriva de las reglas vigentes: si cambia el valor del
 * kilómetro, los ejemplos y las bandas cambian solos.
 *
 * Vive en su propio archivo para no crear un ciclo de imports
 * (scoring.service ya depende de scoringConfig.service).
 */

const WEEKS_OF_HISTORY = 8;
/** Con menos atletas que esto, el promedio real no es representativo. */
const MIN_SAMPLE_ATHLETES = 5;

const ACTIVITY_EXAMPLES = [
  { key: 'run_5k', label: 'Corrida de 5 km', detail: '5 km en 30 min', type: 'RUN', distanceKm: 5, elevationM: 0, movingTimeMin: 30 },
  { key: 'run_10k', label: 'Corrida de 10 km', detail: '10 km en 55 min', type: 'RUN', distanceKm: 10, elevationM: 0, movingTimeMin: 55 },
  { key: 'run_21k', label: 'Media maratón', detail: '21 km en 2 h', type: 'RUN', distanceKm: 21.1, elevationM: 0, movingTimeMin: 120 },
  { key: 'ride_30k', label: 'Salida en bici', detail: '30 km en 1 h 30', type: 'RIDE', distanceKm: 30, elevationM: 0, movingTimeMin: 90 },
  { key: 'trail_12k', label: 'Trail con desnivel', detail: '12 km y 400 m en 1 h 20', type: 'TRAIL_RUN', distanceKm: 12, elevationM: 400, movingTimeMin: 80 },
];

/** Perfiles teóricos por semana, para cuando todavía no hay datos suficientes. */
const WEEKLY_PROFILES = {
  casual: { label: 'Casual', sessions: 3, example: 'run_5k', description: '3 salidas de 5 km por semana' },
  regular: { label: 'Regular', sessions: 3, example: 'run_10k', description: '3 salidas de 10 km por semana' },
  competitivo: { label: 'Competitivo', sessions: 5, example: 'run_10k', description: '5 salidas de 10 km por semana' },
};

const BAND_META = [
  { key: 'easy', label: 'Fácil', ruleKey: 'reward.guide.easy_weeks', ideas: 'Un café, un alfajor, un 10% de descuento.' },
  { key: 'medium', label: 'Media', ruleKey: 'reward.guide.medium_weeks', ideas: 'Un 2x1, un snack, un 20% de descuento.' },
  { key: 'hard', label: 'Alta', ruleKey: 'reward.guide.hard_weeks', ideas: 'Un producto o un servicio completo.' },
  { key: 'premium', label: 'Premium', ruleKey: 'reward.guide.premium_weeks', ideas: 'Lo que quieras posicionar como logro grande.' },
];

const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
};

/**
 * Promedio semanal de puntos por atleta activo en las últimas 8 semanas.
 * Si la muestra es chica, cae a la estimación teórica y lo marca con isEstimated
 * para no mostrar un dato inventado como si fuera medido.
 */
const getWeeklyReference = async (values, examplePoints) => {
  const estimate = () => {
    const perProfile = (profile) => Math.round((examplePoints[profile.example] || 0) * profile.sessions);
    return {
      casual: perProfile(WEEKLY_PROFILES.casual),
      regular: perProfile(WEEKLY_PROFILES.regular),
      competitivo: perProfile(WEEKLY_PROFILES.competitivo),
      isEstimated: true,
      sampleAthletes: 0,
      basedOn: `Estimación: ${WEEKLY_PROFILES.regular.description} para un atleta regular.`,
    };
  };

  try {
    const since = new Date();
    since.setDate(since.getDate() - WEEKS_OF_HISTORY * 7);

    const grouped = await prisma.scoreEvent.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: since }, points: { gt: 0 } },
      _sum: { points: true },
    });

    if (grouped.length < MIN_SAMPLE_ATHLETES) return estimate();

    const weekly = grouped
      .map((row) => Math.round((row._sum.points || 0) / WEEKS_OF_HISTORY))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    if (weekly.length < MIN_SAMPLE_ATHLETES) return estimate();

    return {
      casual: percentile(weekly, 25),
      regular: percentile(weekly, 50),
      competitivo: percentile(weekly, 75),
      isEstimated: false,
      sampleAthletes: weekly.length,
      basedOn: `Medido sobre ${weekly.length} atletas activos en las últimas ${WEEKS_OF_HISTORY} semanas.`,
    };
  } catch (error) {
    console.warn('[scoringReference] no se pudo medir la referencia semanal:', error.message);
    return estimate();
  }
};

/**
 * Saldos (anónimos) de los atletas que hicieron check-in en el local. Permite que
 * el móvil calcule en vivo qué porcentaje puede pagar un costo mientras se tipea.
 */
const getBusinessAudience = async (businessId, userId) => {
  if (!businessId) return null;
  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, ownerId: true },
    });
    // Sin ser el dueño no se devuelve el dato del local, pero la guía general sigue.
    if (!business || business.ownerId !== userId) return null;

    const checkIns = await prisma.businessCheckIn.findMany({
      where: { businessId },
      select: { userId: true },
      distinct: ['userId'],
      take: 500,
    });
    if (checkIns.length === 0) return { athleteCount: 0, balances: [] };

    const scores = await prisma.userScore.findMany({
      where: { userId: { in: checkIns.map((c) => c.userId) } },
      select: { totalPoints: true },
    });

    return {
      athleteCount: checkIns.length,
      balances: scores.map((s) => s.totalPoints || 0).sort((a, b) => a - b),
    };
  } catch (error) {
    console.warn('[scoringReference] no se pudo calcular la audiencia del local:', error.message);
    return null;
  }
};

const getReference = async ({ userId, businessId } = {}) => {
  const values = await scoringConfig.getValues();

  const examples = ACTIVITY_EXAMPLES.map((example) => ({
    key: example.key,
    label: example.label,
    detail: example.detail,
    points: calculateActivityPointsWith(
      {
        type: example.type,
        distanceKm: example.distanceKm,
        elevationM: example.elevationM,
        movingTime: example.movingTimeMin * 60,
      },
      values
    ),
  }));

  const gymSets = Array.from({ length: 20 }, () => ({ reps: 10, weightKg: 20 }));
  examples.push({
    key: 'gym_20',
    label: 'Sesión de gimnasio',
    detail: '20 series de 10 reps con 20 kg',
    points: calculateWorkoutPointsWith(gymSets, values),
  });
  examples.push({
    key: 'checkin',
    label: 'Check-in en tu local',
    detail: 'Una visita, sin canjear nada',
    points: Math.round(values['checkin.points'] ?? 0),
  });
  examples.push({
    key: 'streak_7',
    label: 'Bonus de racha',
    detail: '7 días seguidos entrenando',
    points: Math.round(values['streak.bonus_7_days'] ?? 0),
  });

  const examplePoints = Object.fromEntries(examples.map((e) => [e.key, e.points]));
  const weeklyReference = await getWeeklyReference(values, examplePoints);

  const weeklyRegular = weeklyReference.regular || 1;
  const bands = BAND_META.map((meta) => {
    const weeks = values[meta.ruleKey] ?? 1;
    const points = Math.max(1, Math.round(weeklyRegular * weeks));
    const runsOf10k = examplePoints.run_10k > 0 ? Math.round(points / examplePoints.run_10k) : null;
    return {
      key: meta.key,
      label: meta.label,
      weeks,
      points,
      ideas: meta.ideas,
      effort: weeks < 1 ? `Media semana de entrenamiento` : `${weeks} ${weeks === 1 ? 'semana' : 'semanas'} de entrenamiento`,
      equivalence: runsOf10k ? `${runsOf10k} ${runsOf10k === 1 ? 'corrida' : 'corridas'} de 10 km` : null,
    };
  });

  const audience = await getBusinessAudience(businessId, userId);

  return {
    examples,
    weeklyReference,
    bands,
    audience,
    reference: {
      pointsPerKm: values['activity.points_per_km'] ?? 0,
      checkInPoints: Math.round(values['checkin.points'] ?? 0),
      pointsPerRun10k: examplePoints.run_10k || 0,
    },
  };
};

module.exports = { getReference, WEEKLY_PROFILES, BAND_META };
