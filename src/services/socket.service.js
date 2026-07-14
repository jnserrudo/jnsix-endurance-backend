const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

let io = null;

/**
 * Inicializa Socket.io sobre el servidor HTTP existente.
 * Autenticacion via JWT (mismo token que usan los endpoints REST), pasado en
 * el handshake como `auth.token` o header `Authorization`.
 */
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, true),
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
        select: { id: true, email: true, role: true }
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

    socket.on('room:join', ({ roomId }) => {
      if (roomId) socket.join(`room:${roomId}`);
    });

    socket.on('room:leave', ({ roomId }) => {
      if (roomId) socket.leave(`room:${roomId}`);
    });

    socket.on('chat:message', async ({ roomId, content }) => {
      if (!roomId || !content) return;
      try {
        const message = await prisma.chatMessage.create({
          data: { roomId, userId, content },
          include: { user: { select: { id: true, email: true } } }
        });
        io.to(`room:${roomId}`).emit('chat:message', message);
      } catch (error) {
        socket.emit('error', { message: 'Failed to send message', detail: error.message });
      }
    });

    socket.on('disconnect', () => {
      // no-op, socket.io limpia las rooms automaticamente
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
  emitToRoom
};
