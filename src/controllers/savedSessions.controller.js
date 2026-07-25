const prisma = require('../lib/prisma');

const listSavedSessions = async (req, res) => {
  try {
    const sessions = await prisma.savedSession.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(sessions);
  } catch (error) {
    console.error('[LIST SAVED SESSIONS]', error);
    res.status(500).json({ error: 'No pudimos cargar tus sesiones guardadas.' });
  }
};

const createSavedSession = async (req, res) => {
  try {
    const { name, description, targetMetric, targetValue, sportType } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'Poné un nombre para la sesión.' });
    }

    const session = await prisma.savedSession.create({
      data: {
        userId: req.user.id,
        name: name.trim(),
        description: description?.trim() || null,
        targetMetric: targetMetric || null,
        targetValue:
          targetValue != null && targetValue !== '' && Number.isFinite(Number(targetValue))
            ? Number(targetValue)
            : null,
        sportType: sportType || null,
      },
    });
    res.status(201).json(session);
  } catch (error) {
    console.error('[CREATE SAVED SESSION]', error);
    res.status(500).json({ error: 'No pudimos guardar la sesión.' });
  }
};

const deleteSavedSession = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.savedSession.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'No encontramos esa sesión guardada.' });
    }
    await prisma.savedSession.delete({ where: { id } });
    res.json({ ok: true });
  } catch (error) {
    console.error('[DELETE SAVED SESSION]', error);
    res.status(500).json({ error: 'No pudimos eliminar la sesión.' });
  }
};

module.exports = {
  listSavedSessions,
  createSavedSession,
  deleteSavedSession,
};
