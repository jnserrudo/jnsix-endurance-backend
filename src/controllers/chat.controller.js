const prisma = require('../lib/prisma');

const listRooms = async (req, res) => {
  try {
    const userId = req.user.id;

    const memberships = await prisma.chatRoomMember.findMany({
      where: { userId },
      include: {
        room: {
          include: {
            members: {
              include: { user: { select: { id: true, email: true } } }
            },
            messages: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              include: { user: { select: { id: true, email: true } } }
            }
          }
        }
      }
    });

    const rooms = memberships.map((m) => {
      const lastMessage = m.room.messages[0] || null;
      const unreadCount = lastMessage && m.lastReadAt
        ? (new Date(lastMessage.createdAt) > new Date(m.lastReadAt) ? 1 : 0)
        : (lastMessage ? 1 : 0);

      return {
        id: m.room.id,
        type: m.room.type,
        referenceId: m.room.referenceId,
        createdAt: m.room.createdAt,
        members: m.room.members.map((mem) => ({
          userId: mem.userId,
          email: mem.user.email,
          joinedAt: mem.joinedAt
        })),
        lastMessage,
        unreadCount,
        lastReadAt: m.lastReadAt
      };
    });

    // Ordenar por último mensaje (más reciente primero)
    rooms.sort((a, b) => {
      const dateA = a.lastMessage?.createdAt || a.createdAt;
      const dateB = b.lastMessage?.createdAt || b.createdAt;
      return new Date(dateB) - new Date(dateA);
    });

    res.json(rooms);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getOrCreateDirectRoom = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId is required' });
    }

    if (targetUserId === userId) {
      return res.status(400).json({ error: 'Cannot create a chat with yourself' });
    }

    // Buscar room DIRECT existente entre ambos usuarios
    const existingMemberships = await prisma.chatRoomMember.findMany({
      where: { userId },
      include: {
        room: {
          include: {
            members: true
          }
        }
      }
    });

    const existingRoom = existingMemberships.find((m) => {
      return m.room.type === 'DIRECT'
        && m.room.members.length === 2
        && m.room.members.some((mem) => mem.userId === targetUserId);
    });

    if (existingRoom) {
      return res.json(existingRoom.room);
    }

    // Crear nueva room
    const room = await prisma.chatRoom.create({
      data: {
        type: 'DIRECT',
        members: {
          create: [
            { userId },
            { userId: targetUserId }
          ]
        }
      },
      include: {
        members: {
          include: { user: { select: { id: true, email: true } } }
        }
      }
    });

    res.status(201).json(room);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getOrCreateGroupRoom = async (req, res) => {
  try {
    const { groupId } = req.body;
    const userId = req.user.id;

    if (!groupId) {
      return res.status(400).json({ error: 'groupId is required' });
    }

    // Verificar membresía en el grupo
    const groupMember = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } }
    });
    if (!groupMember) {
      return res.status(403).json({ error: 'No eres miembro de este grupo' });
    }

    // Buscar room existente
    const existingRoom = await prisma.chatRoom.findFirst({
      where: { type: 'GROUP', referenceId: groupId },
      include: {
        members: {
          include: { user: { select: { id: true, email: true } } }
        }
      }
    });

    if (existingRoom) {
      // Asegurarse de que el usuario es miembro de la room
      const isMember = existingRoom.members.some((m) => m.userId === userId);
      if (!isMember) {
        await prisma.chatRoomMember.create({
          data: { roomId: existingRoom.id, userId }
        });
      }
      return res.json(existingRoom);
    }

    // Crear room y agregar todos los miembros del grupo
    const groupMembers = await prisma.groupMember.findMany({
      where: { groupId },
      select: { userId: true }
    });

    const room = await prisma.chatRoom.create({
      data: {
        type: 'GROUP',
        referenceId: groupId,
        members: {
          create: groupMembers.map((m) => ({ userId: m.userId }))
        }
      },
      include: {
        members: {
          include: { user: { select: { id: true, email: true } } }
        }
      }
    });

    res.status(201).json(room);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getOrCreateCommunityRoom = async (req, res) => {
  try {
    const { communityId } = req.body;
    const userId = req.user.id;

    if (!communityId) {
      return res.status(400).json({ error: 'communityId is required' });
    }

    // Verificar membresía en la comunidad
    const communityMember = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId, userId } }
    });
    if (!communityMember) {
      return res.status(403).json({ error: 'No eres miembro de esta comunidad' });
    }

    // Buscar room existente
    const existingRoom = await prisma.chatRoom.findFirst({
      where: { type: 'COMMUNITY', referenceId: communityId },
      include: {
        members: {
          include: { user: { select: { id: true, email: true } } }
        }
      }
    });

    if (existingRoom) {
      const isMember = existingRoom.members.some((m) => m.userId === userId);
      if (!isMember) {
        await prisma.chatRoomMember.create({
          data: { roomId: existingRoom.id, userId }
        });
      }
      return res.json(existingRoom);
    }

    // Crear room y agregar todos los miembros de la comunidad
    const communityMembers = await prisma.communityMember.findMany({
      where: { communityId },
      select: { userId: true }
    });

    const room = await prisma.chatRoom.create({
      data: {
        type: 'COMMUNITY',
        referenceId: communityId,
        members: {
          create: communityMembers.map((m) => ({ userId: m.userId }))
        }
      },
      include: {
        members: {
          include: { user: { select: { id: true, email: true } } }
        }
      }
    });

    res.status(201).json(room);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user.id;
    const { before, limit = 50 } = req.query;

    // Verificar que el usuario es miembro de la room
    const membership = await prisma.chatRoomMember.findUnique({
      where: { roomId_userId: { roomId, userId } }
    });
    if (!membership) {
      return res.status(403).json({ error: 'No eres miembro de esta sala' });
    }

    const where = { roomId };
    if (before) {
      where.createdAt = { lt: new Date(before) };
    }

    const messages = await prisma.chatMessage.findMany({
      where,
      take: parseInt(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, email: true } }
      }
    });

    let nextCursor = null;
    if (messages.length === parseInt(limit)) {
      // Como ordenamos descendentemente, el último de este array es el más antiguo
      nextCursor = messages[messages.length - 1].createdAt;
    }

    res.json({
      messages: messages.reverse(),
      nextCursor
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const markAsRead = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user.id;

    await prisma.chatRoomMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { lastReadAt: new Date() }
    });

    res.json({ message: 'Marked as read' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  listRooms,
  getOrCreateDirectRoom,
  getOrCreateGroupRoom,
  getOrCreateCommunityRoom,
  getMessages,
  markAsRead
};
