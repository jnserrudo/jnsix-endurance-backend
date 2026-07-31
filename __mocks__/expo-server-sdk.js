/**
 * expo-server-sdk v6 es ESM puro y solo se puede requerir desde CommonJS gracias
 * al soporte de require(ESM) de Node 22+, que el runtime de Jest todavía no tiene.
 * Este stub se aplica automáticamente en los tests (está al lado de node_modules)
 * para poder cargar los servicios que dependen de push.service.
 */
class Expo {
  static isExpoPushToken() {
    return true;
  }

  chunkPushNotifications(messages) {
    return messages.length ? [messages] : [];
  }

  async sendPushNotificationsAsync() {
    return [];
  }

  async getPushNotificationReceiptsAsync() {
    return {};
  }
}

module.exports = { Expo, default: { Expo } };
