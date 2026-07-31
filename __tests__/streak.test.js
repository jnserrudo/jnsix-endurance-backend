const { calculateStreakFromDates } = require('../src/utils/streak');

// El cálculo compara contra "hoy", así que el reloj se congela para que los
// resultados no dependan del momento en que corre la suite.
const HOY = new Date(2026, 6, 15, 12, 0, 0);

/** Mediodía local de hace `diasAtras` días, alineado con el cursor del cálculo. */
const diaLocal = (diasAtras) => new Date(2026, 6, 15 - diasAtras, 12, 0, 0);

beforeAll(() => {
  jest.useFakeTimers({ now: HOY, doNotFake: ['nextTick', 'setImmediate'] });
});

afterAll(() => {
  jest.useRealTimers();
});

describe('calculateStreakFromDates', () => {
  describe('sin datos', () => {
    it('una lista vacía no tiene racha', () => {
      expect(calculateStreakFromDates([])).toBe(0);
    });

    it('una lista nula no tiene racha', () => {
      expect(calculateStreakFromDates(null)).toBe(0);
      expect(calculateStreakFromDates(undefined)).toBe(0);
    });
  });

  describe('rachas vigentes', () => {
    it('un solo día de hoy da una racha de 1', () => {
      expect(calculateStreakFromDates([diaLocal(0)])).toBe(1);
    });

    it('cuenta los días consecutivos hacia atrás desde hoy', () => {
      const fechas = [diaLocal(0), diaLocal(1), diaLocal(2)];
      expect(calculateStreakFromDates(fechas)).toBe(3);
    });

    it('cuenta una racha larga completa', () => {
      const fechas = Array.from({ length: 30 }, (_, i) => diaLocal(i));
      expect(calculateStreakFromDates(fechas)).toBe(30);
    });

    it('sigue contando la racha si la última actividad fue ayer', () => {
      const fechas = [diaLocal(1), diaLocal(2)];
      expect(calculateStreakFromDates(fechas)).toBe(2);
    });

    it('un solo día de ayer da una racha de 1', () => {
      expect(calculateStreakFromDates([diaLocal(1)])).toBe(1);
    });
  });

  describe('huecos que cortan la racha', () => {
    it('un hueco corta la racha en el último día consecutivo', () => {
      // Hoy y ayer siguen, pero falta anteayer: la racha vale 2.
      const fechas = [diaLocal(0), diaLocal(1), diaLocal(4), diaLocal(5)];
      expect(calculateStreakFromDates(fechas)).toBe(2);
    });

    it('una racha que terminó hace más de un día no cuenta', () => {
      const fechas = [diaLocal(3), diaLocal(4), diaLocal(5)];
      expect(calculateStreakFromDates(fechas)).toBe(0);
    });

    it('un día aislado en el pasado no cuenta', () => {
      expect(calculateStreakFromDates([diaLocal(10)])).toBe(0);
    });
  });

  describe('duplicados y desorden', () => {
    it('dos actividades del mismo día cuentan como un solo día', () => {
      const fechas = [diaLocal(0), diaLocal(0), diaLocal(1)];
      expect(calculateStreakFromDates(fechas)).toBe(2);
    });

    it('tres actividades del mismo día no inflan la racha', () => {
      const fechas = [diaLocal(0), diaLocal(0), diaLocal(0)];
      expect(calculateStreakFromDates(fechas)).toBe(1);
    });

    it('no depende del orden en que llegan las fechas', () => {
      const fechas = [diaLocal(2), diaLocal(0), diaLocal(1)];
      expect(calculateStreakFromDates(fechas)).toBe(3);
    });

    it('desordenadas y con duplicados da el mismo resultado que ordenadas', () => {
      const desordenadas = [diaLocal(1), diaLocal(3), diaLocal(0), diaLocal(1), diaLocal(2)];
      const ordenadas = [diaLocal(0), diaLocal(1), diaLocal(2), diaLocal(3)];
      expect(calculateStreakFromDates(desordenadas)).toBe(calculateStreakFromDates(ordenadas));
      expect(calculateStreakFromDates(desordenadas)).toBe(4);
    });
  });

  describe('formatos de fecha', () => {
    it('acepta fechas como string ISO', () => {
      const fechas = [diaLocal(0).toISOString(), diaLocal(1).toISOString()];
      expect(calculateStreakFromDates(fechas)).toBe(2);
    });

    it('acepta una mezcla de Date y string', () => {
      const fechas = [diaLocal(0), diaLocal(1).toISOString(), diaLocal(2)];
      expect(calculateStreakFromDates(fechas)).toBe(3);
    });
  });
});
