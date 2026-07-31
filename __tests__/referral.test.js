jest.mock('../src/lib/prisma', () => ({
  $transaction: jest.fn(),
  user: { findUnique: jest.fn(), update: jest.fn() },
  referral: { findUnique: jest.fn(), create: jest.fn(), count: jest.fn(), update: jest.fn() },
  activity: { findFirst: jest.fn() },
  scoreEvent: { create: jest.fn(), aggregate: jest.fn(), findFirst: jest.fn() },
  userScore: { findUnique: jest.fn(), upsert: jest.fn() },
  rank: { findFirst: jest.fn() },
  scoringRule: { findMany: jest.fn() },
}));

const prisma = require('../src/lib/prisma');
const { generateReferralCode, ensureUserReferralCode } = require('../src/services/referral.service');

const FORMATO_CODIGO = /^MERYT-[0-9A-F]{4}$/;

/** Distingue la búsqueda del usuario por id de la verificación de unicidad del código. */
const mockUserLookups = ({ porId, porCodigo }) => {
  prisma.user.findUnique.mockImplementation(async (args) => {
    if (args?.where?.referralCode !== undefined) return porCodigo(args.where.referralCode);
    return porId(args?.where?.id);
  });
};

describe('generateReferralCode', () => {
  it('genera un código con el prefijo y el formato esperados', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const code = await generateReferralCode();
    expect(code).toMatch(FORMATO_CODIGO);
  });

  it('verifica contra la base que el código no esté tomado', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const code = await generateReferralCode();
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { referralCode: code },
      select: { id: true },
    });
  });

  it('genera códigos únicos entre sí en tiradas consecutivas', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const codes = [];
    for (let i = 0; i < 200; i += 1) codes.push(await generateReferralCode());
    // La unicidad real la garantiza la consulta a base; acá comprobamos que el
    // generador tenga suficiente entropía como para no repetirse en seguida.
    expect(codes.every((c) => FORMATO_CODIGO.test(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(150);
  });

  it('reintenta con otro código cuando el primero ya está tomado', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 'usuario-existente' })
      .mockResolvedValueOnce(null);

    const code = await generateReferralCode();
    expect(code).toMatch(FORMATO_CODIGO);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it('falla con un error claro después de 10 colisiones', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'siempre-ocupado' });
    await expect(generateReferralCode()).rejects.toThrow('Could not generate a unique referral code.');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(10);
  });

  it('usa el cliente que se le pasa en lugar del prisma global', async () => {
    const tx = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
    const code = await generateReferralCode(tx);
    expect(code).toMatch(FORMATO_CODIGO);
    expect(tx.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('ensureUserReferralCode', () => {
  it('no regenera el código si el usuario ya tiene uno', async () => {
    mockUserLookups({
      porId: async () => ({ referralCode: 'MERYT-ABCD' }),
      porCodigo: async () => null,
    });

    await expect(ensureUserReferralCode('usuario-1')).resolves.toBe('MERYT-ABCD');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('genera y persiste un código cuando el usuario todavía no tiene', async () => {
    mockUserLookups({
      porId: async () => ({ referralCode: null }),
      porCodigo: async () => null,
    });
    prisma.user.update.mockImplementation(async (args) => ({ referralCode: args.data.referralCode }));

    const code = await ensureUserReferralCode('usuario-1');
    expect(code).toMatch(FORMATO_CODIGO);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'usuario-1' },
      data: { referralCode: code },
      select: { referralCode: true },
    });
  });

  it('falla cuando el usuario no existe', async () => {
    mockUserLookups({
      porId: async () => null,
      porCodigo: async () => null,
    });

    await expect(ensureUserReferralCode('usuario-fantasma')).rejects.toThrow('User not found.');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('reintenta cuando la base rechaza el código por duplicado (P2002)', async () => {
    mockUserLookups({
      porId: async () => ({ referralCode: null }),
      porCodigo: async () => null,
    });
    const duplicado = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    prisma.user.update
      .mockRejectedValueOnce(duplicado)
      .mockImplementationOnce(async (args) => ({ referralCode: args.data.referralCode }));

    const code = await ensureUserReferralCode('usuario-1');
    expect(code).toMatch(FORMATO_CODIGO);
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
  });

  it('falla con un error claro si no logra asignar un código único', async () => {
    mockUserLookups({
      porId: async () => ({ referralCode: null }),
      porCodigo: async () => null,
    });
    prisma.user.update.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));

    await expect(ensureUserReferralCode('usuario-1')).rejects.toThrow(
      'Could not assign a unique referral code.'
    );
    expect(prisma.user.update).toHaveBeenCalledTimes(5);
  });

  it('propaga un error de base que no sea de clave duplicada', async () => {
    mockUserLookups({
      porId: async () => ({ referralCode: null }),
      porCodigo: async () => null,
    });
    prisma.user.update.mockRejectedValue(new Error('conexión caída'));

    await expect(ensureUserReferralCode('usuario-1')).rejects.toThrow('conexión caída');
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });
});
