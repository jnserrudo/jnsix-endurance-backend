const prisma = require('../lib/prisma');

/**
 * Economía de puntos configurable.
 *
 * Los valores de abajo son EXACTAMENTE los que antes estaban hardcodeados en
 * scoring.service, gamification.service, rewards.service, referral.service,
 * businesses.controller y groups.controller, así que migrar a este servicio no
 * cambia ningún cálculo. Una fila en `ScoringRule` sobreescribe el default.
 *
 * Criterio: cambiar una regla afecta de ahí en adelante y nunca reescribe puntos
 * ya otorgados. Recalcular es una acción aparte y explícita.
 */

const GROUPS = {
  ACTIVITY: 'ACTIVITY',
  MULTIPLIER: 'MULTIPLIER',
  WORKOUT: 'WORKOUT',
  STREAK: 'STREAK',
  CHECKIN: 'CHECKIN',
  REFERRAL: 'REFERRAL',
  SOCIAL: 'SOCIAL',
  REWARD: 'REWARD',
  CLUB: 'CLUB',
  REWARD_GUIDE: 'REWARD_GUIDE',
  SEASON: 'SEASON',
};

/** Orden y nombre en español de cada grupo, para la pantalla de admin. */
const GROUP_META = [
  { group: GROUPS.ACTIVITY, label: 'Actividades', description: 'Cuánto vale cada kilómetro, metro de desnivel y hora en movimiento.' },
  { group: GROUPS.MULTIPLIER, label: 'Multiplicadores por deporte', description: 'Ajuste según el esfuerzo relativo de cada disciplina.' },
  { group: GROUPS.WORKOUT, label: 'Gimnasio', description: 'Puntos por serie y por volumen levantado.' },
  { group: GROUPS.STREAK, label: 'Rachas', description: 'Bonus al sostener días consecutivos de entrenamiento.' },
  { group: GROUPS.CHECKIN, label: 'Check-in en locales', description: 'Puntos por visitar un negocio del club.' },
  { group: GROUPS.REFERRAL, label: 'Invitaciones', description: 'Premio al que invita y al que se suma.' },
  { group: GROUPS.SOCIAL, label: 'Social', description: 'Puntos por combos y actividad en la comunidad.' },
  { group: GROUPS.REWARD, label: 'Descuentos al canjear', description: 'Rebajas sobre el costo en puntos de una recompensa.' },
  { group: GROUPS.CLUB, label: 'Umbrales de club', description: 'Puntos mensuales de un grupo para desbloquear premios de partner.' },
  { group: GROUPS.REWARD_GUIDE, label: 'Bandas de dificultad', description: 'Cuántas semanas de un atleta regular representa cada banda. Define la guía de precios que ven los negocios.' },
  { group: GROUPS.SEASON, label: 'Cierre de temporada', description: 'Bonus que reciben los primeros puestos cuando cerrás una temporada.' },
];

const DEFAULT_SCORING_RULES = [
  // --- Actividades ---
  {
    key: 'activity.points_per_km',
    label: 'Puntos por kilómetro',
    description: 'Base de casi toda la economía: lo que suma cada km recorrido antes del multiplicador.',
    group: GROUPS.ACTIVITY,
    value: 10,
    minValue: 0,
    maxValue: 200,
    unit: 'pts_por_km',
  },
  {
    key: 'activity.points_per_elevation_m',
    label: 'Puntos por metro de desnivel',
    description: 'Premia subir. Se suma al total antes del multiplicador.',
    group: GROUPS.ACTIVITY,
    value: 0.5,
    minValue: 0,
    maxValue: 20,
    unit: 'pts_por_m',
  },
  {
    key: 'activity.points_per_hour',
    label: 'Puntos por hora en movimiento',
    description: 'Reconoce el tiempo además de la distancia.',
    group: GROUPS.ACTIVITY,
    value: 20,
    minValue: 0,
    maxValue: 500,
    unit: 'pts_por_hora',
  },
  {
    key: 'activity.min_points',
    label: 'Mínimo por actividad válida',
    description: 'Piso para que una actividad corta igual sume algo (más de 50 m o más de 1 minuto).',
    group: GROUPS.ACTIVITY,
    value: 1,
    minValue: 0,
    maxValue: 100,
    unit: 'pts',
  },

  // --- Multiplicadores por tipo ---
  { key: 'multiplier.RUN', label: 'Correr', group: GROUPS.MULTIPLIER, value: 1, minValue: 0, maxValue: 5, unit: 'x' },
  { key: 'multiplier.TRAIL_RUN', label: 'Trail running', group: GROUPS.MULTIPLIER, value: 1.3, minValue: 0, maxValue: 5, unit: 'x' },
  { key: 'multiplier.RIDE', label: 'Bici', group: GROUPS.MULTIPLIER, value: 0.8, minValue: 0, maxValue: 5, unit: 'x' },
  { key: 'multiplier.VIRTUAL_RUN', label: 'Correr virtual', group: GROUPS.MULTIPLIER, value: 0.9, minValue: 0, maxValue: 5, unit: 'x' },
  { key: 'multiplier.VIRTUAL_RIDE', label: 'Bici virtual', group: GROUPS.MULTIPLIER, value: 0.7, minValue: 0, maxValue: 5, unit: 'x' },
  { key: 'multiplier.SWIM', label: 'Natación', group: GROUPS.MULTIPLIER, value: 1.5, minValue: 0, maxValue: 5, unit: 'x' },
  { key: 'multiplier.HIKE', label: 'Trekking', group: GROUPS.MULTIPLIER, value: 1.1, minValue: 0, maxValue: 5, unit: 'x' },
  { key: 'multiplier.WALK', label: 'Caminar', group: GROUPS.MULTIPLIER, value: 0.6, minValue: 0, maxValue: 5, unit: 'x' },
  { key: 'multiplier.OTHER', label: 'Otros deportes', group: GROUPS.MULTIPLIER, value: 0.5, minValue: 0, maxValue: 5, unit: 'x' },

  // --- Gimnasio ---
  {
    key: 'workout.points_per_set',
    label: 'Puntos por serie',
    description: 'Cada serie completada de una sesión de gimnasio.',
    group: GROUPS.WORKOUT,
    value: 5,
    minValue: 0,
    maxValue: 100,
    unit: 'pts',
  },
  {
    key: 'workout.points_per_volume_kg',
    label: 'Puntos por kg de volumen',
    description: 'Volumen = repeticiones × peso. Con 0.05, levantar 1000 kg suma 50 pts.',
    group: GROUPS.WORKOUT,
    value: 0.05,
    minValue: 0,
    maxValue: 5,
    unit: 'pts',
  },

  // --- Rachas ---
  {
    key: 'streak.bonus_7_days',
    label: 'Bonus por racha de 7 días',
    group: GROUPS.STREAK,
    value: 50,
    minValue: 0,
    maxValue: 10000,
    unit: 'pts',
  },
  {
    key: 'streak.bonus_30_days',
    label: 'Bonus por racha de 30 días',
    group: GROUPS.STREAK,
    value: 200,
    minValue: 0,
    maxValue: 10000,
    unit: 'pts',
  },

  // --- Check-in ---
  {
    key: 'checkin.points',
    label: 'Puntos por check-in',
    description: 'Lo que gana el atleta por visitar un local del club, sin canjear nada.',
    group: GROUPS.CHECKIN,
    value: 5,
    minValue: 0,
    maxValue: 1000,
    unit: 'pts',
  },

  // --- Invitaciones ---
  {
    key: 'referral.inviter_points',
    label: 'Puntos para quien invita',
    description: 'Se acreditan cuando el invitado completa su primera actividad.',
    group: GROUPS.REFERRAL,
    value: 100,
    minValue: 0,
    maxValue: 10000,
    unit: 'pts',
  },
  {
    key: 'referral.invitee_points',
    label: 'Puntos de bienvenida al invitado',
    group: GROUPS.REFERRAL,
    value: 50,
    minValue: 0,
    maxValue: 10000,
    unit: 'pts',
  },

  // --- Social ---
  {
    key: 'social.combo_points',
    label: 'Puntos por combo',
    description: 'Bonus al completar un combo de actividades en el día.',
    group: GROUPS.SOCIAL,
    value: 15,
    minValue: 0,
    maxValue: 1000,
    unit: 'pts',
  },

  // --- Descuentos al canjear ---
  {
    key: 'reward.streak_bonus_threshold',
    label: 'Racha mínima para el descuento',
    description: 'Días de racha necesarios para que se aplique el descuento por racha.',
    group: GROUPS.REWARD,
    value: 3,
    minValue: 0,
    maxValue: 60,
    unit: 'dias',
  },
  {
    key: 'reward.streak_bonus_pct',
    label: 'Descuento por racha',
    description: 'Rebaja sobre el costo en puntos cuando el atleta mantiene la racha.',
    group: GROUPS.REWARD,
    value: 10,
    minValue: 0,
    maxValue: 100,
    unit: 'pct',
  },
  {
    key: 'reward.competition_bonus_pct',
    label: 'Descuento por competencia cercana',
    group: GROUPS.REWARD,
    value: 5,
    minValue: 0,
    maxValue: 100,
    unit: 'pct',
  },
  {
    key: 'reward.competition_proximity_days',
    label: 'Ventana de competencia cercana',
    description: 'Días antes y después de la carrera en los que aplica el descuento.',
    group: GROUPS.REWARD,
    value: 14,
    minValue: 0,
    maxValue: 180,
    unit: 'dias',
  },
  {
    key: 'reward.competition_progress_pct',
    label: 'Progreso mínimo del plan',
    description: 'Porcentaje del plan cumplido para habilitar el descuento por competencia.',
    group: GROUPS.REWARD,
    value: 80,
    minValue: 0,
    maxValue: 100,
    unit: 'pct',
  },

  // --- Umbrales de club ---
  { key: 'club.threshold_1', label: 'Umbral 1 (snack partner)', group: GROUPS.CLUB, value: 500, minValue: 0, maxValue: 1000000, unit: 'pts' },
  { key: 'club.threshold_2', label: 'Umbral 2 (descuento partner)', group: GROUPS.CLUB, value: 1500, minValue: 0, maxValue: 1000000, unit: 'pts' },
  { key: 'club.threshold_3', label: 'Umbral 3 (premio premium)', group: GROUPS.CLUB, value: 4000, minValue: 0, maxValue: 1000000, unit: 'pts' },

  // --- Cierre de temporada ---
  {
    key: 'season.podium_size',
    label: 'Tamaño del podio',
    description: 'Cuántos atletas reciben bonus cuando se cierra una temporada.',
    group: GROUPS.SEASON,
    value: 3,
    minValue: 1,
    maxValue: 50,
    unit: 'atletas',
  },
  {
    key: 'season.bonus_first',
    label: 'Bonus para el primero',
    group: GROUPS.SEASON,
    value: 1000,
    minValue: 0,
    maxValue: 1000000,
    unit: 'pts',
  },
  {
    key: 'season.bonus_second',
    label: 'Bonus para el segundo',
    group: GROUPS.SEASON,
    value: 600,
    minValue: 0,
    maxValue: 1000000,
    unit: 'pts',
  },
  {
    key: 'season.bonus_third',
    label: 'Bonus para el tercero',
    group: GROUPS.SEASON,
    value: 300,
    minValue: 0,
    maxValue: 1000000,
    unit: 'pts',
  },
  {
    key: 'season.bonus_rest_of_podium',
    label: 'Bonus del resto del podio',
    description: 'Se aplica del cuarto puesto en adelante, hasta el tamaño del podio.',
    group: GROUPS.SEASON,
    value: 100,
    minValue: 0,
    maxValue: 1000000,
    unit: 'pts',
  },

  // --- Bandas de dificultad para la guía del negocio ---
  {
    key: 'reward.guide.easy_weeks',
    label: 'Banda fácil',
    description: 'Semanas de entrenamiento de un atleta regular que debería costar un beneficio fácil.',
    group: GROUPS.REWARD_GUIDE,
    value: 0.5,
    minValue: 0.1,
    maxValue: 52,
    unit: 'semanas',
  },
  {
    key: 'reward.guide.medium_weeks',
    label: 'Banda media',
    group: GROUPS.REWARD_GUIDE,
    value: 1,
    minValue: 0.1,
    maxValue: 52,
    unit: 'semanas',
  },
  {
    key: 'reward.guide.hard_weeks',
    label: 'Banda alta',
    group: GROUPS.REWARD_GUIDE,
    value: 2,
    minValue: 0.1,
    maxValue: 52,
    unit: 'semanas',
  },
  {
    key: 'reward.guide.premium_weeks',
    label: 'Banda premium',
    group: GROUPS.REWARD_GUIDE,
    value: 4,
    minValue: 0.1,
    maxValue: 52,
    unit: 'semanas',
  },
];

const DEFAULTS_BY_KEY = new Map(DEFAULT_SCORING_RULES.map((r) => [r.key, r]));

/**
 * El cálculo de puntos corre en cada actividad, así que no puede pegarle a la DB
 * por regla. Caché en memoria con invalidación al escribir y TTL corto para que
 * otros procesos (pm2 en cluster) converjan sin reiniciar.
 */
const CACHE_TTL_MS = 60_000;
let cache = { values: null, loadedAt: 0 };
let warnedUnavailable = false;

const invalidateCache = () => {
  cache = { values: null, loadedAt: 0 };
};

const defaultValues = () => {
  const values = {};
  for (const rule of DEFAULT_SCORING_RULES) values[rule.key] = rule.value;
  return values;
};

/**
 * Mapa plano `{ key: value }` con los defaults ya aplicados.
 * Si la tabla todavía no existe o la DB falla, devuelve los defaults: la economía
 * nunca se cae por un problema de configuración.
 */
const getValues = async () => {
  const now = Date.now();
  if (cache.values && now - cache.loadedAt < CACHE_TTL_MS) return cache.values;

  const values = defaultValues();
  try {
    const rows = await prisma.scoringRule.findMany({ where: { isActive: true } });
    for (const row of rows) {
      if (!DEFAULTS_BY_KEY.has(row.key)) continue;
      const value = Number(row.value);
      if (Number.isFinite(value)) values[row.key] = value;
    }
    warnedUnavailable = false;
  } catch (error) {
    if (!warnedUnavailable) {
      console.warn('[scoringConfig] usando defaults, no se pudo leer scoring_rules:', error.message);
      warnedUnavailable = true;
    }
  }

  cache = { values, loadedAt: now };
  return values;
};

const getValue = async (key) => {
  const values = await getValues();
  if (values[key] !== undefined) return values[key];
  return DEFAULTS_BY_KEY.get(key)?.value ?? 0;
};

/** Multiplicador de un tipo de actividad, con fallback a OTHER. */
const getMultiplier = (values, type) => {
  const own = values[`multiplier.${type}`];
  if (Number.isFinite(own)) return own;
  return values['multiplier.OTHER'] ?? 0.5;
};

/** Reglas con su default al lado del valor vigente, agrupadas para la UI. */
const getRules = async () => {
  let rows = [];
  try {
    rows = await prisma.scoringRule.findMany();
  } catch (error) {
    console.warn('[scoringConfig] no se pudo leer scoring_rules:', error.message);
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const rules = DEFAULT_SCORING_RULES.map((def) => {
    const row = byKey.get(def.key);
    const value = row && Number.isFinite(Number(row.value)) ? Number(row.value) : def.value;
    return {
      key: def.key,
      label: def.label,
      description: def.description || null,
      group: def.group,
      unit: def.unit || null,
      value,
      defaultValue: def.value,
      minValue: def.minValue ?? null,
      maxValue: def.maxValue ?? null,
      isOverridden: value !== def.value,
      updatedAt: row?.updatedAt || null,
      updatedBy: row?.updatedBy || null,
    };
  });

  const groups = GROUP_META.map((meta) => ({
    ...meta,
    rules: rules.filter((r) => r.group === meta.group),
  })).filter((g) => g.rules.length > 0);

  return { groups, rules, overriddenCount: rules.filter((r) => r.isOverridden).length };
};

class ScoringRuleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ScoringRuleError';
    this.status = status;
  }
}

/** Valida y persiste una regla. Devuelve la regla resultante. */
const setRule = async (key, rawValue, updatedBy) => {
  const def = DEFAULTS_BY_KEY.get(key);
  if (!def) throw new ScoringRuleError(`La regla "${key}" no existe.`, 404);

  const value = Number(rawValue);
  if (!Number.isFinite(value)) throw new ScoringRuleError('El valor tiene que ser un número.');
  if (def.minValue != null && value < def.minValue) {
    throw new ScoringRuleError(`${def.label}: el mínimo permitido es ${def.minValue}.`);
  }
  if (def.maxValue != null && value > def.maxValue) {
    throw new ScoringRuleError(`${def.label}: el máximo permitido es ${def.maxValue}.`);
  }

  await prisma.scoringRule.upsert({
    where: { key },
    update: { value, updatedBy: updatedBy || null, isActive: true },
    create: {
      key,
      label: def.label,
      description: def.description || null,
      group: def.group,
      value,
      minValue: def.minValue ?? null,
      maxValue: def.maxValue ?? null,
      unit: def.unit || null,
      updatedBy: updatedBy || null,
    },
  });

  invalidateCache();
  return { key, value, defaultValue: def.value, unit: def.unit || null, label: def.label };
};

/** Borra los overrides (de un grupo o de todos) para volver a los defaults. */
const resetRules = async (group) => {
  const where = group ? { group } : {};
  if (group && !GROUP_META.some((g) => g.group === group)) {
    throw new ScoringRuleError(`El grupo "${group}" no existe.`, 404);
  }
  const result = await prisma.scoringRule.deleteMany({ where });
  invalidateCache();
  return { reset: result.count, group: group || 'ALL' };
};

module.exports = {
  GROUPS,
  GROUP_META,
  DEFAULT_SCORING_RULES,
  DEFAULTS_BY_KEY,
  ScoringRuleError,
  getValues,
  getValue,
  getMultiplier,
  getRules,
  setRule,
  resetRules,
  invalidateCache,
};
