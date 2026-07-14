const prisma = require('../lib/prisma');
const { notify } = require('../services/notifications.service');

const listGroups = async (req, res) => {
  try {
    const userId = req.user.id;

    const groups = await prisma.group.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        OR: [
          { visibility: 'PUBLIC' },
          { members: { some: { userId } } }
        ]
      },
      include: {
        _count: { select: { members: true } },
        owner: { select: { id: true, email: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(groups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getGroupById = async (req, res) => {
  try {
    const { id } = req.params;

    const group = await prisma.group.findFirst({
      where: { id, isActive: true, deletedAt: null },
      include: {
        owner: { select: { id: true, email: true } },
        members: { include: { user: { select: { id: true, email: true } } } },
        subgroups: { where: { isActive: true, deletedAt: null } }
      }
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    res.json(group);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, description, avatarUrl, visibility = 'PUBLIC' } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const group = await prisma.group.create({
      data: {
        name,
        description,
        avatarUrl,
        visibility,
        ownerId: userId,
        members: {
          create: { userId, role: 'OWNER' }
        }
      },
      include: { members: true }
    });

    res.status(201).json(group);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { name, description, avatarUrl, visibility } = req.body;

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } }
    });

    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this group' });
    }

    const group = await prisma.group.update({
      where: { id },
      data: { name, description, avatarUrl, visibility }
    });

    res.json(group);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const disableGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && group.ownerId !== userId) {
      return res.status(403).json({ error: 'Only the owner or an admin can disable this group' });
    }

    const updated = await prisma.group.update({
      where: { id },
      data: { isActive: false }
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const joinGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const group = await prisma.group.findFirst({ where: { id, isActive: true, deletedAt: null } });
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const existing = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } }
    });
    if (existing) {
      return res.status(409).json({ error: 'Already a member' });
    }

    const member = await prisma.groupMember.create({
      data: { groupId: id, userId, role: 'MEMBER' }
    });

    await notify(group.ownerId, 'GROUP_INVITE', {
      title: 'Nuevo miembro en tu grupo',
      body: `${req.user.email} se unio a "${group.name}"`,
      payload: { groupId: id, userId }
    });

    res.status(201).json(member);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const leaveGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    await prisma.groupMember.delete({
      where: { groupId_userId: { groupId: id, userId } }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createSubgroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { name, description } = req.body;

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } }
    });

    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this group' });
    }

    const subgroup = await prisma.subgroup.create({
      data: { groupId: id, name, description }
    });

    res.status(201).json(subgroup);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  listGroups,
  getGroupById,
  createGroup,
  updateGroup,
  disableGroup,
  joinGroup,
  leaveGroup,
  createSubgroup
};
