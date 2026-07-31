const prisma = require('../lib/prisma');

/**
 * Códigos de descuento para suscripciones y campañas del Club.
 *
 * Los modelos `DiscountCode` y `DiscountRedemption` ya existían en el schema sin
 * que ningún código los tocara; este servicio es la única puerta de entrada.
 */

class DiscountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DiscountError';
    this.status = status;
  }
}

const normalizeCode = (code) => String(code || '').trim().toUpperCase();

/**
 * Busca el código y verifica que se pueda usar. No registra nada: sirve tanto
 * para el "ver cuánto me descuenta" del móvil como para el cobro real.
 */
const validateCode = async (rawCode, userId) => {
  const code = normalizeCode(rawCode);
  if (!code) throw new DiscountError('Escribí un código para validar.');

  const discount = await prisma.discountCode.findUnique({
    where: { code },
    include: {
      redemptions: userId ? { where: { userId }, select: { id: true } } : false,
    },
  });

  if (!discount || discount.deletedAt) {
    throw new DiscountError('Ese código no existe. Revisá que esté bien escrito.', 404);
  }
  if (!discount.isActive) {
    throw new DiscountError('Ese código ya no está disponible.');
  }
  if (discount.expiresAt && discount.expiresAt < new Date()) {
    throw new DiscountError('Ese código venció.');
  }
  if (discount.maxUses != null && discount.usedCount >= discount.maxUses) {
    throw new DiscountError('Ese código llegó a su límite de usos.');
  }
  if (userId && discount.redemptions?.length > 0) {
    throw new DiscountError('Ya usaste este código antes.');
  }

  return discount;
};

/** Aplica el descuento a un importe, sin dejar que el total baje de cero. */
const applyToAmount = (discount, baseAmount) => {
  const amount = Number(baseAmount) || 0;
  if (amount <= 0) return { finalAmount: 0, discountAmount: 0 };

  const discountAmount =
    discount.discountType === 'PERCENT'
      ? (amount * Number(discount.value)) / 100
      : Number(discount.value);

  const capped = Math.min(Math.max(discountAmount, 0), amount);

  return {
    discountAmount: Number(capped.toFixed(2)),
    finalAmount: Number((amount - capped).toFixed(2)),
  };
};

const describe = (discount) =>
  discount.discountType === 'PERCENT'
    ? `${Number(discount.value)}% de descuento`
    : `USD ${Number(discount.value).toFixed(2)} de descuento`;

/**
 * Registra el uso. Va en transacción con el incremento de `usedCount` para que
 * dos personas usando el último cupón a la vez no lo pasen del límite.
 */
const redeemCode = async (rawCode, userId) => {
  const discount = await validateCode(rawCode, userId);

  return prisma.$transaction(async (tx) => {
    const fresh = await tx.discountCode.findUnique({ where: { id: discount.id } });

    if (fresh.maxUses != null && fresh.usedCount >= fresh.maxUses) {
      throw new DiscountError('Ese código llegó a su límite de usos.');
    }

    const already = await tx.discountRedemption.findFirst({
      where: { discountCodeId: fresh.id, userId },
      select: { id: true },
    });
    if (already) throw new DiscountError('Ya usaste este código antes.');

    await tx.discountRedemption.create({
      data: { discountCodeId: fresh.id, userId },
    });

    const updated = await tx.discountCode.update({
      where: { id: fresh.id },
      data: { usedCount: { increment: 1 } },
    });

    return updated;
  });
};

const listCodes = async ({ includeInactive = true } = {}) => {
  const codes = await prisma.discountCode.findMany({
    where: {
      deletedAt: null,
      ...(includeInactive ? {} : { isActive: true }),
    },
    include: { _count: { select: { redemptions: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return codes.map((c) => ({
    ...c,
    redemptionCount: c._count.redemptions,
    label: describe(c),
    isExpired: !!(c.expiresAt && c.expiresAt < new Date()),
    isExhausted: c.maxUses != null && c.usedCount >= c.maxUses,
    _count: undefined,
  }));
};

const createCode = async (data) => {
  const code = normalizeCode(data.code);
  if (!code) throw new DiscountError('El código es obligatorio.');
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    throw new DiscountError('Usá entre 3 y 32 caracteres: letras, números, guion o guion bajo.');
  }
  if (!['PERCENT', 'FIXED'].includes(data.discountType)) {
    throw new DiscountError('El tipo tiene que ser porcentaje o monto fijo.');
  }

  const value = Number(data.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new DiscountError('El valor del descuento tiene que ser mayor a cero.');
  }
  if (data.discountType === 'PERCENT' && value > 100) {
    throw new DiscountError('Un descuento porcentual no puede pasar de 100.');
  }

  const existing = await prisma.discountCode.findUnique({ where: { code } });
  if (existing) throw new DiscountError('Ya existe un código con ese nombre.', 409);

  return prisma.discountCode.create({
    data: {
      code,
      discountType: data.discountType,
      value,
      maxUses: data.maxUses != null && data.maxUses !== '' ? Number(data.maxUses) : null,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      isActive: data.isActive !== false,
    },
  });
};

const updateCode = async (id, data) => {
  const current = await prisma.discountCode.findUnique({ where: { id } });
  if (!current || current.deletedAt) {
    throw new DiscountError('No encontramos ese código.', 404);
  }

  const patch = {};

  if (data.value != null) {
    const value = Number(data.value);
    if (!Number.isFinite(value) || value <= 0) {
      throw new DiscountError('El valor del descuento tiene que ser mayor a cero.');
    }
    const type = data.discountType || current.discountType;
    if (type === 'PERCENT' && value > 100) {
      throw new DiscountError('Un descuento porcentual no puede pasar de 100.');
    }
    patch.value = value;
  }

  if (data.discountType) {
    if (!['PERCENT', 'FIXED'].includes(data.discountType)) {
      throw new DiscountError('El tipo tiene que ser porcentaje o monto fijo.');
    }
    patch.discountType = data.discountType;
  }

  if (data.maxUses !== undefined) {
    patch.maxUses =
      data.maxUses === null || data.maxUses === '' ? null : Number(data.maxUses);
  }
  if (data.expiresAt !== undefined) {
    patch.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  }
  if (data.isActive !== undefined) patch.isActive = !!data.isActive;

  return prisma.discountCode.update({ where: { id }, data: patch });
};

/** Baja lógica: los canjes ya hechos tienen que seguir siendo auditables. */
const deleteCode = async (id) => {
  const current = await prisma.discountCode.findUnique({ where: { id } });
  if (!current || current.deletedAt) {
    throw new DiscountError('No encontramos ese código.', 404);
  }
  return prisma.discountCode.update({
    where: { id },
    data: { deletedAt: new Date(), isActive: false },
  });
};

module.exports = {
  DiscountError,
  validateCode,
  redeemCode,
  applyToAmount,
  describe,
  listCodes,
  createCode,
  updateCode,
  deleteCode,
  normalizeCode,
};
