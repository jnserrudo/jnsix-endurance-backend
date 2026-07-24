const prisma = require('../lib/prisma');
const rewardsService = require('../services/rewards.service');
const scoringService = require('../services/scoring.service');
const { notify } = require('../services/notifications.service');

const listBusinesses = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const search = req.query.search?.trim();
    const skip = (page - 1) * limit;

    const hasCoords = req.query.hasCoords === '1' || req.query.hasCoords === 'true';

    const where = {
      status: 'APPROVED',
      isActive: true,
      ...(search ? { name: { contains: search } } : {}),
      ...(hasCoords
        ? { latitude: { not: null }, longitude: { not: null } }
        : {})
    };

    const [businesses, total] = await Promise.all([
      prisma.business.findMany({
        where,
        skip,
        take: limit,
        include: {
          _count: { select: { rewards: { where: { status: 'ACTIVE' } } } }
        },
        orderBy: { name: 'asc' }
      }),
      prisma.business.count({ where })
    ]);

    res.json({ businesses, total, page, limit });
  } catch (error) {
    console.error('[ERROR] listBusinesses:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const getBusinessById = async (req, res) => {
  try {
    const business = await prisma.business.findFirst({
      where: { id: req.params.id, status: 'APPROVED', isActive: true },
      include: {
        rewards: {
          where: { status: 'ACTIVE' },
          orderBy: { pointsCost: 'asc' }
        }
      }
    });

    if (!business) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(business);
  } catch (error) {
    console.error('[ERROR] getBusinessById:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const getMyBusiness = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({
      where: { userId: req.user.id },
      include: {
        _count: { select: { rewards: true, redemptions: true } }
      }
    });

    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });
    res.json(business);
  } catch (error) {
    console.error('[ERROR] getMyBusiness:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const updateMyBusiness = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });
    if (business.status === 'REJECTED') {
      return res.status(403).json({ error: 'Tu cuenta de negocio fue rechazada' });
    }

    const { name, description, address, city, country, websiteUrl, instagramUrl, latitude, longitude } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre del negocio es obligatorio' });

    const lat =
      latitude === '' || latitude == null ? null : Number(latitude);
    const lng =
      longitude === '' || longitude == null ? null : Number(longitude);
    if (lat != null && Number.isNaN(lat)) {
      return res.status(400).json({ error: 'Latitud inválida' });
    }
    if (lng != null && Number.isNaN(lng)) {
      return res.status(400).json({ error: 'Longitud inválida' });
    }

    const updated = await prisma.business.update({
      where: { id: business.id },
      data: {
        name: name.trim(),
        description: description ?? business.description,
        address: address ?? business.address,
        city: city ?? business.city,
        country: country ?? business.country,
        websiteUrl: websiteUrl ?? business.websiteUrl,
        instagramUrl: instagramUrl ?? business.instagramUrl,
        ...(latitude !== undefined ? { latitude: lat } : {}),
        ...(longitude !== undefined ? { longitude: lng } : {})
      }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR] updateMyBusiness:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const uploadBusinessImage = (field) => async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Se requiere una imagen' });

    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });

    const url = `/uploads/${req.file.filename}`;
    const updated = await prisma.business.update({
      where: { id: business.id },
      data: { [field]: url }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR] uploadBusinessImage:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const listMyRewards = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });

    const rewards = await prisma.reward.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: 'desc' }
    });

    res.json(rewards);
  } catch (error) {
    console.error('[ERROR] listMyRewards:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const createMyReward = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });
    if (business.status !== 'APPROVED') {
      return res.status(403).json({ error: 'El negocio debe estar aprobado to create rewards' });
    }

    const {
      title, description, pointsCost, terms, stockTotal, maxPerUser,
      startsAt, expiresAt, minRankOrder
    } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: 'El t?tulo es obligatorio' });
    }
    const cost = parseInt(pointsCost, 10);
    if (Number.isNaN(cost) || cost < 0) {
      return res.status(400).json({ error: 'El costo en puntos debe ser 0 o mayor' });
    }

    const reward = await prisma.reward.create({
      data: {
        businessId: business.id,
        title: title.trim(),
        description: description || null,
        pointsCost: cost,
        terms: terms || null,
        stockTotal: stockTotal != null ? parseInt(stockTotal, 10) : null,
        stockRemaining: stockTotal != null ? parseInt(stockTotal, 10) : null,
        maxPerUser: maxPerUser != null ? parseInt(maxPerUser, 10) : null,
        startsAt: startsAt ? new Date(startsAt) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        minRankOrder: minRankOrder != null ? parseInt(minRankOrder, 10) : null,
        status: 'DRAFT'
      }
    });

    res.status(201).json(reward);
  } catch (error) {
    console.error('[ERROR] createMyReward:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const updateMyReward = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });

    const reward = await prisma.reward.findFirst({
      where: { id: req.params.id, businessId: business.id }
    });
    if (!reward) return res.status(404).json({ error: 'Premio no encontrado' });

    const data = { ...req.body };
    if (data.pointsCost != null && data.pointsCost !== '') {
      data.pointsCost = parseInt(data.pointsCost, 10);
      if (Number.isNaN(data.pointsCost) || data.pointsCost < 0) {
        return res.status(400).json({ error: 'El costo en puntos debe ser 0 o mayor' });
      }
    }
    if (data.stockTotal != null) {
      data.stockTotal = parseInt(data.stockTotal, 10);
      if (data.stockRemaining == null) data.stockRemaining = data.stockTotal;
    }
    if (data.startsAt) data.startsAt = new Date(data.startsAt);
    if (data.expiresAt) data.expiresAt = new Date(data.expiresAt);
    delete data.status;

    const updated = await prisma.reward.update({ where: { id: reward.id }, data });
    res.json(updated);
  } catch (error) {
    console.error('[ERROR] updateMyReward:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const updateMyRewardStatus = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });
    if (business.status !== 'APPROVED') {
      return res.status(403).json({ error: 'El negocio debe estar aprobado' });
    }

    const { status } = req.body;
    if (!['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED'].includes(status)) {
      return res.status(400).json({ error: 'Estado inv?lido' });
    }

    const reward = await prisma.reward.findFirst({
      where: { id: req.params.id, businessId: business.id }
    });
    if (!reward) return res.status(404).json({ error: 'Premio no encontrado' });

    const updated = await prisma.reward.update({
      where: { id: reward.id },
      data: { status }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR] updateMyRewardStatus:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const uploadRewardImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Se requiere una imagen' });

    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });

    const reward = await prisma.reward.findFirst({
      where: { id: req.params.id, businessId: business.id }
    });
    if (!reward) return res.status(404).json({ error: 'Premio no encontrado' });

    const url = `/uploads/${req.file.filename}`;
    const updated = await prisma.reward.update({
      where: { id: reward.id },
      data: { imageUrl: url }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR] uploadRewardImage:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const listMyRedemptions = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });

    const redemptions = await prisma.redemption.findMany({
      where: { businessId: business.id },
      include: {
        reward: { select: { id: true, title: true } },
        user: { select: { id: true, username: true, email: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json(redemptions);
  } catch (error) {
    console.error('[ERROR] listMyRedemptions:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const findBusinessRedemptionByCode = async (businessId, code) => {
  const normalized = code.trim().toUpperCase().replace(/\s/g, '');
  return prisma.redemption.findFirst({
    where: {
      OR: [{ code: normalized }, { code: code.trim().toUpperCase() }],
      businessId
    },
    include: {
      reward: { select: { id: true, title: true, pointsCost: true } },
      user: { select: { id: true, username: true, email: true, firstName: true, lastName: true } }
    }
  });
};

const lookupRedemption = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });

    const { code } = req.body;
    if (!code?.trim()) return res.status(400).json({ error: 'Código requerido' });

    const redemption = await findBusinessRedemptionByCode(business.id, code);
    if (!redemption) return res.status(404).json({ error: 'Cupón no encontrado' });

    if (redemption.status === 'USED') {
      return res.status(409).json({ error: 'Este cupón ya fue usado', redemption });
    }
    if (redemption.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'El cupón no está activo', redemption });
    }
    if (redemption.expiresAt && redemption.expiresAt < new Date()) {
      await prisma.redemption.update({ where: { id: redemption.id }, data: { status: 'EXPIRED' } });
      return res.status(400).json({ error: 'Cupón vencido', redemption });
    }

    res.json({ redemption, preview: true });
  } catch (error) {
    console.error('[ERROR] lookupRedemption:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const validateRedemption = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });

    const { code } = req.body;
    if (!code?.trim()) return res.status(400).json({ error: 'Código requerido' });

    const redemption = await findBusinessRedemptionByCode(business.id, code);
    if (!redemption) return res.status(404).json({ error: 'Cupón no encontrado' });

    if (redemption.status === 'USED') {
      return res.status(409).json({ error: 'Este cupón ya fue usado', redemption });
    }
    if (redemption.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'El cupón no está activo', redemption });
    }
    if (redemption.expiresAt && redemption.expiresAt < new Date()) {
      await prisma.redemption.update({ where: { id: redemption.id }, data: { status: 'EXPIRED' } });
      return res.status(400).json({ error: 'Cupón vencido', redemption });
    }

    const updated = await prisma.redemption.update({
      where: { id: redemption.id },
      data: { status: 'USED', usedAt: new Date() },
      include: {
        reward: { select: { id: true, title: true, pointsCost: true } },
        user: { select: { id: true, username: true, email: true } }
      }
    });

    // Aviso distinto al canje: el local ya usó el cupón (1 sola vez, con dedupe).
    await notify(updated.userId, 'SYSTEM', {
      title: 'Cupón validado',
      body: `"${updated.reward?.title || 'Tu cupón'}" fue marcado como usado en el local.`,
      payload: {
        type: 'REDEMPTION_USED',
        redemptionId: updated.id,
        screen: 'MyCoupons'
      },
      dedupeKey: `validate:${updated.id}`
    }).catch((err) => console.error('[validateRedemption] notify:', err.message));

    res.json({ message: 'Cupón validado', redemption: updated });
  } catch (error) {
    console.error('[ERROR] validateRedemption:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = {
  listBusinesses,
  getBusinessById,
  getMyBusiness,
  updateMyBusiness,
  uploadBusinessImage,
  listMyRewards,
  createMyReward,
  updateMyReward,
  updateMyRewardStatus,
  uploadRewardImage,
  listMyRedemptions,
  lookupRedemption,
  validateRedemption
};
