const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { isOriginAllowed } = require('../lib/corsOrigins');

let io = null;

// Presencia en tiempo real: userId -> cantidad de sockets conectados.
// Un usuario está "online" mientras tenga al menos un socket activo.
const onlineUsers = new Map();

const getOnlineUserIds = () => [...onlineUsers.keys()];

const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  username: true,
  avatarUrl: true
};

/**
 * Inicializa Socket.io sobre el servidor HTTP existente.
 * Autenticacion via JWT (mismo token que usan los endpoints REST), pasado en
 * el handshake como `auth.token` o header `Authorization`.
 */
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true
    },
    path: '/ws'
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
        || socket.handshake.headers?.authorization?.split(' ')[1];

      if (!token) {
        return next(new Error('Access token required'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, email: true, username: true, avatarUrl: true, role: true }
      });

      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = user;
      next();
    } catch (error) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);

    // Actualizar presencia: si es el primer socket del usuario, avisar a todos.
    const prevCount = onlineUsers.get(userId) || 0;
    onlineUsers.set(userId, prevCount + 1);
    if (prevCount === 0) {
      io.emit('presence:update', { userId, online: true });
    }
    // Enviar al socket recién conectado la lista actual de usuarios online.
    socket.emit('presence:list', getOnlineUserIds());

    const joinRoom = (roomId) => {
      if (roomId) socket.join(`room:${roomId}`);
    };

    const leaveRoom = (roomId) => {
      if (roomId) socket.leave(`room:${roomId}`);
    };

    // Compatibilidad: mobile usa chat:join / chat:leave; también room:join / room:leave
    socket.on('chat:join', (roomIdOrPayload) => {
      const roomId = typeof roomIdOrPayload === 'string' ? roomIdOrPayload : roomIdOrPayload?.roomId;
      joinRoom(roomId);
    });
    socket.on('chat:leave', (roomIdOrPayload) => {
      const roomId = typeof roomIdOrPayload === 'string' ? roomIdOrPayload : roomIdOrPayload?.roomId;
      leaveRoom(roomId);
    });
    socket.on('room:join', ({ roomId }) => joinRoom(roomId));
    socket.on('room:leave', ({ roomId }) => leaveRoom(roomId));

    const handleSendMessage = async (payload) => {
      const { roomId, content, mediaUrl, mediaType, activityId } = payload || {};
      const text = typeof content === 'string' ? content.trim() : '';
      if (!roomId || (!text && !mediaUrl && !activityId)) return;

      try {
        const membership = await prisma.chatRoomMember.findUnique({
          where: { roomId_userId: { roomId, userId } }
        });
        if (!membership) {
          socket.emit('error', { message: 'No eres miembro de esta sala' });
          return;
        }

        let resolvedMediaType = mediaType || null;
        if (activityId && !resolvedMediaType) resolvedMediaType = 'ACTIVITY';

        const message = await prisma.chatMessage.create({
          data: {
            roomId,
            userId,
            content:
              text ||
              (resolvedMediaType === 'IMAGE'
                ? '📷 Imagen'
                : resolvedMediaType === 'AUDIO'
                  ? '🎤 Audio'
                  : resolvedMediaType === 'ACTIVITY'
                    ? '🏃 Actividad'
                    : ''),
            mediaUrl: mediaUrl || null,
            mediaType: resolvedMediaType,
            activityId: activityId || null
          },
          include: { user: { select: USER_PUBLIC_SELECT } }
        });

        io.to(`room:${roomId}`).emit('chat:new_message', message);
        io.to(`room:${roomId}`).emit('chat:message', message);
      } catch (error) {
        socket.emit('error', { message: 'Failed to send message', detail: error.message });
      }
    };

    socket.on('chat:send_message', handleSendMessage);
    socket.on('chat:message', handleSendMessage);

    // Live Run Streaming (rooms live_run:{id}) — no reutiliza room: de chat
    try {
      const { attachLiveRunSocketHandlers } = require('../controllers/liveRuns.controller');
      attachLiveRunSocketHandlers(io, socket);
    } catch (err) {
      console.warn('[Socket] live run handlers not attached:', err.message);
    }

    // Permite que un cliente pida la lista de presencia bajo demanda.
    socket.on('presence:get', () => {
      socket.emit('presence:list', getOnlineUserIds());
    });

    socket.on('disconnect', () => {
      // socket.io limpia las rooms automaticamente; actualizamos presencia.
      const count = (onlineUsers.get(userId) || 1) - 1;
      if (count <= 0) {
        onlineUsers.delete(userId);
        io.emit('presence:update', { userId, online: false });
      } else {
        onlineUsers.set(userId, count);
      }
    });
  });

  console.log('Socket.io initialized on /ws');
  return io;
};

const getIO = () => {
  if (!io) throw new Error('Socket.io has not been initialized yet');
  return io;
};

/**
 * Emite un evento a un usuario especifico (su sala personal `user:<id>`).
 * Usado por el servicio de notificaciones para push in-app instantaneo.
 */
const emitToUser = (userId, event, payload) => {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
};

/**
 * Emite un evento a todos los miembros de una sala (grupo, comunidad, chat room).
 */
const emitToRoom = (roomId, event, payload) => {
  if (!io) return;
  io.to(`room:${roomId}`).emit(event, payload);
};

module.exports = {
  initSocket,
  getIO,
  emitToUser,
  emitToRoom,
  getOnlineUserIds
};
