const prisma = require('../lib/prisma');
const { notify } = require('../services/notifications.service');

const listCommunities = async (req, res) => {
  try {
    const { region, type, q } = req.query;

    const communities = await prisma.community.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        region: region || undefined,
        type: type || undefined,
        name: q ? { contains: q } : undefined
      },
      include: {
        _count: { select: { members: true } },
        members: {
          where: { userId: req.user.id },
          select: { role: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(communities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getCommunityById = async (req, res) => {
  try {
    const { id } = req.params;

    const community = await prisma.community.findFirst({
      where: { id, isActive: true, deletedAt: null },
      include: {
        members: {
          include: { user: { select: { id: true, email: true } } }
        }
      }
    });

    if (!community) {
      return res.status(404).json({ error: 'Community not found' });
    }

    res.json(community);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createCommunity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, description, region, type = 'TOPIC' } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const community = await prisma.community.create({
      data: {
        name,
        description,
        region,
        type,
        members: {
          create: { userId, role: 'OWNER' }
        }
      },
      include: { members: true }
    });

    res.status(201).json(community);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateCommunity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { name, description, region } = req.body;

    const membership = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId } }
    });

    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this community' });
    }

    const community = await prisma.community.update({
      where: { id },
      data: { name, description, region }
    });

    res.json(community);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const disableCommunity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const membership = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId } }
    });

    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || membership.role !== 'OWNER')) {
      return res.status(403).json({ error: 'Only the owner or an admin can disable this community' });
    }

    const updated = await prisma.community.update({
      where: { id },
      data: { isActive: false }
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const joinCommunity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const community = await prisma.community.findFirst({
      where: { id, isActive: true, deletedAt: null },
      include: { members: { select: { role: true, userId: true } } }
    });
    if (!community) {
      return res.status(404).json({ error: 'Community not found' });
    }

    const existing = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId } }
    });
    if (existing) {
      return res.status(409).json({ error: 'Already a member' });
    }

    const member = await prisma.communityMember.create({
      data: { communityId: id, userId, role: 'MEMBER' }
    });

    const ownerId = community.members.find((m) => m.role === 'OWNER')?.userId;
    if (ownerId) {
      await notify(ownerId, 'GROUP_INVITE', {
        title: 'Nuevo miembro en tu comunidad',
        body: `${req.user.email} se unio a "${community.name}"`,
        payload: { communityId: id, userId }
      });
    }

    res.status(201).json(member);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const leaveCommunity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    await prisma.communityMember.delete({
      where: { communityId_userId: { communityId: id, userId } }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  listCommunities,
  getCommunityById,
  createCommunity,
  updateCommunity,
  disableCommunity,
  joinCommunity,
  leaveCommunity
};
