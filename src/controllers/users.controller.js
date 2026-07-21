const prisma = require('../lib/prisma');
const storage = require('../services/storage.service');

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
    res.status(500).json({ error: error.message });
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
      activitiesVisible
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
        ...(activitiesVisible !== undefined && { activitiesVisible: Boolean(activitiesVisible) })
      },
      select: PROFILE_SELECT
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const uploadAvatar = async (req, res) => {
  try {
    const userId = req.user.id;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No se envió ninguna imagen' });
    }

    const uploadResult = await storage.uploadFile(file, userId);

    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: uploadResult.url },
      select: PROFILE_SELECT
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const uploadCover = async (req, res) => {
  try {
    const userId = req.user.id;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No se envió ninguna imagen' });
    }

    const uploadResult = await storage.uploadFile(file, userId);

    const user = await prisma.user.update({
      where: { id: userId },
      data: { coverUrl: uploadResult.url },
      select: PROFILE_SELECT
    });

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
      recentActivities: canViewActivities ? recentActivities : [],
      mutualGroups: theirGroups.map((g) => g.group),
      mutualCommunities: theirCommunities.map((c) => c.community),
      restricted: false
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const searchUsers = async (req, res) => {
  try {
    const { q = '' } = req.query;
    const userId = req.user.id;

    if (!q || q.trim().length === 0) {
      return res.json([]);
    }

    const users = await prisma.user.findMany({
      where: {
        id: { not: userId },
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
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getMyProfile,
  updateMyProfile,
  uploadAvatar,
  uploadCover,
  getUserPublicProfile,
  searchUsers
};
