const prisma = require('../lib/prisma');
const { emitToRoom } = require('../services/socket.service');
const { notify } = require('../services/notifications.service');

const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  username: true,
  avatarUrl: true
};

const emailPrefix = (email) => (email ? email.split('@')[0] : 'Usuario');

const MESSAGE_PREVIEW_LIMIT = 140;

/**
 * Manda push/in-app `CHAT_MESSAGE` al resto de la sala.
 * Lo usan tanto el endpoint REST como el handler de socket, así que un mismo
 * mensaje nunca genera dos notificaciones (mismo `dedupeKey`).
 */
const notifyRoomMembers = async (roomId, senderId, message) => {
  const room = await prisma.chatRoom.findUnique({
    where: { id: roomId },
    include: { members: { select: { userId: true } } }
  });
  if (!room) return;

  const recipients = room.members.map((m) => m.userId).filter((id) => id !== senderId);
  if (recipients.length === 0) return;

  const sender = await prisma.user.findUnique({
    where: { id: senderId },
    select: { username: true, email: true }
  });
  const senderName = sender?.username || emailPrefix(sender?.email);

  let scopeName = null;
  if (room.type === 'GROUP' && room.referenceId) {
    const group = await prisma.group.findUnique({
      where: { id: room.referenceId },
      select: { name: true }
    });
    scopeName = group?.name || null;
  } else if (room.type === 'COMMUNITY' && room.referenceId) {
    const community = await prisma.community.findUnique({
      where: { id: room.referenceId },
      select: { name: true }
    });
    scopeName = community?.name || null;
  }

  const title = scopeName ? `${senderName} en ${scopeName}` : senderName;
  const body = (message.content || 'Te mandó un mensaje').slice(0, MESSAGE_PREVIEW_LIMIT);

  await Promise.all(
    recipients.map((userId) =>
      notify(userId, 'CHAT_MESSAGE', {
        title,
        body,
        payload: {
          roomId,
          messageId: message.id,
          roomType: room.type,
          referenceId: room.referenceId,
          senderId
        },
        dedupeKey: `chat:${roomId}:${message.id}:${userId}`,
        dedupeSeconds: 10
      }).catch((error) => {
        console.warn('[chat] notify failed:', error.message);
      })
    )
  );
};

const listRooms = async (req, res) => {
  try {
    const userId = req.user.id;

    const memberships = await prisma.chatRoomMember.findMany({
      where: { userId },
      include: {
        room: {
          include: {
            members: {
              include: { user: { select: USER_PUBLIC_SELECT } }
            },
            messages: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              include: { user: { select: USER_PUBLIC_SELECT } }
            }
          }
        }
      }
    });

    const groupIds = [
      ...new Set(
        memberships
          .filter((m) => m.room.type === 'GROUP' && m.room.referenceId)
          .map((m) => m.room.referenceId)
      )
    ];
    const communityIds = [
      ...new Set(
        memberships
          .filter((m) => m.room.type === 'COMMUNITY' && m.room.referenceId)
          .map((m) => m.room.referenceId)
      )
    ];

    const [groups, communities, unreadCounts] = await Promise.all([
      groupIds.length
        ? prisma.group.findMany({
            where: { id: { in: groupIds } },
            select: { id: true, name: true, avatarUrl: true }
          })
        : [],
      communityIds.length
        ? prisma.community.findMany({
            where: { id: { in: communityIds } },
            select: { id: true, name: true, avatarUrl: true }
          })
        : [],
      Promise.all(
        memberships.map((m) =>
          prisma.chatMessage.count({
            where: {
              roomId: m.room.id,
              userId: { not: userId },
              ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {})
            }
          })
        )
      )
    ]);

    const groupById = Object.fromEntries(groups.map((g) => [g.id, g]));
    const communityById = Object.fromEntries(communities.map((c) => [c.id, c]));

    const rooms = memberships.map((m, index) => {
      const lastMessage = m.room.messages[0] || null;
      const members = m.room.members.map((mem) => ({
        userId: mem.userId,
        email: mem.user.email,
        username: mem.user.username,
        avatarUrl: mem.user.avatarUrl,
        joinedAt: mem.joinedAt
      }));

      let name = 'Chat';
      let avatarUrl = null;

      if (m.room.type === 'DIRECT') {
        const other = members.find((mem) => mem.userId !== userId);
        name = other?.username || emailPrefix(other?.email) || 'Chat';
        avatarUrl = other?.avatarUrl || null;
      } else if (m.room.type === 'GROUP' && m.room.referenceId) {
        const group = groupById[m.room.referenceId];
        name = group?.name || 'Chat';
        avatarUrl = group?.avatarUrl || null;
      } else if (m.room.type === 'COMMUNITY' && m.room.referenceId) {
        const community = communityById[m.room.referenceId];
        name = community?.name || 'Chat';
        avatarUrl = community?.avatarUrl || null;
      }

      const updatedAt = lastMessage?.createdAt || m.room.createdAt;

      return {
        id: m.room.id,
        type: m.room.type,
        referenceId: m.room.referenceId,
        name,
        avatarUrl,
        createdAt: m.room.createdAt,
        updatedAt,
        members,
        lastMessage,
        unreadCount: unreadCounts[index] || 0,
        lastReadAt: m.lastReadAt
      };
    });

    rooms.sort((a, b) => {
      const dateA = a.updatedAt || a.createdAt;
      const dateB = b.updatedAt || b.createdAt;
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
      return (
        m.room.type === 'DIRECT' &&
        m.room.members.length === 2 &&
        m.room.members.some((mem) => mem.userId === targetUserId)
      );
    });

    if (existingRoom) {
      const room = await prisma.chatRoom.findUnique({
        where: { id: existingRoom.room.id },
        include: {
          members: {
            include: { user: { select: USER_PUBLIC_SELECT } }
          }
        }
      });
      return res.json(room);
    }

    const room = await prisma.chatRoom.create({
      data: {
        type: 'DIRECT',
        members: {
          create: [{ userId }, { userId: targetUserId }]
        }
      },
      include: {
        members: {
          include: { user: { select: USER_PUBLIC_SELECT } }
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

    const groupMember = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } }
    });
    if (!groupMember) {
      return res.status(403).json({ error: 'No eres miembro de este grupo' });
    }

    const existingRoom = await prisma.chatRoom.findFirst({
      where: { type: 'GROUP', referenceId: groupId },
      include: {
        members: {
          include: { user: { select: USER_PUBLIC_SELECT } }
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
          include: { user: { select: USER_PUBLIC_SELECT } }
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

    const communityMember = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId, userId } }
    });
    if (!communityMember) {
      return res.status(403).json({ error: 'No eres miembro de esta comunidad' });
    }

    const existingRoom = await prisma.chatRoom.findFirst({
      where: { type: 'COMMUNITY', referenceId: communityId },
      include: {
        members: {
          include: { user: { select: USER_PUBLIC_SELECT } }
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
          include: { user: { select: USER_PUBLIC_SELECT } }
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
        user: { select: USER_PUBLIC_SELECT }
      }
    });

    let nextCursor = null;
    if (messages.length === parseInt(limit)) {
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

const sendMessage = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user.id;
    let { content, mediaUrl, mediaType, activityId } = req.body;

    if (req.file) {
      mediaUrl = `/uploads/${req.file.filename}`;
      mediaType = mediaType || 'IMAGE';
    }

    const text = typeof content === 'string' ? content.trim() : '';
    if (!text && !mediaUrl && !activityId) {
      return res.status(400).json({
        error: 'Se requiere content, mediaUrl o activityId'
      });
    }

    const membership = await prisma.chatRoomMember.findUnique({
      where: { roomId_userId: { roomId, userId } }
    });
    if (!membership) {
      return res.status(403).json({ error: 'No eres miembro de esta sala' });
    }

    if (activityId) {
      const activity = await prisma.activity.findFirst({
        where: { id: activityId, userId }
      });
      if (!activity) {
        return res.status(400).json({ error: 'Actividad no válida' });
      }
      mediaType = mediaType || 'ACTIVITY';
    }

    const message = await prisma.chatMessage.create({
      data: {
        roomId,
        userId,
        content: text || (mediaType === 'IMAGE' ? '📷 Imagen' : mediaType === 'AUDIO' ? '🎤 Audio' : mediaType === 'ACTIVITY' ? '🏃 Actividad' : ''),
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        activityId: activityId || null
      },
      include: {
        user: { select: USER_PUBLIC_SELECT }
      }
    });

    try {
      emitToRoom(roomId, 'chat:new_message', message);
      emitToRoom(roomId, 'chat:message', message);
    } catch {
      // Socket puede no estar inicializado en tests
    }

    try {
      await notifyRoomMembers(roomId, userId, message);
    } catch (error) {
      console.warn('[chat] notifyRoomMembers failed:', error.message);
    }

    res.status(201).json(message);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const markAsRead = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user.id;

    const membership = await prisma.chatRoomMember.findUnique({
      where: { roomId_userId: { roomId, userId } }
    });
    if (!membership) {
      return res.status(403).json({ error: 'No eres miembro de esta sala' });
    }

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
  notifyRoomMembers,
  listRooms,
  getOrCreateDirectRoom,
  getOrCreateGroupRoom,
  getOrCreateCommunityRoom,
  getMessages,
  sendMessage,
  markAsRead,
  markRead: markAsRead
};
