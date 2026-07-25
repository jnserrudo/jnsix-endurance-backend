const prisma = require('../lib/prisma');
const { notify } = require('../services/notifications.service');
const storage = require('../services/storage.service');

const listGroups = async (req, res) => {
  try {
    const userId = req.user.id;
    const { q } = req.query;

    const groups = await prisma.group.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        OR: [
          { visibility: 'PUBLIC' },
          { members: { some: { userId } } }
        ],
        ...(q
          ? {
              name: { contains: String(q) }
            }
          : {})
      },
      include: {
        _count: { select: { members: true } },
        owner: { select: { id: true, email: true, username: true } },
        members: {
          where: { userId },
          select: { role: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(groups.map((group) => ({
      ...group,
      myRole: group.members[0]?.role || null
    })));
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getGroupById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const group = await prisma.group.findFirst({
      where: { id, isActive: true, deletedAt: null },
      include: {
        owner: { select: { id: true, email: true, username: true } },
        members: {
          include: {
            user: { select: { id: true, email: true, username: true, avatarUrl: true } }
          }
        },
        subgroups: { where: { isActive: true, deletedAt: null } },
        _count: { select: { members: true } }
      }
    });

    if (!group) {
      return res.status(404).json({ error: 'Grupo no encontrado' });
    }

    const myMembership = group.members.find((m) => m.userId === userId);

    res.json({
      ...group,
      myRole: myMembership?.role || null
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
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

    if (group.visibility !== 'PUBLIC') {
      return res.status(403).json({
        error: 'Este grupo es privado. Debes solicitar unirte o recibir una invitación.',
        requiresRequest: true
      });
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const requestToJoinGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const group = await prisma.group.findFirst({ where: { id, isActive: true, deletedAt: null } });
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const existingMember = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } }
    });
    if (existingMember) {
      return res.status(409).json({ error: 'Already a member' });
    }

    const existingRequest = await prisma.groupJoinRequest.findFirst({
      where: { groupId: id, userId, status: 'PENDING' }
    });
    if (existingRequest) {
      return res.status(409).json({ error: 'Ya tienes una solicitud pendiente para este grupo' });
    }

    const request = await prisma.groupJoinRequest.create({
      data: { groupId: id, userId }
    });

    const admins = await prisma.groupMember.findMany({
      where: { groupId: id, role: { in: ['OWNER', 'ADMIN'] } },
      select: { userId: true }
    });

    await Promise.all(
      admins.map((admin) =>
        notify(admin.userId, 'GROUP_JOIN_REQUEST', {
          title: 'Nueva solicitud para unirse',
          body: `${req.user.email} quiere unirse a "${group.name}"`,
          payload: { groupId: id, requestId: request.id, userId }
        })
      )
    );

    res.status(201).json(request);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listGroupJoinRequests = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } }
    });
    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this group' });
    }

    const requests = await prisma.groupJoinRequest.findMany({
      where: { groupId: id, status: 'PENDING' },
      include: { user: { select: { id: true, email: true, username: true, firstName: true, lastName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' }
    });

    res.json(requests);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const respondGroupJoinRequest = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id, requestId } = req.params;
    const { accept } = req.body;

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } }
    });
    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this group' });
    }

    const request = await prisma.groupJoinRequest.findUnique({ where: { id: requestId } });
    if (!request || request.groupId !== id || request.status !== 'PENDING') {
      return res.status(404).json({ error: 'Request not found' });
    }

    const updated = await prisma.groupJoinRequest.update({
      where: { id: requestId },
      data: { status: accept ? 'ACCEPTED' : 'DECLINED' }
    });

    if (accept) {
      await prisma.groupMember.upsert({
        where: { groupId_userId: { groupId: id, userId: request.userId } },
        create: { groupId: id, userId: request.userId, role: 'MEMBER' },
        update: {}
      });
    }

    const group = await prisma.group.findUnique({ where: { id } });
    await notify(request.userId, 'GROUP_JOIN_RESPONSE', {
      title: accept ? 'Solicitud aprobada' : 'Solicitud rechazada',
      body: accept
        ? `Tu solicitud para unirte a "${group.name}" fue aprobada`
        : `Tu solicitud para unirte a "${group.name}" fue rechazada`,
      payload: { groupId: id }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const inviteToGroup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { userId: invitedUserId } = req.body;

    if (!invitedUserId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } }
    });
    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this group' });
    }

    const group = await prisma.group.findFirst({ where: { id, isActive: true, deletedAt: null } });
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const existingMember = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId: invitedUserId } }
    });
    if (existingMember) {
      return res.status(409).json({ error: 'El usuario ya es miembro del grupo' });
    }

    const existingInvite = await prisma.groupInvitation.findFirst({
      where: { groupId: id, invitedUserId, status: 'PENDING' }
    });
    if (existingInvite) {
      return res.status(409).json({ error: 'Ya existe una invitación pendiente para este usuario' });
    }

    const invitation = await prisma.groupInvitation.create({
      data: { groupId: id, invitedUserId, invitedById: userId }
    });

    await notify(invitedUserId, 'GROUP_INVITE', {
      title: 'Invitación a un grupo',
      body: `${req.user.email} te invitó a unirte a "${group.name}"`,
      payload: { groupId: id, invitationId: invitation.id }
    });

    res.status(201).json(invitation);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listGroupInvitations = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } }
    });
    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this group' });
    }

    const invitations = await prisma.groupInvitation.findMany({
      where: { groupId: id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' }
    });

    res.json(invitations);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listMyGroupInvitations = async (req, res) => {
  try {
    const userId = req.user.id;

    const invitations = await prisma.groupInvitation.findMany({
      where: { invitedUserId: userId, status: 'PENDING' },
      include: { group: { select: { id: true, name: true, avatarUrl: true, description: true } } },
      orderBy: { createdAt: 'desc' }
    });

    res.json(invitations);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const respondGroupInvite = async (req, res) => {
  try {
    const userId = req.user.id;
    const { invitationId } = req.params;
    const { accept } = req.body;

    const invitation = await prisma.groupInvitation.findUnique({ where: { id: invitationId } });
    if (!invitation || invitation.invitedUserId !== userId || invitation.status !== 'PENDING') {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const updated = await prisma.groupInvitation.update({
      where: { id: invitationId },
      data: { status: accept ? 'ACCEPTED' : 'DECLINED' }
    });

    if (accept) {
      await prisma.groupMember.upsert({
        where: { groupId_userId: { groupId: invitation.groupId, userId } },
        create: { groupId: invitation.groupId, userId, role: 'MEMBER' },
        update: {}
      });
    }

    res.json(updated);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const uploadGroupAvatar = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No se envió ninguna imagen' });
    }

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } }
    });
    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this group' });
    }

    const uploadResult = await storage.uploadFile(file, `groups/${id}`);

    const group = await prisma.group.update({
      where: { id },
      data: { avatarUrl: uploadResult.url }
    });

    res.json(group);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  listGroups,
  getGroupById,
  createGroup,
  updateGroup,
  disableGroup,
  joinGroup,
  requestToJoinGroup,
  listGroupJoinRequests,
  respondGroupJoinRequest,
  inviteToGroup,
  listGroupInvitations,
  listMyGroupInvitations,
  respondGroupInvite,
  uploadGroupAvatar,
  leaveGroup,
  createSubgroup
};
