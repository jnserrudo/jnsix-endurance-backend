const { sendWeeklyDigest } = require('./weeklyDigest.service');

/**
 * Resumen semanal — delega al digest (km, racha, tip de ranking entre amigos).
 * Mantiene el nombre exportado por compatibilidad con cron / admin.
 */
async function sendWeeklyRecapNotifications() {
  const result = await sendWeeklyDigest();
  return typeof result === 'object' ? result.sent : result;
}

module.exports = { sendWeeklyRecapNotifications };
