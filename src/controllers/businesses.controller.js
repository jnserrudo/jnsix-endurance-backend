const prisma = require('../lib/prisma');
const rewardsService = require('../services/rewards.service');
const scoringService = require('../services/scoring.service');
const { notify } = require('../services/notifications.service');

const CHECK_IN_POINTS = 5;
const CHECK_IN_RADIUS_M = 500;

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function countFriendsRedeemed(userId, businessId) {
  if (!userId) return 0;
  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ userId }, { friendId: userId }]
    },
    select: { userId: true, friendId: true }
  });
  const friendIds = [
    ...new Set(
      friendships.map((f) => (f.userId === userId ? f.friendId : f.userId))
    )
  ];
  if (friendIds.length === 0) return 0;
  const distinct = await prisma.redemption.findMany({
    where: {
      businessId,
      userId: { in: friendIds },
      status: { in: ['ACTIVE', 'USED'] }
    },
    select: { userId: true },
    distinct: ['userId']
  });
  return distinct.length;
}

const listBusinesses = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const search = req.query.search?.trim();
    const category = req.query.category?.trim();
    const skip = (page - 1) * limit;

    const hasCoords = req.query.hasCoords === '1' || req.query.hasCoords === 'true';
    const withRewards =
      req.query.withRewards === '1' || req.query.withRewards === 'true';

    const where = {
      status: 'APPROVED',
      isActive: true,
      ...(search ? { name: { contains: search } } : {}),
      ...(category ? { category: { equals: category } } : {}),
      ...(hasCoords
        ? { latitude: { not: null }, longitude: { not: null } }
        : {}),
      ...(withRewards
        ? { rewards: { some: { status: 'ACTIVE' } } }
        : {})
    };

    const [businesses, total] = await Promise.all([
      prisma.business.findMany({
        where,
        skip,
        take: limit,
        include: {
          _count: { select: { rewards: { where: { status: 'ACTIVE' } } } },
          rewards: {
            where: { status: 'ACTIVE' },
            select: { pointsCost: true },
            orderBy: { pointsCost: 'asc' },
            take: 1
          }
        },
        orderBy: { name: 'asc' }
      }),
      prisma.business.count({ where })
    ]);

    const qLat = parseFloat(req.query.nearLat ?? req.query.lat);
    const qLng = parseFloat(req.query.nearLng ?? req.query.lng);
    const hasNear = Number.isFinite(qLat) && Number.isFinite(qLng);

    const enriched = businesses.map((b) => {
      const minPointsCost = b.rewards?.[0]?.pointsCost ?? null;
      const { rewards, ...rest } = b;
      let distanceKm = null;
      if (hasNear && b.latitude != null && b.longitude != null) {
        distanceKm = haversineKm(qLat, qLng, b.latitude, b.longitude);
      }
      return { ...rest, minPointsCost, distanceKm };
    });

    if (hasNear) {
      enriched.sort((a, b) => {
        if (a.distanceKm == null && b.distanceKm == null) return 0;
        if (a.distanceKm == null) return 1;
        if (b.distanceKm == null) return -1;
        return a.distanceKm - b.distanceKm;
      });
    }

    res.json({ businesses: enriched, total, page, limit });
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

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [checkInsTotal, checkInsToday, userCheckInToday] = await Promise.all([
      prisma.businessCheckIn.count({ where: { businessId: business.id } }),
      prisma.businessCheckIn.count({
        where: { businessId: business.id, createdAt: { gte: todayStart } }
      }),
      req.user?.id
        ? prisma.businessCheckIn.findFirst({
            where: {
              businessId: business.id,
              userId: req.user.id,
              createdAt: { gte: todayStart }
            }
          })
        : null
    ]);

    let distanceKm = null;
    const qLat = parseFloat(req.query.lat);
    const qLng = parseFloat(req.query.lng);
    if (
      Number.isFinite(qLat) &&
      Number.isFinite(qLng) &&
      business.latitude != null &&
      business.longitude != null
    ) {
      distanceKm = haversineKm(qLat, qLng, business.latitude, business.longitude);
    }

    const friendsRedeemedCount = await countFriendsRedeemed(req.user?.id, business.id);

    res.json({
      ...business,
      checkInsTotal,
      checkInsToday,
      userCheckedInToday: Boolean(userCheckInToday),
      activeRewardsCount: business.rewards?.length || 0,
      distanceKm,
      checkInRadiusM: CHECK_IN_RADIUS_M,
      requiresProximity: business.latitude != null && business.longitude != null,
      friendsRedeemedCount
    });
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

    const {
      name,
      description,
      highlight,
      category,
      tags,
      hours,
      phone,
      galleryUrls,
      address,
      city,
      country,
      websiteUrl,
      instagramUrl,
      latitude,
      longitude
    } = req.body;
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

    let tagsValue = undefined;
    if (tags !== undefined) {
      if (Array.isArray(tags)) tagsValue = tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
      else if (typeof tags === 'string') {
        tagsValue = tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12);
      } else if (tags == null) tagsValue = null;
    }

    let galleryValue = undefined;
    if (galleryUrls !== undefined) {
      if (Array.isArray(galleryUrls)) {
        galleryValue = galleryUrls.map((u) => String(u).trim()).filter(Boolean).slice(0, 5);
      } else if (galleryUrls == null) galleryValue = null;
    }

    const updated = await prisma.business.update({
      where: { id: business.id },
      data: {
        name: name.trim(),
        description: description ?? business.description,
        ...(highlight !== undefined ? { highlight: highlight?.trim()?.slice(0, 160) || null } : {}),
        ...(category !== undefined ? { category: category?.trim() || null } : {}),
        ...(tagsValue !== undefined ? { tags: tagsValue } : {}),
        ...(hours !== undefined ? { hours: hours?.trim()?.slice(0, 120) || null } : {}),
        ...(phone !== undefined ? { phone: phone?.trim() || null } : {}),
        ...(galleryValue !== undefined ? { galleryUrls: galleryValue } : {}),
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

const getMyAnalytics = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });

    const requestedDays = Number.parseInt(req.query.days, 10);
    const periodDays = requestedDays === 30 ? 30 : 7;
    const periodStart = new Date();
    periodStart.setHours(0, 0, 0, 0);
    periodStart.setDate(periodStart.getDate() - (periodDays - 1));

    const [redemptions, checkIns, priorRedemptionAthletes, priorCheckInAthletes] = await Promise.all([
      prisma.redemption.findMany({
        where: { businessId: business.id, createdAt: { gte: periodStart } },
        select: { userId: true, rewardId: true, pointsSpent: true, createdAt: true, reward: { select: { title: true } } }
      }),
      prisma.businessCheckIn.findMany({
        where: { businessId: business.id, createdAt: { gte: periodStart } },
        select: { userId: true, createdAt: true }
      }),
      prisma.redemption.findMany({
        where: { businessId: business.id, createdAt: { lt: periodStart } },
        select: { userId: true },
        distinct: ['userId']
      }),
      prisma.businessCheckIn.findMany({
        where: { businessId: business.id, createdAt: { lt: periodStart } },
        select: { userId: true },
        distinct: ['userId']
      })
    ]);

    const dateKey = (date) => {
      const offset = date.getTimezoneOffset() * 60_000;
      return new Date(date.getTime() - offset).toISOString().slice(0, 10);
    };
    const dailyByDate = new Map();
    for (let index = 0; index < periodDays; index += 1) {
      const date = new Date(periodStart);
      date.setDate(periodStart.getDate() + index);
      dailyByDate.set(dateKey(date), { date: dateKey(date), redemptions: 0, checkIns: 0, pointsGranted: 0 });
    }
    redemptions.forEach((redemption) => {
      const day = dailyByDate.get(dateKey(redemption.createdAt));
      if (day) day.redemptions += 1;
    });
    checkIns.forEach((checkInRow) => {
      const day = dailyByDate.get(dateKey(checkInRow.createdAt));
      if (day) {
        day.checkIns += 1;
        day.pointsGranted += CHECK_IN_POINTS;
      }
    });

    const athleteIds = new Set([
      ...redemptions.map((redemption) => redemption.userId),
      ...checkIns.map((checkInRow) => checkInRow.userId)
    ]);
    const returningAthleteIds = new Set([
      ...priorRedemptionAthletes.map((athlete) => athlete.userId),
      ...priorCheckInAthletes.map((athlete) => athlete.userId)
    ]);
    const rewardCounts = new Map();
    redemptions.forEach((redemption) => {
      const current = rewardCounts.get(redemption.rewardId) || {
        id: redemption.rewardId,
        title: redemption.reward.title,
        redemptionCount: 0
      };
      current.redemptionCount += 1;
      rewardCounts.set(redemption.rewardId, current);
    });

    const redemptionsThisPeriod = redemptions.length;
    const checkInsThisPeriod = checkIns.length;
    const pointsGranted = checkInsThisPeriod * CHECK_IN_POINTS;
    const todayKey = dateKey(new Date());
    const checkInsToday = dailyByDate.get(todayKey)?.checkIns || 0;

    res.json({
      periodDays,
      periodStart: periodStart.toISOString(),
      dailySeries: Array.from(dailyByDate.values()),
      redemptionsThisPeriod,
      uniqueAthletes: athleteIds.size,
      checkInsThisPeriod,
      checkInsToday,
      pointsGranted,
      topRewards: Array.from(rewardCounts.values())
        .sort((a, b) => b.redemptionCount - a.redemptionCount)
        .slice(0, 5),
      newVsReturning: {
        newAthletes: Array.from(athleteIds).filter((id) => !returningAthleteIds.has(id)).length,
        returningAthletes: Array.from(athleteIds).filter((id) => returningAthleteIds.has(id)).length
      },
      // Campos legacy para clientes que todavía muestran la semana.
      redemptionsThisWeek: periodDays === 7 ? redemptionsThisPeriod : undefined,
      checkInsThisWeek: periodDays === 7 ? checkInsThisPeriod : undefined
    });
  } catch (error) {
    console.error('[ERROR] getMyAnalytics:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const checkIn = async (req, res) => {
  try {
    const userId = req.user.id;
    const businessId = req.params.id;
    const clientLat = parseFloat(req.body?.latitude ?? req.body?.lat);
    const clientLng = parseFloat(req.body?.longitude ?? req.body?.lng);

    const business = await prisma.business.findFirst({
      where: { id: businessId, status: 'APPROVED', isActive: true },
      include: {
        rewards: {
          where: { status: 'ACTIVE' },
          orderBy: { pointsCost: 'asc' },
          take: 8
        }
      }
    });
    if (!business) return res.status(404).json({ error: 'Negocio no encontrado' });

    const requiresProximity =
      business.latitude != null && business.longitude != null;
    let distanceM = null;

    if (requiresProximity) {
      if (!Number.isFinite(clientLat) || !Number.isFinite(clientLng)) {
        return res.status(400).json({
          error: 'Necesitamos tu ubicación para el check-in en este local',
          code: 'LOCATION_REQUIRED',
          checkInRadiusM: CHECK_IN_RADIUS_M
        });
      }
      distanceM =
        haversineKm(clientLat, clientLng, business.latitude, business.longitude) * 1000;
      if (distanceM > CHECK_IN_RADIUS_M) {
        const km = distanceM / 1000;
        const human =
          km >= 1
            ? `${km.toFixed(1).replace('.', ',')} km`
            : `${Math.round(distanceM)} m`;
        return res.status(403).json({
          error: `Estás a ${human}; acercate a menos de ${CHECK_IN_RADIUS_M} m para el check-in`,
          code: 'TOO_FAR',
          distanceM: Math.round(distanceM),
          checkInRadiusM: CHECK_IN_RADIUS_M
        });
      }
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const already = await prisma.businessCheckIn.findFirst({
      where: {
        userId,
        businessId,
        createdAt: { gte: todayStart }
      }
    });
    if (already) {
      return res.status(409).json({
        error: 'Ya hiciste check-in hoy en este local',
        checkIn: already
      });
    }

    const checkInRow = await prisma.businessCheckIn.create({
      data: { userId, businessId }
    });

    const award = await scoringService.awardPoints(userId, {
      points: CHECK_IN_POINTS,
      reason: `Check-in en ${business.name}`
    });

    const totalPoints =
      award.scoreResult?.userScore?.totalPoints ??
      (await prisma.userScore.findUnique({ where: { userId } }))?.totalPoints ??
      0;

    const redeemableRewards = (business.rewards || []).map((r) => {
      const effectiveCost = rewardsService.getEffectivePointsCost(r);
      return {
        id: r.id,
        title: r.title,
        imageUrl: r.imageUrl,
        pointsCost: r.pointsCost,
        effectiveCost,
        pointsNeeded: Math.max(0, effectiveCost - totalPoints),
        canRedeem: totalPoints >= effectiveCost
      };
    });

    // Gamification hook (missions/badges) — best-effort
    try {
      const gamification = require('../services/gamification.service');
      if (typeof gamification.onBusinessCheckIn === 'function') {
        await gamification.onBusinessCheckIn(userId, businessId);
      }
    } catch (gErr) {
      console.warn('[checkIn] gamification:', gErr.message);
    }

    res.status(201).json({
      checkIn: checkInRow,
      pointsAwarded: CHECK_IN_POINTS,
      newTotalPoints: totalPoints,
      distanceM: distanceM != null ? Math.round(distanceM) : null,
      requiresProximity,
      redeemableRewards,
      business: {
        id: business.id,
        name: business.name,
        logoUrl: business.logoUrl
      }
    });
  } catch (error) {
    console.error('[ERROR] checkIn:', error);
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
    if (!code?.trim()) return res.status(400).json({ error: 'C?digo requerido' });

    const redemption = await findBusinessRedemptionByCode(business.id, code);
    if (!redemption) return res.status(404).json({ error: 'Cup?n no encontrado' });

    if (redemption.status === 'USED') {
      return res.status(409).json({ error: 'Este cup?n ya fue usado', redemption });
    }
    if (redemption.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'El cup?n no est? activo', redemption });
    }
    if (redemption.expiresAt && redemption.expiresAt < new Date()) {
      await prisma.redemption.update({ where: { id: redemption.id }, data: { status: 'EXPIRED' } });
      return res.status(400).json({ error: 'Cup?n vencido', redemption });
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
    if (!code?.trim()) return res.status(400).json({ error: 'C?digo requerido' });

    const redemption = await findBusinessRedemptionByCode(business.id, code);
    if (!redemption) return res.status(404).json({ error: 'Cup?n no encontrado' });

    if (redemption.status === 'USED') {
      return res.status(409).json({ error: 'Este cup?n ya fue usado', redemption });
    }
    if (redemption.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'El cup?n no est? activo', redemption });
    }
    if (redemption.expiresAt && redemption.expiresAt < new Date()) {
      await prisma.redemption.update({ where: { id: redemption.id }, data: { status: 'EXPIRED' } });
      return res.status(400).json({ error: 'Cup?n vencido', redemption });
    }

    const updated = await prisma.redemption.update({
      where: { id: redemption.id },
      data: { status: 'USED', usedAt: new Date() },
      include: {
        reward: { select: { id: true, title: true, pointsCost: true } },
        user: { select: { id: true, username: true, email: true } }
      }
    });

    // Aviso distinto al canje: el local ya us? el cup?n (1 sola vez, con dedupe).
    await notify(updated.userId, 'SYSTEM', {
      title: 'Cup?n validado',
      body: `"${updated.reward?.title || 'Tu cup?n'}" fue marcado como usado en el local.`,
      payload: {
        type: 'REDEMPTION_USED',
        redemptionId: updated.id,
        screen: 'MyCoupons'
      },
      dedupeKey: `validate:${updated.id}`
    }).catch((err) => console.error('[validateRedemption] notify:', err.message));

    res.json({ message: 'Cup?n validado', redemption: updated });
  } catch (error) {
    console.error('[ERROR] validateRedemption:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const listMySettlements = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });

    const settlements = await prisma.settlement.findMany({
      where: { businessId: business.id },
      orderBy: { periodEnd: 'desc' },
      take: 50,
    });
    res.json({ settlements });
  } catch (error) {
    console.error('[ERROR] listMySettlements:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const featureMyReward = async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { userId: req.user.id } });
    if (!business) return res.status(404).json({ error: 'Perfil de negocio no encontrado' });
    if (business.status !== 'APPROVED') {
      return res.status(403).json({ error: 'El negocio debe estar aprobado' });
    }

    const reward = await prisma.reward.findFirst({
      where: { id: req.params.id, businessId: business.id }
    });
    if (!reward) return res.status(404).json({ error: 'Premio no encontrado' });
    if (reward.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Solo se pueden destacar premios activos' });
    }

    const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 7, 1), 30);
    const discountPct = Math.min(
      Math.max(parseInt(req.body?.discountPct, 10) || 10, 0),
      50
    );
    const featuredUntil = new Date();
    featuredUntil.setDate(featuredUntil.getDate() + days);

    // Un solo featured activo por negocio a la vez
    await prisma.reward.updateMany({
      where: {
        businessId: business.id,
        isFeatured: true,
        id: { not: reward.id }
      },
      data: {
        isFeatured: false,
        featuredUntil: null,
        featuredDiscountPct: null
      }
    });

    const updated = await prisma.reward.update({
      where: { id: reward.id },
      data: {
        isFeatured: true,
        featuredUntil,
        featuredDiscountPct: discountPct
      }
    });

    res.json({
      reward: updated,
      message: `Destacado hasta ${featuredUntil.toISOString().slice(0, 10)} (−${discountPct}%)`
    });
  } catch (error) {
    console.error('[ERROR] featureMyReward:', error);
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
  getMyAnalytics,
  checkIn,
  lookupRedemption,
  validateRedemption,
  listMySettlements,
  featureMyReward,
};
