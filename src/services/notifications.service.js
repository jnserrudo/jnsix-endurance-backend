const prisma = require('../lib/prisma');
const { emitToUser } = require('./socket.service');
const pushService = require('./push.service');
const emailService = require('./email.service');

/** Tipos que también mandan email (el resto: in-app + push). */
const EMAIL_NOTIFICATION_TYPES = new Set([
  'BUSINESS_PENDING',
  'BUSINESS_STATUS',
  'PAYMENT_REVIEW',
  'PAYMENT_APPROVED',
  'PAYMENT_REJECTED',
  'FRIEND_REQUEST',
  'SYSTEM',
]);

/**
 * Servicio unificado de notificaciones.
 * Persiste, emite in-app (Socket.io), push y email (solo tipos relevantes).
 */
const notify = async (userId, type, { title, body, payload = null } = {}) => {
  const preference = await prisma.notificationPreference.findUnique({
    where: { userId_type: { userId, type } }
  });

  const inAppEnabled = preference?.inAppEnabled ?? true;
  const pushEnabled = preference?.pushEnabled ?? true;
  const emailEnabled = (preference?.emailEnabled ?? true) && EMAIL_NOTIFICATION_TYPES.has(type);

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
      await pushService.sendPushToUser(userId, title, body, payload || {});
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

const notifyAdmins = async (type, content) => {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', deletedAt: null, isActive: true },
    select: { id: true }
  });

  const results = [];
  for (const admin of admins) {
    try {
      results.push(await notify(admin.id, type, content));
    } catch (error) {
      console.error(`[Notifications] notifyAdmins failed for ${admin.id}:`, error.message);
    }
  }
  return results;
};

module.exports = { notify, notifyAdmins };
