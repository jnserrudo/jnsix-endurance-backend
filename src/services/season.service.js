const prisma = require('../lib/prisma');
const scoringConfig = require('./scoringConfig.service');
const { awardPoints } = require('./scoring.service');
const { notify } = require('./notifications.service');

class SeasonError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SeasonError';
    this.status = status;
  }
}

const PODIUM_LABELS = ['primero', 'segundo', 'tercero'];

/**
 * Tabla de la temporada: suma de ScoreEvent positivos en su ventana de fechas.
 * Es el mismo criterio que usa `GET /rankings/season/:id`, así que lo que ve el
 * atleta durante la temporada es lo que se premia al cerrarla.
 */
const getStandings = async (season, { limit = null } = {}) => {
  const events = await prisma.scoreEvent.findMany({
    where: {
      createdAt: { gte: season.startDate, lte: season.endDate },
      points: { gt: 0 },
    },
    select: { userId: true, points: true },
  });

  const byUser = new Map();
  for (const event of events) {
    if (!event.userId) continue;
    byUser.set(event.userId, (byUser.get(event.userId) || 0) + event.points);
  }

  const ordered = Array.from(byUser.entries())
    .map(([userId, totalPoints]) => ({ userId, totalPoints }))
    .sort((a, b) => b.totalPoints - a.totalPoints);

  const sliced = limit ? ordered.slice(0, limit) : ordered;
  if (sliced.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: sliced.map((r) => r.userId) } },
    select: { id: true, username: true, firstName: true, lastName: true, avatarUrl: true },
  });
  const usersById = new Map(users.map((u) => [u.id, u]));

  return sliced.map((row, index) => ({
    position: index + 1,
    userId: row.userId,
    totalPoints: row.totalPoints,
    user: usersById.get(row.userId) || null,
  }));
};

const getBonusForPosition = (position, values) => {
  if (position === 1) return values['season.bonus_first'];
  if (position === 2) return values['season.bonus_second'];
  if (position === 3) return values['season.bonus_third'];
  return values['season.bonus_rest_of_podium'];
};

/**
 * Cierra una temporada: premia al podio, guarda el resultado y la desactiva.
 *
 * Es idempotente por `closedAt`: si ya se cerró, no vuelve a pagar bonus. Esto
 * importa porque el bonus se otorga como puntos reales y no hay vuelta atrás
 * automática.
 */
const closeSeason = async (seasonId, adminId) => {
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) throw new SeasonError('No encontramos esa temporada.', 404);
  if (season.closedAt) {
    throw new SeasonError('Esa temporada ya está cerrada.', 409);
  }

  const values = await scoringConfig.getValues();

  const podiumSize = Math.max(1, Math.round(values['season.podium_size'] || 3));
  const standings = await getStandings(season, { limit: podiumSize });

  const awarded = [];

  for (const entry of standings) {
    const bonus = Math.round(getBonusForPosition(entry.position, values) || 0);
    if (bonus <= 0) continue;

    try {
      await awardPoints(entry.userId, {
        points: bonus,
        reason: `Cierre de temporada ${season.name}: puesto #${entry.position}`,
        source: 'SEASON_CLOSE',
        createdBy: adminId || null,
        silent: true,
      });
      awarded.push({ ...entry, bonus });
    } catch (error) {
      console.error(
        `[Season] No se pudo premiar a ${entry.userId} en ${season.name}:`,
        error.message
      );
    }
  }

  const closed = await prisma.season.update({
    where: { id: season.id },
    data: {
      closedAt: new Date(),
      closedBy: adminId || null,
      isActive: false,
      podium: awarded.map((a) => ({
        position: a.position,
        userId: a.userId,
        totalPoints: a.totalPoints,
        bonus: a.bonus,
      })),
    },
  });

  // Los avisos van después de persistir: si falla una notificación, el cierre
  // ya quedó registrado y no se paga de nuevo.
  for (const entry of awarded) {
    const place = PODIUM_LABELS[entry.position - 1] || `puesto #${entry.position}`;
    try {
      await notify(entry.userId, 'SYSTEM', {
        title: `Cerró la temporada ${season.name}`,
        body: `Salíste ${place} con ${entry.totalPoints} pts y te sumamos ${entry.bonus} pts de bonus.`,
        payload: {
          kind: 'season_close',
          seasonId: season.id,
          position: entry.position,
          screen: 'Leaderboards',
        },
        dedupeKey: `season-close-${season.id}-${entry.userId}`,
        dedupeSeconds: 30 * 24 * 3600,
      });
    } catch (error) {
      console.error('[Season] notify falló:', error.message);
    }
  }

  return { season: closed, podium: awarded };
};

/** Vista previa: quién cobraría qué si se cerrara ahora. Sin efectos. */
const previewClose = async (seasonId) => {
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season) throw new SeasonError('No encontramos esa temporada.', 404);

  const values = await scoringConfig.getValues();

  const podiumSize = Math.max(1, Math.round(values['season.podium_size'] || 3));
  const standings = await getStandings(season, { limit: podiumSize });

  return {
    season,
    alreadyClosed: !!season.closedAt,
    podium: standings.map((entry) => ({
      ...entry,
      bonus: Math.round(getBonusForPosition(entry.position, values) || 0),
    })),
  };
};

module.exports = { SeasonError, closeSeason, previewClose, getStandings };
