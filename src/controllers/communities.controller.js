const prisma = require('../lib/prisma');
const { notify } = require('../services/notifications.service');
const storage = require('../services/storage.service');

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

    res.json(communities.map((community) => ({
      ...community,
      myRole: community.members[0]?.role || null
    })));
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getCommunityById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const community = await prisma.community.findFirst({
      where: { id, isActive: true, deletedAt: null },
      include: {
        members: {
          include: {
            user: { select: { id: true, email: true, username: true, avatarUrl: true } }
          }
        },
        _count: { select: { members: true } }
      }
    });

    if (!community) {
      return res.status(404).json({ error: 'Comunidad no encontrada' });
    }

    const myMembership = community.members.find((m) => m.userId === userId);

    res.json({
      ...community,
      myRole: myMembership?.role || null
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const createCommunity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, description, region, type = 'TOPIC', visibility = 'PUBLIC' } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const community = await prisma.community.create({
      data: {
        name,
        description,
        region,
        type,
        visibility,
        members: {
          create: { userId, role: 'OWNER' }
        }
      },
      include: { members: true }
    });

    res.status(201).json(community);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const uploadCommunityAvatar = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No se envió ninguna imagen' });
    }

    const membership = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId } }
    });
    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this community' });
    }

    const uploadResult = await storage.uploadFile(file, `communities/${id}`);

    const community = await prisma.community.update({
      where: { id },
      data: { avatarUrl: uploadResult.url }
    });

    res.json(community);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateCommunity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { name, description, region, visibility } = req.body;

    const membership = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId } }
    });

    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this community' });
    }

    const community = await prisma.community.update({
      where: { id },
      data: { name, description, region, visibility }
    });

    res.json(community);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
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

    if (community.visibility !== 'PUBLIC') {
      return res.status(403).json({
        error: 'Esta comunidad es privada. Debes solicitar unirte o recibir una invitación.',
        requiresRequest: true
      });
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const requestToJoinCommunity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const community = await prisma.community.findFirst({ where: { id, isActive: true, deletedAt: null } });
    if (!community) {
      return res.status(404).json({ error: 'Community not found' });
    }

    const existingMember = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId } }
    });
    if (existingMember) {
      return res.status(409).json({ error: 'Already a member' });
    }

    const existingRequest = await prisma.communityJoinRequest.findFirst({
      where: { communityId: id, userId, status: 'PENDING' }
    });
    if (existingRequest) {
      return res.status(409).json({ error: 'Ya tienes una solicitud pendiente para esta comunidad' });
    }

    const request = await prisma.communityJoinRequest.create({
      data: { communityId: id, userId }
    });

    const admins = await prisma.communityMember.findMany({
      where: { communityId: id, role: { in: ['OWNER', 'ADMIN'] } },
      select: { userId: true }
    });

    await Promise.all(
      admins.map((admin) =>
        notify(admin.userId, 'COMMUNITY_JOIN_REQUEST', {
          title: 'Nueva solicitud para unirse',
          body: `${req.user.email} quiere unirse a "${community.name}"`,
          payload: { communityId: id, requestId: request.id, userId }
        })
      )
    );

    res.status(201).json(request);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listCommunityJoinRequests = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const membership = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId } }
    });
    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this community' });
    }

    const requests = await prisma.communityJoinRequest.findMany({
      where: { communityId: id, status: 'PENDING' },
      include: { user: { select: { id: true, email: true, username: true, firstName: true, lastName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' }
    });

    res.json(requests);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const respondCommunityJoinRequest = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id, requestId } = req.params;
    const { accept } = req.body;

    const membership = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId } }
    });
    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this community' });
    }

    const request = await prisma.communityJoinRequest.findUnique({ where: { id: requestId } });
    if (!request || request.communityId !== id || request.status !== 'PENDING') {
      return res.status(404).json({ error: 'Request not found' });
    }

    const updated = await prisma.communityJoinRequest.update({
      where: { id: requestId },
      data: { status: accept ? 'ACCEPTED' : 'DECLINED' }
    });

    if (accept) {
      await prisma.communityMember.upsert({
        where: { communityId_userId: { communityId: id, userId: request.userId } },
        create: { communityId: id, userId: request.userId, role: 'MEMBER' },
        update: {}
      });
    }

    const community = await prisma.community.findUnique({ where: { id } });
    await notify(request.userId, 'COMMUNITY_JOIN_RESPONSE', {
      title: accept ? 'Solicitud aprobada' : 'Solicitud rechazada',
      body: accept
        ? `Tu solicitud para unirte a "${community.name}" fue aprobada`
        : `Tu solicitud para unirte a "${community.name}" fue rechazada`,
      payload: { communityId: id }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const inviteToCommunity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { userId: invitedUserId } = req.body;

    if (!invitedUserId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const membership = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId } }
    });
    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this community' });
    }

    const community = await prisma.community.findFirst({ where: { id, isActive: true, deletedAt: null } });
    if (!community) {
      return res.status(404).json({ error: 'Community not found' });
    }

    const existingMember = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId: invitedUserId } }
    });
    if (existingMember) {
      return res.status(409).json({ error: 'El usuario ya es miembro de la comunidad' });
    }

    const existingInvite = await prisma.communityInvitation.findFirst({
      where: { communityId: id, invitedUserId, status: 'PENDING' }
    });
    if (existingInvite) {
      return res.status(409).json({ error: 'Ya existe una invitación pendiente para este usuario' });
    }

    const invitation = await prisma.communityInvitation.create({
      data: { communityId: id, invitedUserId, invitedById: userId }
    });

    await notify(invitedUserId, 'COMMUNITY_INVITE', {
      title: 'Invitación a una comunidad',
      body: `${req.user.email} te invitó a unirte a "${community.name}"`,
      payload: { communityId: id, invitationId: invitation.id }
    });

    res.status(201).json(invitation);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listCommunityInvitations = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const membership = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: id, userId } }
    });
    const isAdminUser = req.user.role === 'ADMIN';
    if (!isAdminUser && (!membership || !['OWNER', 'ADMIN'].includes(membership.role))) {
      return res.status(403).json({ error: 'Insufficient permissions on this community' });
    }

    const invitations = await prisma.communityInvitation.findMany({
      where: { communityId: id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' }
    });

    res.json(invitations);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listMyCommunityInvitations = async (req, res) => {
  try {
    const userId = req.user.id;

    const invitations = await prisma.communityInvitation.findMany({
      where: { invitedUserId: userId, status: 'PENDING' },
      include: { community: { select: { id: true, name: true, description: true } } },
      orderBy: { createdAt: 'desc' }
    });

    res.json(invitations);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const respondCommunityInvite = async (req, res) => {
  try {
    const userId = req.user.id;
    const { invitationId } = req.params;
    const { accept } = req.body;

    const invitation = await prisma.communityInvitation.findUnique({ where: { id: invitationId } });
    if (!invitation || invitation.invitedUserId !== userId || invitation.status !== 'PENDING') {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const updated = await prisma.communityInvitation.update({
      where: { id: invitationId },
      data: { status: accept ? 'ACCEPTED' : 'DECLINED' }
    });

    if (accept) {
      await prisma.communityMember.upsert({
        where: { communityId_userId: { communityId: invitation.communityId, userId } },
        create: { communityId: invitation.communityId, userId, role: 'MEMBER' },
        update: {}
      });
    }

    res.json(updated);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  listCommunities,
  getCommunityById,
  createCommunity,
  uploadCommunityAvatar,
  updateCommunity,
  disableCommunity,
  joinCommunity,
  requestToJoinCommunity,
  listCommunityJoinRequests,
  respondCommunityJoinRequest,
  inviteToCommunity,
  listCommunityInvitations,
  listMyCommunityInvitations,
  respondCommunityInvite,
  leaveCommunity
};
