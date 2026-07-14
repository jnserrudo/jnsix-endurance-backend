const { Expo } = require('expo-server-sdk');
const prisma = require('../lib/prisma');

const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });

const registerPushToken = async (userId, token, device) => {
  if (!Expo.isExpoPushToken(token)) {
    throw new Error(`Push token ${token} is not a valid Expo push token`);
  }

  return prisma.expoPushToken.upsert({
    where: { token },
    update: { userId, device },
    create: { userId, token, device }
  });
};

const removePushToken = async (token) => {
  return prisma.expoPushToken.deleteMany({
    where: { token }
  });
};

const sendPushNotificationsChunked = async (messages) => {
  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];

  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    } catch (error) {
      console.error('[Push Service] Error sending push notification chunk:', error);
    }
  }

  // Handle receipts in the background if necessary (e.g., removing invalid tokens)
  return tickets;
};

const sendPushToUser = async (userId, title, body, data = {}) => {
  const tokens = await prisma.expoPushToken.findMany({
    where: { userId }
  });

  if (tokens.length === 0) return [];

  const messages = tokens
    .filter(t => Expo.isExpoPushToken(t.token))
    .map(t => ({
      to: t.token,
      sound: 'default',
      title,
      body,
      data
    }));

  if (messages.length === 0) return [];

  return sendPushNotificationsChunked(messages);
};

module.exports = {
  registerPushToken,
  removePushToken,
  sendPushNotificationsChunked,
  sendPushToUser
};
