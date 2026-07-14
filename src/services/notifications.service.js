const prisma = require('../lib/prisma');
const { emitToUser } = require('./socket.service');
const pushService = require('./push.service');
const emailService = require('./email.service');

/**
 * Servicio unificado de notificaciones.
 * notify() persiste la notificacion, la emite in-app via Socket.io si el usuario
 * esta conectado, y deja marcado si corresponde enviar push/email (el envio real
 * de push/email se implementa en una fase posterior, pendiente de proveedor).
 */
const notify = async (userId, type, { title, body, payload = null } = {}) => {
  const preference = await prisma.notificationPreference.findUnique({
    where: { userId_type: { userId, type } }
  });

  const inAppEnabled = preference?.inAppEnabled ?? true;
  const pushEnabled = preference?.pushEnabled ?? true;
  const emailEnabled = preference?.emailEnabled ?? true;

  const channels = [];
  if (inAppEnabled) channels.push('in_app');
  if (pushEnabled) channels.push('push');
  if (emailEnabled) channels.push('email');

  const notification = await prisma.notification.create({
    data: {
      userId,
      type,
      title,
      body,
      payload,
      channels: channels.join(',')
    }
  });

  if (inAppEnabled) {
    try {
      emitToUser(userId, 'notification:new', notification);
    } catch (error) {
      console.error('[Notifications] Failed to emit socket event:', error.message);
    }
  }

  if (pushEnabled) {
    try {
      await pushService.sendPushToUser(userId, title, body, payload);
      await prisma.notification.update({
        where: { id: notification.id },
        data: { sentPush: true }
      });
    } catch (error) {
      console.error('[Notifications] Failed to send push notification:', error.message);
    }
  }

  if (emailEnabled) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (user && user.email) {
        // Enviar un email genérico basado en la notificación (luego se puede mejorar con plantillas específicas según el 'type')
        await emailService.sendEmail(user.email, title, body, `<p>${body}</p>`);
        await prisma.notification.update({
          where: { id: notification.id },
          data: { sentEmail: true }
        });
      }
    } catch (error) {
      console.error('[Notifications] Failed to send email notification:', error.message);
    }
  }

  return notification;
};

module.exports = { notify };
