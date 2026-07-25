const prisma = require('../lib/prisma');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

const getPeriodStart = (period) => {
  if (!period || period === 'all') return null;
  const periods = { weekly: 7, monthly: 30, yearly: 365 };
  const days = periods[period];
  if (!days) return null;
  const start = new Date();
  start.setDate(start.getDate() - days);
  return start;
};

const resolveScopedUserIds = async ({ friendIds, scope, scopeId }) => {
  if (scope === 'friends' && friendIds) {
    return friendIds;
  }
  if (scope === 'group' && scopeId) {
    const members = await prisma.groupMember.findMany({
      where: { groupId: scopeId },
      select: { userId: true }
    });
    return members.map((m) => m.userId);
  }
  if (scope === 'community' && scopeId) {
    const members = await prisma.communityMember.findMany({
      where: { communityId: scopeId },
      select: { userId: true }
    });
    return members.map((m) => m.userId);
  }
  if (scope === 'regional' && scopeId) {
    const members = await prisma.communityMember.findMany({
      where: { community: { region: scopeId } },
      select: { userId: true }
    });
    return members.map((m) => m.userId);
  }
  return null;
};

const attachUserMeta = async (entries) => {
  const userIds = entries.map((e) => e.userId);
  if (userIds.length === 0) return [];

  const [users, userScores] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, username: true }
    }),
    prisma.userScore.findMany({
      where: { userId: { in: userIds } },
      include: { currentRank: { select: { name: true, iconUrl: true, order: true } } }
    })
  ]);

  const userMap = users.reduce((acc, u) => {
    acc[u.id] = { email: u.email, username: u.username };
    return acc;
  }, {});
  const rankMap = userScores.reduce((acc, us) => {
    acc[us.userId] = us.currentRank;
    return acc;
  }, {});

  return entries
    .map((entry) => ({
      userId: entry.userId,
      email: userMap[entry.userId]?.email || null,
      username: userMap[entry.userId]?.username || null,
      totalPoints: entry.totalPoints,
      rank: rankMap[entry.userId] || null
    }))
    .sort((a, b) => b.totalPoints - a.totalPoints)
    .map((entry, index) => ({ position: index + 1, ...entry }));
};

/**
 * period !== 'all' → sum ScoreEvent in the window
 * period === 'all' → UserScore.totalPoints (lifetime matches profile)
 */
const buildRankingsQuery = async ({ friendIds, scope, scopeId, period }) => {
  const scopedIds = await resolveScopedUserIds({ friendIds, scope, scopeId });
  const start = getPeriodStart(period);

  // Lifetime: UserScore is source of truth
  if (!start) {
    const where = {
      ...(scopedIds ? { userId: { in: scopedIds } } : {}),
      totalPoints: { gt: 0 }
    };
    const scores = await prisma.userScore.findMany({
      where,
      select: { userId: true, totalPoints: true },
      orderBy: { totalPoints: 'desc' }
    });
    return attachUserMeta(scores);
  }

  // Period window: aggregate ScoreEvent
  const where = {
    createdAt: { gte: start },
    ...(scopedIds ? { userId: { in: scopedIds } } : {})
  };

  const events = await prisma.scoreEvent.findMany({
    where,
    select: { userId: true, points: true }
  });

  const scoresByUser = events.reduce((acc, event) => {
    acc[event.userId] = (acc[event.userId] || 0) + event.points;
    return acc;
  }, {});

  const entries = Object.entries(scoresByUser)
    .filter(([, pts]) => pts > 0)
    .map(([userId, totalPoints]) => ({ userId, totalPoints }));

  return attachUserMeta(entries);
};

const getGlobalRankings = async (req, res) => {
  try {
    const { period = 'all', page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = req.query;
    const rankings = await buildRankingsQuery({ scope: 'global', period });
    const start = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const paginated = rankings.slice(start, start + parseInt(limit, 10));
    res.json({ rankings: paginated, total: rankings.length });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getFriendsRankings = async (req, res) => {
  try {
    const userId = req.user.id;
    const { period = 'all' } = req.query;

    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ userId }, { friendId: userId }]
      }
    });

    const friendIds = friendships.map((f) => (f.userId === userId ? f.friendId : f.userId));
    friendIds.push(userId);

    const rankings = await buildRankingsQuery({ scope: 'friends', friendIds, period });
    res.json({ rankings });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getGroupRankings = async (req, res) => {
  try {
    const { id } = req.params;
    const { period = 'all' } = req.query;

    const rankings = await buildRankingsQuery({ scope: 'group', scopeId: id, period });
    res.json({ rankings });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getCommunityRankings = async (req, res) => {
  try {
    const { id } = req.params;
    const { period = 'all' } = req.query;

    const rankings = await buildRankingsQuery({ scope: 'community', scopeId: id, period });
    res.json({ rankings });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getUserScore = async (req, res) => {
  try {
    const userId = req.user.id;

    const score = await prisma.userScore.findUnique({
      where: { userId },
      include: {
        currentRank: { select: { name: true, iconUrl: true, order: true } },
        currentCategory: { select: { name: true } }
      }
    });

    if (!score) {
      return res.json({ totalPoints: 0, rank: null, category: null });
    }

    res.json(score);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * Ranking de temporada: suma ScoreEvent entre startDate y endDate de la Season.
 */
const getSeasonRankings = async (req, res) => {
  try {
    const { seasonId } = req.params;
    const { page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = req.query;

    const season = await prisma.season.findUnique({ where: { id: seasonId } });
    if (!season) {
      return res.status(404).json({ error: 'Temporada no encontrada' });
    }

    const events = await prisma.scoreEvent.findMany({
      where: {
        createdAt: { gte: season.startDate, lte: season.endDate },
        points: { gt: 0 },
      },
      select: { userId: true, points: true },
    });

    const scoresByUser = events.reduce((acc, event) => {
      acc[event.userId] = (acc[event.userId] || 0) + event.points;
      return acc;
    }, {});

    const entries = Object.entries(scoresByUser)
      .filter(([, pts]) => pts > 0)
      .map(([userId, totalPoints]) => ({ userId, totalPoints }));

    const rankings = await attachUserMeta(entries);
    const start = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const paginated = rankings.slice(start, start + parseInt(limit, 10));

    res.json({
      season: {
        id: season.id,
        name: season.name,
        startDate: season.startDate,
        endDate: season.endDate,
        isActive: season.isActive,
      },
      rankings: paginated,
      total: rankings.length,
    });
  } catch (error) {
    console.error('[ERROR] getSeasonRankings:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  getGlobalRankings,
  getFriendsRankings,
  getGroupRankings,
  getCommunityRankings,
  getUserScore,
  getSeasonRankings,
};
