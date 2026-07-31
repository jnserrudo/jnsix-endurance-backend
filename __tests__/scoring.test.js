jest.mock('../src/lib/prisma', () => ({
  scoreEvent: {
    create: jest.fn(),
    aggregate: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  userScore: { findUnique: jest.fn(), upsert: jest.fn() },
  rank: { findFirst: jest.fn() },
  activity: { findUnique: jest.fn(), findMany: jest.fn() },
  workoutSession: { findUnique: jest.fn() },
  reward: { findMany: jest.fn() },
  scoringRule: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
}));

const { calculateActivityPointsWith, calculateWorkoutPointsWith } = require('../src/services/scoring.service');
const { DEFAULT_SCORING_RULES } = require('../src/services/scoringConfig.service');

/** Mapa `{ key: value }` con los mismos defaults que usa la app en producción. */
const defaultValues = () => {
  const values = {};
  for (const rule of DEFAULT_SCORING_RULES) values[rule.key] = rule.value;
  return values;
};

describe('calculateActivityPointsWith', () => {
  describe('componentes del cálculo', () => {
    it('suma solo la distancia cuando no hay desnivel ni tiempo', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 10, elevationM: 0, movingTime: 0, type: 'RUN' },
        defaultValues()
      );
      // 10 km × 10 pts/km × multiplicador RUN (1)
      expect(points).toBe(100);
    });

    it('suma la distancia más el desnivel', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 10, elevationM: 100, movingTime: 0, type: 'RUN' },
        defaultValues()
      );
      // 100 pts de distancia + 100 m × 0.5 pts/m
      expect(points).toBe(150);
    });

    it('suma el aporte del tiempo en movimiento a razón de puntos por hora', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 0, elevationM: 0, movingTime: 3600, type: 'RUN' },
        defaultValues()
      );
      // 1 hora × 20 pts/hora
      expect(points).toBe(20);
    });

    it('prorratea el tiempo en movimiento cuando es menos de una hora', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 0, elevationM: 0, movingTime: 1800, type: 'RUN' },
        defaultValues()
      );
      expect(points).toBe(10);
    });

    it('el aporte del tiempo se suma antes del multiplicador del deporte', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 0, elevationM: 0, movingTime: 3600, type: 'SWIM' },
        defaultValues()
      );
      // (0 + 0 + 20) × 1.5
      expect(points).toBe(30);
    });
  });

  describe('regresión verificada a mano', () => {
    it('10 km, 100 m de desnivel, 3000 s y tipo RUN dan 167 puntos con los defaults', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 10, elevationM: 100, movingTime: 3000, type: 'RUN' },
        defaultValues()
      );
      expect(points).toBe(167);
    });
  });

  describe('multiplicadores por tipo de deporte', () => {
    // 10 km limpios (10 × 10 = 100 pts base) para leer el multiplicador directo.
    const casos = [
      ['RUN', 1, 100],
      ['TRAIL_RUN', 1.3, 130],
      ['RIDE', 0.8, 80],
      ['VIRTUAL_RUN', 0.9, 90],
      ['VIRTUAL_RIDE', 0.7, 70],
      ['SWIM', 1.5, 150],
      ['HIKE', 1.1, 110],
      ['WALK', 0.6, 60],
      ['OTHER', 0.5, 50],
    ];

    it.each(casos)('aplica el multiplicador de %s (×%s) y da %i puntos', (type, _mult, esperado) => {
      const points = calculateActivityPointsWith(
        { distanceKm: 10, elevationM: 0, movingTime: 0, type },
        defaultValues()
      );
      expect(points).toBe(esperado);
    });

    it('cubre los 9 tipos de deporte configurables', () => {
      const claves = DEFAULT_SCORING_RULES.filter((r) => r.key.startsWith('multiplier.')).map((r) => r.key);
      expect(claves).toHaveLength(9);
      expect(casos.map(([type]) => `multiplier.${type}`).sort()).toEqual(claves.sort());
    });

    it('cae al multiplicador de OTHER cuando el tipo es desconocido', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 10, elevationM: 0, movingTime: 0, type: 'KITESURF' },
        defaultValues()
      );
      expect(points).toBe(50);
    });

    it('cae al multiplicador de OTHER cuando el tipo viene vacío', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 10, elevationM: 0, movingTime: 0, type: null },
        defaultValues()
      );
      expect(points).toBe(50);
    });
  });

  describe('actividades en cero y valores inválidos', () => {
    it('una actividad con todo en cero no suma puntos', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 0, elevationM: 0, movingTime: 0, type: 'RUN' },
        defaultValues()
      );
      expect(points).toBe(0);
    });

    it('una actividad sin ningún campo no suma puntos ni devuelve NaN', () => {
      const points = calculateActivityPointsWith({}, defaultValues());
      expect(points).toBe(0);
      expect(Number.isNaN(points)).toBe(false);
    });

    it('trata los campos nulos como cero', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: null, elevationM: null, movingTime: null, type: 'RUN' },
        defaultValues()
      );
      expect(points).toBe(0);
    });

    it('trata los campos no numéricos como cero', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 'diez', elevationM: 'cien', movingTime: 'mucho', type: 'RUN' },
        defaultValues()
      );
      expect(points).toBe(0);
    });

    it('nunca devuelve puntos negativos con distancia negativa', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: -10, elevationM: 0, movingTime: 0, type: 'RUN' },
        defaultValues()
      );
      expect(points).toBe(0);
      expect(points).toBeGreaterThanOrEqual(0);
    });

    it('nunca devuelve puntos negativos con desnivel y tiempo negativos', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: -5, elevationM: -200, movingTime: -3600, type: 'TRAIL_RUN' },
        defaultValues()
      );
      expect(points).toBe(0);
    });

    it('devuelve 0 y no Infinity cuando el total no es finito', () => {
      const values = { ...defaultValues(), 'activity.points_per_km': Infinity };
      const points = calculateActivityPointsWith(
        { distanceKm: 10, elevationM: 0, movingTime: 0, type: 'RUN' },
        values
      );
      expect(points).toBe(0);
    });

    it('trata las reglas faltantes como cero en lugar de producir NaN', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 10, elevationM: 100, movingTime: 3600, type: 'RUN' },
        { 'multiplier.RUN': 1 }
      );
      expect(points).toBe(0);
      expect(Number.isNaN(points)).toBe(false);
    });
  });

  describe('piso mínimo por actividad válida', () => {
    it('aplica el mínimo a una actividad de un minuto que redondearía a cero', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 0, elevationM: 0, movingTime: 60, type: 'RUN' },
        defaultValues()
      );
      // 60 s → 0.33 pts → redondea a 0 → se aplica el piso de 1 pt
      expect(points).toBe(1);
    });

    it('aplica el mínimo a una actividad de más de 50 metros que redondearía a cero', () => {
      const values = { ...defaultValues(), 'activity.points_per_km': 0.1 };
      const points = calculateActivityPointsWith(
        { distanceKm: 0.06, elevationM: 0, movingTime: 0, type: 'RUN' },
        values
      );
      expect(points).toBe(1);
    });

    it('no aplica el mínimo a una actividad demasiado corta', () => {
      const points = calculateActivityPointsWith(
        { distanceKm: 0.01, elevationM: 0, movingTime: 30, type: 'RUN' },
        defaultValues()
      );
      expect(points).toBe(0);
    });

    it('respeta un piso configurado distinto del default', () => {
      const values = { ...defaultValues(), 'activity.min_points': 7 };
      const points = calculateActivityPointsWith(
        { distanceKm: 0, elevationM: 0, movingTime: 60, type: 'RUN' },
        values
      );
      expect(points).toBe(7);
    });
  });

  it('devuelve siempre un entero', () => {
    const points = calculateActivityPointsWith(
      { distanceKm: 7.37, elevationM: 43, movingTime: 2711, type: 'TRAIL_RUN' },
      defaultValues()
    );
    expect(Number.isInteger(points)).toBe(true);
  });
});

describe('calculateWorkoutPointsWith', () => {
  it('suma puntos por serie y por volumen levantado', () => {
    const sets = [
      { reps: 10, weightKg: 50 },
      { reps: 10, weightKg: 50 },
      { reps: 10, weightKg: 50 },
    ];
    // 3 series × 5 pts + 1500 kg de volumen × 0.05 pts/kg
    expect(calculateWorkoutPointsWith(sets, defaultValues())).toBe(90);
  });

  it('suma solo puntos por serie cuando el volumen no aporta', () => {
    const values = { ...defaultValues(), 'workout.points_per_volume_kg': 0 };
    const sets = [{ reps: 12, weightKg: 80 }, { reps: 12, weightKg: 80 }];
    expect(calculateWorkoutPointsWith(sets, values)).toBe(10);
  });

  it('suma solo puntos por volumen cuando la serie no aporta', () => {
    const values = { ...defaultValues(), 'workout.points_per_set': 0 };
    const sets = [{ reps: 20, weightKg: 100 }];
    // 2000 kg × 0.05
    expect(calculateWorkoutPointsWith(sets, values)).toBe(100);
  });

  it('una sesión sin series no suma puntos', () => {
    expect(calculateWorkoutPointsWith([], defaultValues())).toBe(0);
  });

  it('cuenta el peso corporal como 1 kg cuando la serie no tiene peso', () => {
    const sets = [{ reps: 10 }];
    // 5 pts de serie + 10 reps × 1 kg × 0.05
    expect(calculateWorkoutPointsWith(sets, defaultValues())).toBe(6);
  });

  it('trata las repeticiones faltantes como cero', () => {
    const sets = [{ weightKg: 100 }];
    expect(calculateWorkoutPointsWith(sets, defaultValues())).toBe(5);
  });

  it('nunca devuelve puntos negativos con repeticiones negativas', () => {
    const sets = [{ reps: -100, weightKg: 100 }];
    expect(calculateWorkoutPointsWith(sets, defaultValues())).toBe(0);
  });

  it('trata las reglas faltantes como cero en lugar de producir NaN', () => {
    const points = calculateWorkoutPointsWith([{ reps: 10, weightKg: 50 }], {});
    expect(points).toBe(0);
    expect(Number.isNaN(points)).toBe(false);
  });

  it('devuelve siempre un entero', () => {
    const sets = [{ reps: 7, weightKg: 22.5 }, { reps: 9, weightKg: 17.5 }];
    expect(Number.isInteger(calculateWorkoutPointsWith(sets, defaultValues()))).toBe(true);
  });
});
