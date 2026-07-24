const prisma = require('../lib/prisma');
const rewardsService = require('../services/rewards.service');
const scoringService = require('../services/scoring.service');

const listBusinesses = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const search = req.query.search?.trim();
    const skip = (page - 1) * limit;

    const where = {
      status: 'APPROVED',
      isActive: true,
      ...(search ? { name: { contains: search } } : {})
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
    res.status(500).json({ error: 'Internal Server Error' });
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

    if (!business) return res.status(404).json({ error: 'Business not found' });
    res.json(business);
  } catch (error) {
    console.error('[ERROR] getBusinessById:', error);
    res.status(500).json({ error: 'Internal Server Error' });
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

    if (!business) return res.status(404).json({ error: 'Business profile not found' });
    res.json(business);
  } catch (error) {
    console.error('[ERROR] getMyBusiness:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateMyBusiness = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Business profile not found' });
    if (business.status === 'REJECTED') {
      return res.status(403).json({ error: 'Business account was rejected' });
    }

    const { name, description, address, city, country, websiteUrl, instagramUrl } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Business name is required' });

    const updated = await prisma.business.update({
      where: { id: business.id },
      data: {
        name: name.trim(),
        description: description ?? business.description,
        address: address ?? business.address,
        city: city ?? business.city,
        country: country ?? business.country,
        websiteUrl: websiteUrl ?? business.websiteUrl,
        instagramUrl: instagramUrl ?? business.instagramUrl
      }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR] updateMyBusiness:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const uploadBusinessImage = (field) => async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });

    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Business profile not found' });

    const url = `/uploads/${req.file.filename}`;
    const updated = await prisma.business.update({
      where: { id: business.id },
      data: { [field]: url }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR] uploadBusinessImage:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listMyRewards = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Business profile not found' });

    const rewards = await prisma.reward.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: 'desc' }
    });

    res.json(rewards);
  } catch (error) {
    console.error('[ERROR] listMyRewards:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const createMyReward = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Business profile not found' });
    if (business.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Business must be approved to create rewards' });
    }

    const {
      title, description, pointsCost, terms, stockTotal, maxPerUser,
      startsAt, expiresAt, minRankOrder
    } = req.body;

    if (!title?.trim() || !pointsCost || pointsCost <= 0) {
      return res.status(400).json({ error: 'Title and positive pointsCost are required' });
    }

    const reward = await prisma.reward.create({
      data: {
        businessId: business.id,
        title: title.trim(),
        description: description || null,
        pointsCost: parseInt(pointsCost, 10),
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
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateMyReward = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Business profile not found' });

    const reward = await prisma.reward.findFirst({
      where: { id: req.params.id, businessId: business.id }
    });
    if (!reward) return res.status(404).json({ error: 'Reward not found' });

    const data = { ...req.body };
    if (data.pointsCost) data.pointsCost = parseInt(data.pointsCost, 10);
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
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateMyRewardStatus = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Business profile not found' });
    if (business.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Business must be approved' });
    }

    const { status } = req.body;
    if (!['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const reward = await prisma.reward.findFirst({
      where: { id: req.params.id, businessId: business.id }
    });
    if (!reward) return res.status(404).json({ error: 'Reward not found' });

    const updated = await prisma.reward.update({
      where: { id: reward.id },
      data: { status }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR] updateMyRewardStatus:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const uploadRewardImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });

    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Business profile not found' });

    const reward = await prisma.reward.findFirst({
      where: { id: req.params.id, businessId: business.id }
    });
    if (!reward) return res.status(404).json({ error: 'Reward not found' });

    const url = `/uploads/${req.file.filename}`;
    const updated = await prisma.reward.update({
      where: { id: reward.id },
      data: { imageUrl: url }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR] uploadRewardImage:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listMyRedemptions = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Business profile not found' });

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
    res.status(500).json({ error: 'Internal Server Error' });
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
    if (!business) return res.status(404).json({ error: 'Business profile not found' });

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
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const validateRedemption = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Business profile not found' });

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

    res.json({ message: 'Cupón validado', redemption: updated });
  } catch (error) {
    console.error('[ERROR] validateRedemption:', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
