const prisma = require('../lib/prisma');
const { notify } = require('../services/notifications.service');

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
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        role: true
      },
      take: 20
    });

    // Check friendship status for each user
    const usersWithStatus = await Promise.all(users.map(async (u) => {
      const friendship = await prisma.friendship.findFirst({
        where: {
          OR: [
            { userId: userId, friendId: u.id },
            { userId: u.id, friendId: userId }
          ]
        }
      });
      return {
        ...u,
        friendStatus: friendship ? friendship.status : 'NONE'
      };
    }));

    res.json(usersWithStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const sendRequest = async (req, res) => {
  try {
    const userId = req.user.id;
    const { friendId } = req.body;

    if (!friendId || friendId === userId) {
      return res.status(400).json({ error: 'Invalid friendId' });
    }

    const targetUser = await prisma.user.findUnique({ where: { id: friendId } });
    if (!targetUser || !targetUser.isActive) {
      return res.status(404).json({ error: 'User not found' });
    }

    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId }
        ]
      }
    });

    if (existing) {
      return res.status(409).json({ error: 'Friendship already exists', status: existing.status });
    }

    const friendship = await prisma.friendship.create({
      data: { userId, friendId, status: 'PENDING' }
    });

    await notify(friendId, 'FRIEND_REQUEST', {
      title: 'Nueva solicitud de amistad',
      body: `${req.user.email} te envio una solicitud de amistad`,
      payload: { friendshipId: friendship.id, fromUserId: userId }
    });

    res.status(201).json(friendship);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const respondRequest = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { accept } = req.body;

    const friendship = await prisma.friendship.findUnique({ where: { id } });
    if (!friendship || friendship.friendId !== userId) {
      return res.status(404).json({ error: 'Friendship request not found' });
    }

    if (friendship.status !== 'PENDING') {
      return res.status(409).json({ error: 'Request already resolved' });
    }

    const updated = await prisma.friendship.update({
      where: { id },
      data: { status: accept ? 'ACCEPTED' : 'BLOCKED' }
    });

    if (accept) {
      await notify(friendship.userId, 'FRIEND_REQUEST', {
        title: 'Solicitud de amistad aceptada',
        body: `${req.user.email} acepto tu solicitud de amistad`,
        payload: { friendshipId: friendship.id }
      });
    }

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const listFriends = async (req, res) => {
  try {
    const userId = req.user.id;

    const userCardSelect = { id: true, email: true, username: true, firstName: true, lastName: true, avatarUrl: true };

    const friendships = await prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ userId }, { friendId: userId }]
      },
      include: {
        user: { select: userCardSelect },
        friend: { select: userCardSelect }
      }
    });

    const friends = friendships.map((f) => (f.userId === userId ? f.friend : f.user));
    res.json(friends);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const listPendingRequests = async (req, res) => {
  try {
    const userId = req.user.id;

    const pending = await prisma.friendship.findMany({
      where: { friendId: userId, status: 'PENDING' },
      include: { user: { select: { id: true, email: true, username: true, firstName: true, lastName: true, avatarUrl: true } } }
    });

    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const removeFriend = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const friendship = await prisma.friendship.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { userId, friendId: id },
          { userId: id, friendId: userId }
        ]
      }
    });

    if (!friendship) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    await prisma.friendship.delete({ where: { id: friendship.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  searchUsers,
  sendRequest,
  respondRequest,
  listFriends,
  listPendingRequests,
  removeFriend
};
