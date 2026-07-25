const prisma = require('../lib/prisma');

const challengeInclude = {
  participants: {
    include: {
      user: { select: { id: true, username: true, firstName: true, lastName: true, avatarUrl: true } }
    }
  },
  _count: { select: { participants: true } }
};

const enrichForUser = (challenge, userId) => {
  const mine = challenge.participants?.find((p) => p.userId === userId) || null;
  const target =
    challenge.targetValue ??
    challenge.targetDistance ??
    null;
  return {
    ...challenge,
    targetValue: target,
    isParticipant: !!mine,
    myProgress: mine?.progress ?? 0,
    myParticipation: mine
      ? { id: mine.id, progress: mine.progress, joinedAt: mine.joinedAt }
      : null
  };
};

const getChallenges = async (req, res) => {
  try {
    const userId = req.user.id;
    const statusFilter = req.query.status;
    let where = {};
    if (statusFilter === 'all') {
      where = {};
    } else if (statusFilter) {
      where = { status: statusFilter };
    } else {
      where = { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } };
    }

    const challenges = await prisma.liveChallenge.findMany({
      where,
      include: challengeInclude,
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }]
    });

    res.json(challenges.map((c) => enrichForUser(c, userId)));
  } catch (error) {
    console.error('[GET LIVE CHALLENGES ERROR]', error);
    res.status(500).json({ error: 'Error al obtener retos en vivo' });
  }
};

const getChallengeById = async (req, res) => {
  try {
    const challenge = await prisma.liveChallenge.findUnique({
      where: { id: req.params.id },
      include: challengeInclude
    });
    if (!challenge) return res.status(404).json({ error: 'Reto no encontrado' });
    res.json(enrichForUser(challenge, req.user.id));
  } catch (error) {
    console.error('[GET LIVE CHALLENGE ERROR]', error);
    res.status(500).json({ error: 'Error al obtener reto' });
  }
};

const createChallenge = async (req, res) => {
  try {
    const {
      name,
      description,
      startDate,
      endDate,
      targetDistance,
      targetValue,
      type,
      status,
      groupId
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });

    const challenge = await prisma.liveChallenge.create({
      data: {
        name: name.trim(),
        description: description || null,
        type: type || 'DISTANCE',
        targetDistance:
          targetDistance != null
            ? parseFloat(targetDistance)
            : targetValue != null
              ? parseFloat(targetValue)
              : null,
        targetValue:
          targetValue != null
            ? parseFloat(targetValue)
            : targetDistance != null
              ? parseFloat(targetDistance)
              : null,
        scheduledAt: new Date(startDate || Date.now()),
        endDate: endDate ? new Date(endDate) : null,
        status: status || 'SCHEDULED',
        groupId: groupId || null
      },
      include: challengeInclude
    });

    res.status(201).json(challenge);
  } catch (error) {
    console.error('[CREATE LIVE CHALLENGE ERROR]', error);
    res.status(500).json({ error: 'Error al crear reto en vivo' });
  }
};

const updateChallenge = async (req, res) => {
  try {
    const existing = await prisma.liveChallenge.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Reto no encontrado' });

    const {
      name,
      description,
      startDate,
      endDate,
      targetDistance,
      targetValue,
      type,
      status,
      groupId
    } = req.body;

    const challenge = await prisma.liveChallenge.update({
      where: { id: req.params.id },
      data: {
        ...(name != null ? { name: String(name).trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(type != null ? { type } : {}),
        ...(targetDistance != null ? { targetDistance: parseFloat(targetDistance) } : {}),
        ...(targetValue != null ? { targetValue: parseFloat(targetValue) } : {}),
        ...(startDate != null ? { scheduledAt: new Date(startDate) } : {}),
        ...(endDate !== undefined ? { endDate: endDate ? new Date(endDate) : null } : {}),
        ...(status != null ? { status } : {}),
        ...(groupId !== undefined ? { groupId } : {})
      },
      include: challengeInclude
    });

    res.json(challenge);
  } catch (error) {
    console.error('[UPDATE LIVE CHALLENGE ERROR]', error);
    res.status(500).json({ error: 'Error al actualizar reto' });
  }
};

const deleteChallenge = async (req, res) => {
  try {
    await prisma.liveChallenge.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    console.error('[DELETE LIVE CHALLENGE ERROR]', error);
    res.status(500).json({ error: 'Error al eliminar reto' });
  }
};

const joinChallenge = async (req, res) => {
  try {
    const userId = req.user.id;
    const liveChallengeId = req.params.id;

    const challenge = await prisma.liveChallenge.findUnique({ where: { id: liveChallengeId } });
    if (!challenge) return res.status(404).json({ error: 'Reto no encontrado' });
    if (challenge.status === 'COMPLETED') {
      return res.status(400).json({ error: 'Este reto ya finalizó' });
    }

    const participant = await prisma.liveChallengeParticipant.upsert({
      where: {
        liveChallengeId_userId: { liveChallengeId, userId }
      },
      create: { liveChallengeId, userId, progress: 0 },
      update: {}
    });

    // Auto-start if scheduled
    if (challenge.status === 'SCHEDULED') {
      await prisma.liveChallenge.update({
        where: { id: liveChallengeId },
        data: { status: 'IN_PROGRESS' }
      });
    }

    res.status(201).json(participant);
  } catch (error) {
    console.error('[JOIN LIVE CHALLENGE ERROR]', error);
    res.status(500).json({ error: 'Error al unirse al reto' });
  }
};

const leaveChallenge = async (req, res) => {
  try {
    const userId = req.user.id;
    const liveChallengeId = req.params.id;

    await prisma.liveChallengeParticipant.deleteMany({
      where: { liveChallengeId, userId }
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('[LEAVE LIVE CHALLENGE ERROR]', error);
    res.status(500).json({ error: 'Error al salir del reto' });
  }
};

const updateProgress = async (req, res) => {
  try {
    const userId = req.user.id;
    const liveChallengeId = req.params.id;
    const { progress, increment } = req.body;

    const challenge = await prisma.liveChallenge.findUnique({ where: { id: liveChallengeId } });
    if (!challenge) return res.status(404).json({ error: 'Reto no encontrado' });

    const existing = await prisma.liveChallengeParticipant.findUnique({
      where: { liveChallengeId_userId: { liveChallengeId, userId } }
    });
    if (!existing) {
      return res.status(400).json({ error: 'No estás unido a este reto' });
    }

    let nextProgress = existing.progress;
    if (increment != null) {
      nextProgress = existing.progress + parseFloat(increment);
    } else if (progress != null) {
      nextProgress = parseFloat(progress);
    } else {
      return res.status(400).json({ error: 'Indicá progress o increment' });
    }

    nextProgress = Math.max(0, nextProgress);

    const updated = await prisma.liveChallengeParticipant.update({
      where: { id: existing.id },
      data: { progress: nextProgress },
      include: {
        user: { select: { id: true, username: true, firstName: true, avatarUrl: true } },
      },
    });

    const target = challenge.targetValue ?? challenge.targetDistance;
    let completed = false;
    if (target != null && nextProgress >= target) {
      completed = true;
    }

    try {
      const { getIO } = require('../services/socket.service');
      const io = getIO();
      io.emit('live_challenge:progress', {
        liveChallengeId,
        userId,
        progress: nextProgress,
        target,
        completed,
        participant: updated,
        user: updated.user,
      });
    } catch (sockErr) {
      // Socket opcional si el server aún no inicializó IO
    }

    res.json({ participant: updated, completed, target });
  } catch (error) {
    console.error('[PROGRESS LIVE CHALLENGE ERROR]', error);
    res.status(500).json({ error: 'Error al actualizar progreso' });
  }
};

module.exports = {
  getChallenges,
  getChallengeById,
  createChallenge,
  updateChallenge,
  deleteChallenge,
  joinChallenge,
  leaveChallenge,
  updateProgress
};
