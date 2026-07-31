jest.mock('../src/lib/prisma', () => ({
  $transaction: jest.fn(),
  reward: { findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
  redemption: { create: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
  streak: { findUnique: jest.fn() },
  userScore: { findUnique: jest.fn(), upsert: jest.fn() },
  rank: { findUnique: jest.fn(), findFirst: jest.fn() },
  scoreEvent: { create: jest.fn(), aggregate: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  competitionGoal: { findMany: jest.fn() },
  scoringRule: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
}));

const { getEffectivePointsCost, isRewardAvailable } = require('../src/services/rewards.service');

const HORA = 60 * 60 * 1000;
const enElFuturo = () => new Date(Date.now() + 24 * HORA);
const enElPasado = () => new Date(Date.now() - 24 * HORA);

const negocioAprobado = { status: 'APPROVED', isActive: true };

const recompensa = (extra = {}) => ({
  status: 'ACTIVE',
  pointsCost: 100,
  isFeatured: false,
  featuredUntil: null,
  featuredDiscountPct: null,
  startsAt: null,
  expiresAt: null,
  stockRemaining: null,
  ...extra,
});

describe('getEffectivePointsCost', () => {
  it('devuelve el costo base cuando la recompensa no tiene descuento', () => {
    expect(getEffectivePointsCost(recompensa({ pointsCost: 250 }))).toBe(250);
  });

  it('aplica el descuento de una recompensa destacada con vigencia futura', () => {
    const reward = recompensa({
      pointsCost: 100,
      isFeatured: true,
      featuredUntil: enElFuturo(),
      featuredDiscountPct: 20,
    });
    expect(getEffectivePointsCost(reward)).toBe(80);
  });

  it('redondea el costo con descuento al entero más cercano', () => {
    const reward = recompensa({
      pointsCost: 333,
      isFeatured: true,
      featuredUntil: enElFuturo(),
      featuredDiscountPct: 15,
    });
    // 333 × 0.85 = 283.05
    expect(getEffectivePointsCost(reward)).toBe(283);
  });

  it('ignora el descuento cuando la vigencia de destacado ya venció', () => {
    const reward = recompensa({
      pointsCost: 100,
      isFeatured: true,
      featuredUntil: enElPasado(),
      featuredDiscountPct: 20,
    });
    expect(getEffectivePointsCost(reward)).toBe(100);
  });

  it('ignora el descuento cuando la recompensa no está destacada', () => {
    const reward = recompensa({
      pointsCost: 100,
      isFeatured: false,
      featuredUntil: enElFuturo(),
      featuredDiscountPct: 20,
    });
    expect(getEffectivePointsCost(reward)).toBe(100);
  });

  it('ignora el destacado sin fecha de vigencia', () => {
    const reward = recompensa({
      pointsCost: 100,
      isFeatured: true,
      featuredUntil: null,
      featuredDiscountPct: 20,
    });
    expect(getEffectivePointsCost(reward)).toBe(100);
  });

  it('ignora el destacado vigente sin porcentaje de descuento', () => {
    const reward = recompensa({
      pointsCost: 100,
      isFeatured: true,
      featuredUntil: enElFuturo(),
      featuredDiscountPct: null,
    });
    expect(getEffectivePointsCost(reward)).toBe(100);
  });

  it('un descuento del 100 por ciento deja la recompensa gratis', () => {
    const reward = recompensa({
      pointsCost: 100,
      isFeatured: true,
      featuredUntil: enElFuturo(),
      featuredDiscountPct: 100,
    });
    expect(getEffectivePointsCost(reward)).toBe(0);
  });

  it('una recompensa gratis sigue costando cero aunque esté destacada', () => {
    const reward = recompensa({
      pointsCost: 0,
      isFeatured: true,
      featuredUntil: enElFuturo(),
      featuredDiscountPct: 50,
    });
    expect(getEffectivePointsCost(reward)).toBe(0);
  });

  it('nunca devuelve un costo negativo si el costo base es negativo', () => {
    expect(getEffectivePointsCost(recompensa({ pointsCost: -500 }))).toBe(0);
  });

  it('trata un costo no numérico como cero', () => {
    expect(getEffectivePointsCost(recompensa({ pointsCost: 'gratis' }))).toBe(0);
    expect(getEffectivePointsCost(recompensa({ pointsCost: null }))).toBe(0);
  });
});

describe('isRewardAvailable', () => {
  it('una recompensa activa sin fechas ni stock está disponible', () => {
    expect(isRewardAvailable(recompensa(), negocioAprobado)).toBe(true);
  });

  it('no está disponible si todavía no arrancó', () => {
    expect(isRewardAvailable(recompensa({ startsAt: enElFuturo() }), negocioAprobado)).toBe(false);
  });

  it('está disponible si ya arrancó', () => {
    expect(isRewardAvailable(recompensa({ startsAt: enElPasado() }), negocioAprobado)).toBe(true);
  });

  it('no está disponible si ya venció', () => {
    expect(isRewardAvailable(recompensa({ expiresAt: enElPasado() }), negocioAprobado)).toBe(false);
  });

  it('está disponible si vence en el futuro', () => {
    expect(isRewardAvailable(recompensa({ expiresAt: enElFuturo() }), negocioAprobado)).toBe(true);
  });

  it('está disponible dentro de la ventana de vigencia', () => {
    const reward = recompensa({ startsAt: enElPasado(), expiresAt: enElFuturo() });
    expect(isRewardAvailable(reward, negocioAprobado)).toBe(true);
  });

  it('no está disponible con el stock agotado', () => {
    expect(isRewardAvailable(recompensa({ stockRemaining: 0 }), negocioAprobado)).toBe(false);
  });

  it('no está disponible con stock negativo', () => {
    expect(isRewardAvailable(recompensa({ stockRemaining: -1 }), negocioAprobado)).toBe(false);
  });

  it('está disponible con la última unidad de stock', () => {
    expect(isRewardAvailable(recompensa({ stockRemaining: 1 }), negocioAprobado)).toBe(true);
  });

  it('el stock nulo significa stock ilimitado', () => {
    expect(isRewardAvailable(recompensa({ stockRemaining: null }), negocioAprobado)).toBe(true);
  });

  it('no está disponible si la recompensa no está activa', () => {
    expect(isRewardAvailable(recompensa({ status: 'PAUSED' }), negocioAprobado)).toBe(false);
    expect(isRewardAvailable(recompensa({ status: 'DRAFT' }), negocioAprobado)).toBe(false);
  });

  it('no está disponible si el negocio no está aprobado', () => {
    expect(isRewardAvailable(recompensa(), { status: 'PENDING', isActive: true })).toBe(false);
  });

  it('no está disponible si el negocio está desactivado', () => {
    expect(isRewardAvailable(recompensa(), { status: 'APPROVED', isActive: false })).toBe(false);
  });
});
