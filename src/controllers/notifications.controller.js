const prisma = require('../lib/prisma');
const { Expo } = require('expo-server-sdk');
const { NotificationType: NotificationTypeEnum } = require('@prisma/client');

let expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });

const ALL_NOTIFICATION_TYPES = Object.values(NotificationTypeEnum);

const getNotifications = async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(notifications);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getUnreadCount = async (req, res) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user.id, read: false }
    });
    res.json({ count });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const notification = await prisma.notification.update({
      where: { id },
      data: { read: true }
    });
    res.json(notification);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const markAllAsRead = async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, read: false },
      data: { read: true }
    });
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const registerPushToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    await prisma.expoPushToken.upsert({
      where: { token },
      update: { userId: req.user.id },
      create: { token, userId: req.user.id }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[PUSH TOKEN ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const sendPushNotification = async (req, res) => {
  try {
    const { userId, title, body, data } = req.body;
    if (!userId || !title || !body) {
      return res.status(400).json({ error: 'userId, title and body are required' });
    }

    const tokens = await prisma.expoPushToken.findMany({ where: { userId } });
    if (tokens.length === 0) {
      return res.status(404).json({ error: 'No push tokens found for user' });
    }

    let messages = [];
    for (let pushToken of tokens) {
      if (!Expo.isExpoPushToken(pushToken.token)) {
        console.error(`Push token ${pushToken.token} is not a valid Expo push token`);
        continue;
      }
      messages.push({
        to: pushToken.token,
        sound: 'default',
        title,
        body,
        data: data || {},
      });
    }

    let chunks = expo.chunkPushNotifications(messages);
    let tickets = [];
    for (let chunk of chunks) {
      try {
        let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error(error);
      }
    }

    res.json({ success: true, tickets });
  } catch (error) {
    console.error('[SEND PUSH ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getPreferences = async (req, res) => {
  try {
    const rows = await prisma.notificationPreference.findMany({
      where: { userId: req.user.id }
    });
    const byType = new Map(rows.map((r) => [r.type, r]));

    const preferences = ALL_NOTIFICATION_TYPES.map((type) => {
      const existing = byType.get(type);
      return {
        type,
        inAppEnabled: existing ? existing.inAppEnabled : true,
        pushEnabled: existing ? existing.pushEnabled : true,
        emailEnabled: existing ? existing.emailEnabled : true
      };
    });

    res.json({ preferences });
  } catch (error) {
    console.error('[ERROR] [GET_PREFERENCES]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updatePreferences = async (req, res) => {
  try {
    const { preferences } = req.body;
    if (!Array.isArray(preferences)) {
      return res.status(400).json({ error: 'Formato de preferencias inválido.' });
    }

    const validTypes = new Set(ALL_NOTIFICATION_TYPES);

    for (const pref of preferences) {
      if (!pref || !validTypes.has(pref.type)) {
        return res.status(400).json({ error: `Tipo de notificación inválido: ${pref?.type}` });
      }
    }

    await prisma.$transaction(
      preferences.map((pref) => {
        const data = {
          ...(pref.inAppEnabled !== undefined && { inAppEnabled: Boolean(pref.inAppEnabled) }),
          ...(pref.pushEnabled !== undefined && { pushEnabled: Boolean(pref.pushEnabled) }),
          ...(pref.emailEnabled !== undefined && { emailEnabled: Boolean(pref.emailEnabled) })
        };
        return prisma.notificationPreference.upsert({
          where: { userId_type: { userId: req.user.id, type: pref.type } },
          update: data,
          create: {
            userId: req.user.id,
            type: pref.type,
            inAppEnabled: pref.inAppEnabled !== undefined ? Boolean(pref.inAppEnabled) : true,
            pushEnabled: pref.pushEnabled !== undefined ? Boolean(pref.pushEnabled) : true,
            emailEnabled: pref.emailEnabled !== undefined ? Boolean(pref.emailEnabled) : true
          }
        });
      })
    );

    const rows = await prisma.notificationPreference.findMany({
      where: { userId: req.user.id }
    });
    const byType = new Map(rows.map((r) => [r.type, r]));
    const result = ALL_NOTIFICATION_TYPES.map((type) => {
      const existing = byType.get(type);
      return {
        type,
        inAppEnabled: existing ? existing.inAppEnabled : true,
        pushEnabled: existing ? existing.pushEnabled : true,
        emailEnabled: existing ? existing.emailEnabled : true
      };
    });

    res.json({ preferences: result });
  } catch (error) {
    console.error('[ERROR] [UPDATE_PREFERENCES]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  registerPushToken,
  sendPushNotification,
  getPreferences,
  updatePreferences
};
