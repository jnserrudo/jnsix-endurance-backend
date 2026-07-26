const prisma = require('../lib/prisma');
const storage = require('../services/storage.service');
const { getBlockedUserIds } = require('../lib/social');

const PROFILE_SELECT = {
  id: true,
  email: true,
  username: true,
  role: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  coverUrl: true,
  bio: true,
  birthDate: true,
  gender: true,
  heightCm: true,
  weightKg: true,
  primarySport: true,
  experienceLevel: true,
  phone: true,
  city: true,
  country: true,
  instagramUrl: true,
  profileVisibility: true,
  statsVisible: true,
  activitiesVisible: true,
  stravaId: true,
  emailVerified: true,
  createdAt: true,
  onboardingCompleted: true,
  onboardingData: true,
  coachMemory: true,
  hrZones: true,
  paceZones: true,
  powerZones: true,
  totpEnabled: true,
  userScore: {
    include: {
      currentRank: true,
      currentCategory: true
    }
  },
  _count: {
    select: {
      activities: true
    }
  }
};

const PUBLIC_CARD_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  city: true,
  country: true
};

const getMyProfile = async (req, res) => {
  try {
    const [user, activityStats] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user.id },
        select: PROFILE_SELECT
      }),
      prisma.activity.aggregate({
        where: { userId: req.user.id },
        _sum: { distanceKm: true, movingTime: true }
      })
    ]);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({
      ...user,
      totalDistance: activityStats._sum.distanceKm || 0,
      totalTime: activityStats._sum.movingTime || 0
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateCoachMemory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { coachMemory } = req.body;
    if (coachMemory === undefined) {
      return res.status(400).json({ error: 'Enviá coachMemory para guardar.' });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { coachMemory },
      select: PROFILE_SELECT,
    });
    res.json(user);
  } catch (error) {
    console.error('[ERROR] updateCoachMemory:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateMyProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      firstName,
      lastName,
      bio,
      birthDate,
      gender,
      heightCm,
      weightKg,
      primarySport,
      experienceLevel,
      phone,
      city,
      country,
      instagramUrl,
      username,
      profileVisibility,
      statsVisible,
      activitiesVisible,
      onboardingCompleted,
      coachMemory,
      hrZones,
      paceZones,
      powerZones,
      onboardingData
    } = req.body;

    if (username) {
      const existing = await prisma.user.findUnique({ where: { username } });
      if (existing && existing.id !== userId) {
        return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso' });
      }
    }

    if (profileVisibility && !['PUBLIC', 'FRIENDS', 'PRIVATE'].includes(profileVisibility)) {
      return res.status(400).json({ error: 'profileVisibility inválido' });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(firstName !== undefined && { firstName }),
        ...(lastName !== undefined && { lastName }),
        ...(bio !== undefined && { bio }),
        ...(birthDate !== undefined && { birthDate: birthDate ? new Date(birthDate) : null }),
        ...(gender !== undefined && { gender }),
        ...(heightCm !== undefined && { heightCm: heightCm === null ? null : Number(heightCm) }),
        ...(weightKg !== undefined && { weightKg: weightKg === null ? null : Number(weightKg) }),
        ...(primarySport !== undefined && { primarySport }),
        ...(experienceLevel !== undefined && { experienceLevel }),
        ...(phone !== undefined && { phone }),
        ...(city !== undefined && { city }),
        ...(country !== undefined && { country }),
        ...(instagramUrl !== undefined && { instagramUrl }),
        ...(username !== undefined && { username }),
        ...(profileVisibility !== undefined && { profileVisibility }),
        ...(statsVisible !== undefined && { statsVisible: Boolean(statsVisible) }),
        ...(activitiesVisible !== undefined && { activitiesVisible: Boolean(activitiesVisible) }),
        ...(onboardingCompleted !== undefined && { onboardingCompleted: Boolean(onboardingCompleted) }),
        ...(coachMemory !== undefined && { coachMemory }),
        ...(hrZones !== undefined && { hrZones }),
        ...(paceZones !== undefined && { paceZones }),
        ...(powerZones !== undefined && { powerZones }),
        ...(onboardingData !== undefined && { onboardingData })
      },
      select: PROFILE_SELECT
    });

    res.json(user);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const uploadAvatar = async (req, res) => {
  try {
    const userId = req.user.id;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        error: 'No recibimos la imagen. Probá elegir otra desde la galería.',
        code: 'IMAGE_MISSING',
      });
    }

    if (!file.buffer || !file.buffer.length) {
      return res.status(400).json({
        error: 'La imagen llegó vacía. Intentá de nuevo con otra foto.',
        code: 'IMAGE_EMPTY',
      });
    }

    const uploadResult = await storage.uploadFile(file, userId);

    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: uploadResult.url },
      select: PROFILE_SELECT
    });

    res.json(user);
  } catch (error) {
    console.error('[ERROR] uploadAvatar:', error);
    res.status(500).json({
      error: 'No pudimos guardar tu foto de perfil. Intentá de nuevo.',
      code: 'AVATAR_UPLOAD_FAILED',
    });
  }
};

const uploadCover = async (req, res) => {
  try {
    const userId = req.user.id;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        error: 'No recibimos la imagen. Probá elegir otra desde la galería.',
        code: 'IMAGE_MISSING',
      });
    }

    if (!file.buffer || !file.buffer.length) {
      return res.status(400).json({
        error: 'La imagen llegó vacía. Intentá de nuevo con otra foto.',
        code: 'IMAGE_EMPTY',
      });
    }

    const uploadResult = await storage.uploadFile(file, userId);

    const user = await prisma.user.update({
      where: { id: userId },
      data: { coverUrl: uploadResult.url },
      select: PROFILE_SELECT
    });

    res.json(user);
  } catch (error) {
    console.error('[ERROR] uploadCover:', error);
    res.status(500).json({
      error: 'No pudimos guardar tu foto de portada. Intentá de nuevo.',
      code: 'COVER_UPLOAD_FAILED',
    });
  }
};

const getUserPublicProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const viewerId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id },
      select: { ...PROFILE_SELECT, deletedAt: true, isActive: true }
    });

    if (!user || !user.isActive || user.deletedAt) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const isSelf = viewerId === id;

    let isFriend = false;
    if (!isSelf) {
      const friendship = await prisma.friendship.findFirst({
        where: {
          status: 'ACCEPTED',
          OR: [
            { userId: viewerId, friendId: id },
            { userId: id, friendId: viewerId }
          ]
        }
      });
      isFriend = Boolean(friendship);
    }

    const canViewProfile =
      isSelf ||
      user.profileVisibility === 'PUBLIC' ||
      (user.profileVisibility === 'FRIENDS' && isFriend);

    if (!canViewProfile) {
      return res.json({
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        profileVisibility: user.profileVisibility,
        restricted: true
      });
    }

    const canViewStats = isSelf || user.statsVisible;
    const canViewActivities = isSelf || user.activitiesVisible;

    let userScore = null;
    if (canViewStats) {
      userScore = await prisma.userScore.findUnique({
        where: { userId: id },
        include: {
          currentRank: { select: { name: true } },
          currentCategory: { select: { name: true } }
        }
      });
    }

    let recentActivities = [];
    if (canViewActivities) {
      recentActivities = await prisma.activity.findMany({
        where: { userId: id },
        orderBy: { startDate: 'desc' },
        take: 10,
        select: {
          id: true,
          name: true,
          type: true,
          distanceKm: true,
          elevationM: true,
          movingTime: true,
          startDate: true
        }
      });
    }

    // Logros y badges (para mostrar en el perfil público)
    let achievementsCount = 0;
    let badges = [];
    if (canViewStats) {
      [achievementsCount, badges] = await Promise.all([
        prisma.userAchievement.count({ where: { userId: id } }),
        prisma.userBadge.findMany({
          where: { userId: id },
          orderBy: { earnedAt: 'desc' },
          take: 12,
          include: { badge: { select: { id: true, name: true, iconUrl: true, description: true } } }
        })
      ]);
    }

    const [myGroupIds, myCommunityIds] = await Promise.all([
      prisma.groupMember.findMany({ where: { userId: viewerId }, select: { groupId: true } }),
      prisma.communityMember.findMany({ where: { userId: viewerId }, select: { communityId: true } })
    ]);

    const [theirGroups, theirCommunities] = await Promise.all([
      prisma.groupMember.findMany({
        where: { userId: id, groupId: { in: myGroupIds.map((g) => g.groupId) } },
        include: { group: { select: { id: true, name: true, avatarUrl: true } } }
      }),
      prisma.communityMember.findMany({
        where: { userId: id, communityId: { in: myCommunityIds.map((c) => c.communityId) } },
        include: { community: { select: { id: true, name: true } } }
      })
    ]);

    const { deletedAt, isActive, ...safeUser } = user;

    res.json({
      ...safeUser,
      isFriend,
      isSelf,
      stats: canViewStats ? userScore : null,
      achievementsCount,
      badges: badges.map((b) => ({ id: b.badge.id, name: b.badge.name, iconUrl: b.badge.iconUrl, description: b.badge.description })),
      recentActivities: canViewActivities ? recentActivities : [],
      mutualGroups: theirGroups.map((g) => g.group),
      mutualCommunities: theirCommunities.map((c) => c.community),
      restricted: false
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const searchUsers = async (req, res) => {
  try {
    const { q = '' } = req.query;
    const userId = req.user.id;

    if (!q || q.trim().length === 0) {
      return res.json([]);
    }

    const blockedIds = await getBlockedUserIds(userId);

    const users = await prisma.user.findMany({
      where: {
        id: { not: userId, ...(blockedIds.length ? { notIn: blockedIds } : {}) },
        isActive: true,
        deletedAt: null,
        OR: [
          { email: { contains: q } },
          { username: { contains: q } },
          { firstName: { contains: q } },
          { lastName: { contains: q } }
        ]
      },
      select: PUBLIC_CARD_SELECT,
      take: 20
    });

    res.json(users);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * Sugerencias de atletas para descubrir: usuarios que NO son amigos, no están
 * bloqueados y no soy yo. Filtra opcionalmente por deporte (?sport=) y ciudad (?city=).
 */
const discoverAthletes = async (req, res) => {
  try {
    const userId = req.user.id;
    const { sport, city } = req.query;

    // Amigos actuales y solicitudes pendientes (en cualquier dirección)
    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ userId }, { friendId: userId }] },
      select: { userId: true, friendId: true }
    });
    const relatedIds = new Set();
    for (const f of friendships) {
      relatedIds.add(f.userId === userId ? f.friendId : f.userId);
    }

    const blockedIds = await getBlockedUserIds(userId);
    const excludeIds = [userId, ...relatedIds, ...blockedIds];

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { primarySport: true, city: true }
    });

    const where = {
      id: { notIn: excludeIds },
      isActive: true,
      deletedAt: null,
      profileVisibility: { not: 'PRIVATE' }
    };
    if (sport) where.primarySport = { equals: String(sport), mode: 'insensitive' };
    if (city) where.city = { contains: String(city), mode: 'insensitive' };

    let users = await prisma.user.findMany({
      where,
      select: { ...PUBLIC_CARD_SELECT, primarySport: true, experienceLevel: true },
      take: 30
    });

    // Ranking simple de afinidad: mismo deporte / misma ciudad primero
    users = users
      .map((u) => {
        let score = 0;
        if (me?.primarySport && u.primarySport === me.primarySport) score += 2;
        if (me?.city && u.city && u.city.toLowerCase() === me.city.toLowerCase()) score += 1;
        return { ...u, _affinity: score };
      })
      .sort((a, b) => b._affinity - a._affinity)
      .slice(0, 20)
      .map(({ _affinity, ...u }) => u);

    res.json(users);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** Bloquear a un usuario. */
const blockUser = async (req, res) => {
  try {
    const blockerId = req.user.id;
    const { id: blockedId } = req.params;

    if (blockerId === blockedId) {
      return res.status(400).json({ error: 'No podés bloquearte a vos mismo' });
    }

    const target = await prisma.user.findUnique({ where: { id: blockedId }, select: { id: true } });
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    const block = await prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {}
    });

    res.status(201).json(block);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** Desbloquear a un usuario. */
const unblockUser = async (req, res) => {
  try {
    const blockerId = req.user.id;
    const { id: blockedId } = req.params;

    await prisma.userBlock.deleteMany({ where: { blockerId, blockedId } });
    res.json({ success: true });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** Lista de usuarios que YO bloqueé. */
const listMyBlocks = async (req, res) => {
  try {
    const blockerId = req.user.id;
    const blocks = await prisma.userBlock.findMany({
      where: { blockerId },
      orderBy: { createdAt: 'desc' },
      include: {
        blocked: { select: PUBLIC_CARD_SELECT }
      }
    });
    res.json(blocks.map((b) => ({ id: b.id, createdAt: b.createdAt, user: b.blocked })));
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const completeOnboarding = async (req, res) => {
  try {
    const userId = req.user.id;
    const { experienceLevel, primarySport, onboardingData } = req.body;

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        onboardingCompleted: true,
        ...(experienceLevel !== undefined && { experienceLevel }),
        ...(primarySport !== undefined && { primarySport }),
        ...(onboardingData !== undefined && { onboardingData })
      },
      select: PROFILE_SELECT
    });

    res.json(user);
  } catch (error) {
    console.error('[ERROR] [COMPLETE_ONBOARDING]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const deleteAccount = async (req, res) => {
  try {
    const userId = req.user.id;

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    if (existing.deletedAt) {
      return res.status(400).json({ error: 'Esta cuenta ya fue eliminada.' });
    }

    const anonymizedEmail = `deleted+${userId}@jnsix.deleted`;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          isActive: false,
          deletedAt: new Date(),
          email: anonymizedEmail,
          username: `deleted_${userId.slice(0, 12)}`,
          marketingEnabled: false,
          stravaId: null,
          stravaAccessToken: null,
          stravaRefreshToken: null,
          stravaTokenExpiry: null,
          totpEnabled: false,
          totpSecret: null,
          password: null,
          phone: null,
          instagramUrl: null
        }
      }),
      prisma.expoPushToken.deleteMany({ where: { userId } }),
      prisma.emailVerification.deleteMany({ where: { userId } }),
      prisma.passwordReset.deleteMany({ where: { userId } })
    ]);

    res.json({ message: 'Tu cuenta ha sido eliminada. Lamentamos verte partir.' });
  } catch (error) {
    console.error('[ERROR] [DELETE_ACCOUNT]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const exportMyData = async (req, res) => {
  try {
    const userId = req.user.id;

    const [user, activities, posts, score] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: PROFILE_SELECT
      }),
      prisma.activity.findMany({
        where: { userId },
        orderBy: { startDate: 'desc' },
        select: {
          id: true,
          name: true,
          type: true,
          distanceKm: true,
          elevationM: true,
          movingTime: true,
          startDate: true,
          averageHr: true,
          maxHr: true,
          calories: true,
          visibility: true,
          createdAt: true
        }
      }),
      prisma.post.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          content: true,
          imageUrl: true,
          activityId: true,
          groupId: true,
          communityId: true,
          createdAt: true
        }
      }),
      prisma.userScore.findUnique({
        where: { userId },
        include: {
          currentRank: { select: { name: true } },
          currentCategory: { select: { name: true } }
        }
      })
    ]);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      profile: user,
      activities,
      posts,
      score
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="jnsix-export-${userId}.json"`);
    res.status(200).send(JSON.stringify(exportPayload, null, 2));
  } catch (error) {
    console.error('[ERROR] [EXPORT_MY_DATA]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  getMyProfile,
  updateMyProfile,
  updateCoachMemory,
  uploadAvatar,
  uploadCover,
  getUserPublicProfile,
  searchUsers,
  discoverAthletes,
  blockUser,
  unblockUser,
  listMyBlocks,
  completeOnboarding,
  deleteAccount,
  exportMyData
};
