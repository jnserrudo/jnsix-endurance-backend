jest.mock('../src/lib/prisma', () => ({
  scoringRule: {
    findMany: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
}));

const prisma = require('../src/lib/prisma');
const scoringConfig = require('../src/services/scoringConfig.service');

const { ScoringRuleError } = scoringConfig;

beforeEach(() => {
  // La caché vive en el módulo, así que hay que limpiarla entre tests.
  scoringConfig.invalidateCache();
  prisma.scoringRule.findMany.mockResolvedValue([]);
  prisma.scoringRule.upsert.mockResolvedValue({});
  prisma.scoringRule.deleteMany.mockResolvedValue({ count: 0 });
});

describe('getValue', () => {
  it('cae al default cuando la regla no tiene fila en base', async () => {
    prisma.scoringRule.findMany.mockResolvedValue([]);
    await expect(scoringConfig.getValue('activity.points_per_km')).resolves.toBe(10);
  });

  it('cae al default de cada regla de actividad cuando la tabla está vacía', async () => {
    prisma.scoringRule.findMany.mockResolvedValue([]);
    await expect(scoringConfig.getValue('activity.points_per_elevation_m')).resolves.toBe(0.5);
    await expect(scoringConfig.getValue('activity.points_per_hour')).resolves.toBe(20);
    await expect(scoringConfig.getValue('activity.min_points')).resolves.toBe(1);
  });

  it('respeta el override guardado en base', async () => {
    prisma.scoringRule.findMany.mockResolvedValue([
      { key: 'activity.points_per_km', value: 25, isActive: true },
    ]);
    await expect(scoringConfig.getValue('activity.points_per_km')).resolves.toBe(25);
  });

  it('convierte a número el override que viene como string o Decimal', async () => {
    prisma.scoringRule.findMany.mockResolvedValue([
      { key: 'activity.points_per_elevation_m', value: '1.25', isActive: true },
    ]);
    await expect(scoringConfig.getValue('activity.points_per_elevation_m')).resolves.toBe(1.25);
  });

  it('ignora el override cuyo valor no es un número y usa el default', async () => {
    prisma.scoringRule.findMany.mockResolvedValue([
      { key: 'activity.points_per_km', value: 'muchos', isActive: true },
    ]);
    await expect(scoringConfig.getValue('activity.points_per_km')).resolves.toBe(10);
  });

  it('ignora filas con claves que ya no existen en el código', async () => {
    prisma.scoringRule.findMany.mockResolvedValue([
      { key: 'regla.vieja.borrada', value: 999, isActive: true },
    ]);
    const values = await scoringConfig.getValues();
    expect(values['regla.vieja.borrada']).toBeUndefined();
  });

  it('devuelve 0 para una clave que no existe en ningún lado', async () => {
    await expect(scoringConfig.getValue('clave.inventada')).resolves.toBe(0);
  });

  it('usa los defaults cuando la consulta a base falla', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.scoringRule.findMany.mockRejectedValue(new Error('tabla scoring_rules inexistente'));
    await expect(scoringConfig.getValue('activity.points_per_km')).resolves.toBe(10);
    warn.mockRestore();
  });
});

describe('getValues y solo reglas activas', () => {
  it('consulta únicamente las reglas activas', async () => {
    await scoringConfig.getValues();
    expect(prisma.scoringRule.findMany).toHaveBeenCalledWith({ where: { isActive: true } });
  });

  it('devuelve un valor por cada regla declarada en el código', async () => {
    const values = await scoringConfig.getValues();
    expect(Object.keys(values)).toHaveLength(scoringConfig.DEFAULT_SCORING_RULES.length);
  });
});

describe('getMultiplier', () => {
  it('devuelve el multiplicador propio del tipo', () => {
    expect(scoringConfig.getMultiplier({ 'multiplier.SWIM': 1.5 }, 'SWIM')).toBe(1.5);
  });

  it('cae al multiplicador de OTHER cuando el tipo no está configurado', () => {
    expect(scoringConfig.getMultiplier({ 'multiplier.OTHER': 0.5 }, 'KITESURF')).toBe(0.5);
  });

  it('cae a 0.5 cuando tampoco hay multiplicador de OTHER', () => {
    expect(scoringConfig.getMultiplier({}, 'RUN')).toBe(0.5);
  });

  it('respeta un multiplicador en cero sin confundirlo con ausente', () => {
    expect(scoringConfig.getMultiplier({ 'multiplier.WALK': 0, 'multiplier.OTHER': 0.5 }, 'WALK')).toBe(0);
  });
});

describe('setRule', () => {
  it('guarda un valor válido y lo devuelve junto al default', async () => {
    const result = await scoringConfig.setRule('activity.points_per_km', 15, 'admin-1');
    expect(result).toEqual({
      key: 'activity.points_per_km',
      value: 15,
      defaultValue: 10,
      unit: 'pts_por_km',
      label: 'Puntos por kilómetro',
    });
    expect(prisma.scoringRule.upsert).toHaveBeenCalledTimes(1);
  });

  it('rechaza un valor por debajo del mínimo con un mensaje en español', async () => {
    await expect(scoringConfig.setRule('activity.points_per_km', -1, 'admin-1')).rejects.toThrow(
      'Puntos por kilómetro: el mínimo permitido es 0.'
    );
    expect(prisma.scoringRule.upsert).not.toHaveBeenCalled();
  });

  it('rechaza un valor por encima del máximo con un mensaje en español', async () => {
    await expect(scoringConfig.setRule('activity.points_per_km', 500, 'admin-1')).rejects.toThrow(
      'Puntos por kilómetro: el máximo permitido es 200.'
    );
    expect(prisma.scoringRule.upsert).not.toHaveBeenCalled();
  });

  it('rechaza un multiplicador fuera de rango con el label del deporte', async () => {
    await expect(scoringConfig.setRule('multiplier.SWIM', 9, 'admin-1')).rejects.toThrow(
      'Natación: el máximo permitido es 5.'
    );
  });

  it('rechaza un valor que no es número', async () => {
    await expect(scoringConfig.setRule('activity.points_per_km', 'quince', 'admin-1')).rejects.toThrow(
      'El valor tiene que ser un número.'
    );
  });

  it('rechaza una regla inexistente con status 404', async () => {
    await expect(scoringConfig.setRule('clave.inventada', 1, 'admin-1')).rejects.toMatchObject({
      name: 'ScoringRuleError',
      status: 404,
      message: 'La regla "clave.inventada" no existe.',
    });
  });

  it('los errores de validación son ScoringRuleError con status 400', async () => {
    await expect(scoringConfig.setRule('activity.points_per_km', -1, 'admin-1')).rejects.toBeInstanceOf(
      ScoringRuleError
    );
    await expect(scoringConfig.setRule('activity.points_per_km', -1, 'admin-1')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('acepta los valores en los bordes del rango permitido', async () => {
    await expect(scoringConfig.setRule('activity.points_per_km', 0, 'admin-1')).resolves.toMatchObject({ value: 0 });
    await expect(scoringConfig.setRule('activity.points_per_km', 200, 'admin-1')).resolves.toMatchObject({ value: 200 });
  });
});

describe('caché', () => {
  it('no vuelve a consultar la base dentro del TTL', async () => {
    await scoringConfig.getValues();
    await scoringConfig.getValues();
    expect(prisma.scoringRule.findMany).toHaveBeenCalledTimes(1);
  });

  it('se invalida al guardar una regla y relee el valor nuevo', async () => {
    prisma.scoringRule.findMany.mockResolvedValue([]);
    await expect(scoringConfig.getValue('activity.points_per_km')).resolves.toBe(10);

    await scoringConfig.setRule('activity.points_per_km', 42, 'admin-1');
    prisma.scoringRule.findMany.mockResolvedValue([
      { key: 'activity.points_per_km', value: 42, isActive: true },
    ]);

    await expect(scoringConfig.getValue('activity.points_per_km')).resolves.toBe(42);
    expect(prisma.scoringRule.findMany).toHaveBeenCalledTimes(2);
  });

  it('se invalida al resetear las reglas', async () => {
    prisma.scoringRule.findMany.mockResolvedValue([
      { key: 'activity.points_per_km', value: 42, isActive: true },
    ]);
    await expect(scoringConfig.getValue('activity.points_per_km')).resolves.toBe(42);

    prisma.scoringRule.deleteMany.mockResolvedValue({ count: 1 });
    await expect(scoringConfig.resetRules()).resolves.toEqual({ reset: 1, group: 'ALL' });

    prisma.scoringRule.findMany.mockResolvedValue([]);
    await expect(scoringConfig.getValue('activity.points_per_km')).resolves.toBe(10);
  });

  it('resetRules rechaza un grupo inexistente sin tocar la base', async () => {
    await expect(scoringConfig.resetRules('GRUPO_FALSO')).rejects.toThrow('El grupo "GRUPO_FALSO" no existe.');
    expect(prisma.scoringRule.deleteMany).not.toHaveBeenCalled();
  });
});
