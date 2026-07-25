/**
 * Copy centralizado en español para razones de puntos y notificaciones.
 * Evita mezclar inglés en push / historial de puntos.
 */
const copy = {
  achievementUnlocked: (name) => `Logro desbloqueado: ${name}`,
  missionCompleted: (name) => `Misión completada: ${name}`,
  activityCompleted: (name) => `Actividad completada: ${name}`,
  workoutCompleted: (name) => `Entrenamiento completado: ${name}`,
  streakBonus: (days) => `Bonus de racha: ${days} días`,
  streakBonusContains: (days) => `Bonus de racha: ${days} días`,
  dailyCombo: () => 'Bonus combo del día: entrená + publicá + reaccioná',
  badgeUnlocked: (name) => `Insignia desbloqueada: ${name}`,
  duelChallenge: (name) => `${name} te desafió a un duelo`,
};

/** Catálogo base de logros (nombre único en DB). */
const ACHIEVEMENT_DEFS = [
  {
    name: 'Primera Actividad',
    description: 'Registraste tu primera actividad.',
    points: 10,
    legacyNames: ['First Activity'],
  },
  {
    name: 'Primer 10K',
    description: 'Completaste tu primer 10K.',
    points: 50,
    legacyNames: ['First 10K'],
  },
  {
    name: '100 km totales',
    description: 'Alcanzaste 100 km totales.',
    points: 100,
    legacyNames: ['100 km total'],
  },
  {
    name: 'Primera 5K',
    description: 'Completaste tu primera carrera de 5 km.',
    points: 25,
    legacyNames: ['First 5K'],
  },
  {
    name: 'Primer 21K',
    description: 'Completaste tu primer medio maratón (21 km).',
    points: 75,
    legacyNames: ['First 21K', 'First Half Marathon'],
  },
  {
    name: '50 km totales',
    description: 'Sumaste 50 km en total.',
    points: 40,
    legacyNames: ['50 km total'],
  },
  {
    name: '500 km totales',
    description: 'Alcanzaste 500 km acumulados.',
    points: 250,
    legacyNames: ['500 km total'],
  },
  {
    name: '1000 km',
    description: 'Llegaste a los 1000 km totales.',
    points: 500,
    legacyNames: ['1000 km total', '1000 km'],
  },
  {
    name: 'Primera carrera trail',
    description: 'Registraste tu primera salida trail.',
    points: 30,
    legacyNames: ['First Trail Run'],
  },
  {
    name: 'Primer ride',
    description: 'Registraste tu primera salida en bici.',
    points: 30,
    legacyNames: ['First Ride'],
  },
  {
    name: '10 actividades',
    description: 'Completaste 10 actividades.',
    points: 35,
    legacyNames: ['10 Activities'],
  },
  {
    name: '50 actividades',
    description: 'Completaste 50 actividades.',
    points: 120,
    legacyNames: ['50 Activities'],
  },
  {
    name: 'Racha 7 días',
    description: 'Entrenaste 7 días seguidos.',
    points: 50,
    legacyNames: ['7 Day Streak'],
  },
  {
    name: 'Racha 30 días',
    description: 'Mantuviste una racha de 30 días.',
    points: 200,
    legacyNames: ['30 Day Streak'],
  },
  {
    name: 'Elevación 1000m en una sesión',
    description: 'Superaste 1000 m de desnivel en una sola actividad.',
    points: 60,
    legacyNames: ['1000m elevation session'],
  },
  {
    name: 'Elevación 10k total',
    description: 'Acumulaste 10.000 m de desnivel en total.',
    points: 150,
    legacyNames: ['10000m total elevation'],
  },
  {
    name: 'Natación debut',
    description: 'Registraste tu primera sesión de natación.',
    points: 25,
    legacyNames: ['First Swim'],
  },
  {
    name: 'Primer workout fuerza',
    description: 'Completaste tu primer entrenamiento de fuerza.',
    points: 20,
    legacyNames: ['First Strength Workout'],
  },
  {
    name: 'Madrugador',
    description: 'Registraste una actividad antes de las 7:00.',
    points: 35,
    legacyNames: ['Early Bird'],
  },
  {
    name: 'Primer Canje',
    description: 'Canjeaste tu primer premio con puntos.',
    points: 30,
    legacyNames: ['First Redemption'],
  },
];

module.exports = { copy, ACHIEVEMENT_DEFS };
