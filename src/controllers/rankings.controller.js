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

const buildRankingsQuery = async ({ friendIds, scope, scopeId, period }) => {
  const start = getPeriodStart(period);
  const dateFilter = start ? { createdAt: { gte: start } } : {};

  let userIds = [];
  if (scope === 'friends' && friendIds) {
    userIds = friendIds;
  } else if (scope === 'group' && scopeId) {
    const members = await prisma.groupMember.findMany({
      where: { groupId: scopeId },
      select: { userId: true }
    });
    userIds = members.map((m) => m.userId);
  } else if (scope === 'community' && scopeId) {
    const members = await prisma.communityMember.findMany({
      where: { communityId: scopeId },
      select: { userId: true }
    });
    userIds = members.map((m) => m.userId);
  } else if (scope === 'regional' && scopeId) {
    const members = await prisma.communityMember.findMany({
      where: { community: { region: scopeId } },
      select: { userId: true }
    });
    userIds = members.map((m) => m.userId);
  }

  const where = userIds.length > 0 ? { userId: { in: userIds }, ...dateFilter } : dateFilter;

  const events = await prisma.scoreEvent.findMany({
    where,
    select: { userId: true, points: true }
  });

  const scoresByUser = events.reduce((acc, event) => {
    acc[event.userId] = (acc[event.userId] || 0) + event.points;
    return acc;
  }, {});

  const userIdsWithScores = Object.keys(scoresByUser);
  const users = await prisma.user.findMany({
    where: { id: { in: userIdsWithScores } },
    select: { id: true, email: true, username: true }
  });

  const userMap = users.reduce((acc, u) => {
    acc[u.id] = { email: u.email, username: u.username };
    return acc;
  }, {});

  const userScores = await prisma.userScore.findMany({
    where: { userId: { in: userIdsWithScores } },
    include: { currentRank: { select: { name: true, iconUrl: true, order: true } } }
  });
  const rankMap = userScores.reduce((acc, us) => {
    acc[us.userId] = us.currentRank;
    return acc;
  }, {});

  const rankings = Object.entries(scoresByUser)
    .map(([uid, points]) => ({
      userId: uid,
      email: userMap[uid]?.email || null,
      username: userMap[uid]?.username || null,
      totalPoints: points,
      rank: rankMap[uid] || null
    }))
    .sort((a, b) => b.totalPoints - a.totalPoints)
    .map((entry, index) => ({ position: index + 1, ...entry }));

  return rankings;
};

const getGlobalRankings = async (req, res) => {
  try {
    const { period = 'all', page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = req.query;
    const rankings = await buildRankingsQuery({ scope: 'global', period });
    const start = (parseInt(page) - 1) * parseInt(limit);
    const paginated = rankings.slice(start, start + parseInt(limit));
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

module.exports = {
  getGlobalRankings,
  getFriendsRankings,
  getGroupRankings,
  getCommunityRankings,
  getUserScore
};
