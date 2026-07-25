const prisma = require('./prisma');
const { notify } = require('../services/notifications.service');

/**
 * Devuelve el conjunto de IDs de usuarios que están "fuera de alcance" para
 * el usuario dado por bloqueo: usuarios que él bloqueó y usuarios que lo
 * bloquearon a él (la relación es bidireccional para ocultar contenido).
 *
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
const getBlockedUserIds = async (userId) => {
  if (!userId) return [];
  const blocks = await prisma.userBlock.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true }
  });
  const ids = new Set();
  for (const b of blocks) {
    ids.add(b.blockerId === userId ? b.blockedId : b.blockerId);
  }
  ids.delete(userId);
  return [...ids];
};

/**
 * Extrae los @usernames mencionados en un texto y devuelve los usuarios
 * existentes (activos) que coinciden.
 *
 * @param {string} content
 * @returns {Promise<Array<{ id: string, username: string }>>}
 */
const findMentionedUsers = async (content) => {
  if (!content || typeof content !== 'string') return [];
  const matches = content.match(/@([a-zA-Z0-9_.]+)/g) || [];
  const usernames = [...new Set(matches.map((m) => m.slice(1)).filter(Boolean))];
  if (usernames.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { username: { in: usernames }, isActive: true, deletedAt: null },
    select: { id: true, username: true }
  });
  return users;
};

/**
 * Extrae los #hashtags de un texto y devuelve la lista de etiquetas en
 * minúsculas (sin el símbolo #, sin duplicados). Los hashtags quedan
 * almacenados en el propio contenido del post; esta función sólo los parsea.
 *
 * @param {string} content
 * @returns {string[]}
 */
const extractHashtags = (content) => {
  if (!content || typeof content !== 'string') return [];
  const matches = content.match(/#([a-zA-Z0-9_áéíóúüñÁÉÍÓÚÜÑ]+)/g) || [];
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()).filter(Boolean))];
};

/**
 * Parsea @menciones en un contenido y envía notificaciones MENTION a cada
 * usuario mencionado (excepto el autor y usuarios bloqueados).
 *
 * @param {object} params
 * @param {string} params.authorId
 * @param {string} params.authorLabel
 * @param {string} params.content
 * @param {'POST'|'COMMENT'} params.targetType
 * @param {string} params.targetId
 */
const notifyMentions = async ({ authorId, authorLabel, content, targetType, targetId }) => {
  try {
    const mentioned = await findMentionedUsers(content);
    if (mentioned.length === 0) return;

    const blocked = new Set(await getBlockedUserIds(authorId));

    await Promise.all(
      mentioned
        .filter((u) => u.id !== authorId && !blocked.has(u.id))
        .map((u) =>
          notify(u.id, 'MENTION', {
            title: 'Te mencionaron',
            body: `${authorLabel} te mencionó en ${targetType === 'POST' ? 'un post' : 'un comentario'}`,
            payload: { targetType, targetId },
            dedupeKey: `mention:${targetType}:${targetId}:${u.id}`
          })
        )
    );
  } catch (error) {
    console.error('[social] notifyMentions failed:', error.message);
  }
};

module.exports = { getBlockedUserIds, findMentionedUsers, notifyMentions, extractHashtags };
