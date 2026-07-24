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
 * Persiste UNA sola fila, emite socket, push y email según preferencias.
 *
 * @param {string} userId
 * @param {string} type
 * @param {{ title: string, body: string, payload?: object|null, dedupeKey?: string|null, dedupeSeconds?: number }} content
 */
const notify = async (userId, type, { title, body, payload = null, dedupeKey = null, dedupeSeconds = 90 } = {}) => {
  if (!userId || !type || !title) {
    throw new Error('notify requiere userId, type y title');
  }

  // Anti-duplicado: misma acción en ventana corta (doble tap, race, etc.)
  if (dedupeKey) {
    const since = new Date(Date.now() - Math.max(5, dedupeSeconds) * 1000);
    const recent = await prisma.notification.findMany({
      where: {
        userId,
        type,
        createdAt: { gte: since }
      },
      orderBy: { createdAt: 'desc' },
      take: 15
    });

    const hit = recent.find((n) => {
      const p = n.payload;
      if (p && typeof p === 'object' && !Array.isArray(p) && p.dedupeKey === dedupeKey) {
        return true;
      }
      // Fallback: mismo título + body (canjes / pushes repetidos)
      return n.title === title && n.body === body;
    });

    if (hit) {
      console.log(`[Notifications] Dedupe skip ${type} for ${userId} key=${dedupeKey}`);
      return hit;
    }
  }

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

  const finalPayload =
    payload && typeof payload === 'object'
      ? { ...payload, ...(dedupeKey ? { dedupeKey } : {}) }
      : dedupeKey
        ? { dedupeKey }
        : payload;

  const notification = await prisma.notification.create({
    data: {
      userId,
      type,
      title,
      body,
      payload: finalPayload,
      channels: channels.join(',')
    }
  });

  // Push primero (si aplica); el socket solo actualiza badge/UI — el cliente
  // NO debe agendar otra local si hay push remoto (evita 2 banners iguales).
  if (pushEnabled) {
    try {
      await pushService.sendPushToUser(userId, title, body, {
        ...(finalPayload && typeof finalPayload === 'object' ? finalPayload : {}),
        type,
        notificationId: notification.id
      });
      await prisma.notification.update({
        where: { id: notification.id },
        data: { sentPush: true }
      });
      notification.sentPush = true;
    } catch (error) {
      console.error('[Notifications] Failed to send push notification:', error.message);
    }
  }

  if (inAppEnabled) {
    try {
      emitToUser(userId, 'notification:new', notification);
    } catch (error) {
      console.error('[Notifications] Failed to emit socket event:', error.message);
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
      results.push(
        await notify(admin.id, type, {
          ...content,
          dedupeKey: content.dedupeKey || `${type}:${content.payload?.businessId || content.title || ''}`
        })
      );
    } catch (error) {
      console.error(`[Notifications] notifyAdmins failed for ${admin.id}:`, error.message);
    }
  }
  return results;
};

module.exports = { notify, notifyAdmins };
