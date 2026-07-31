const prisma = require('../lib/prisma');
const { notify } = require('../services/notifications.service');
const { resolveSponsor } = require('../services/challenges.service');

const createChallenge = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      name,
      description,
      type,
      metric,
      targetValue,
      startDate,
      endDate,
      groupId,
      communityId,
      sponsorBusinessId,
      sponsorRewardId,
      sponsorLabel,
    } = req.body;

    if (!name || !metric || !targetValue || !startDate || !endDate) {
      return res.status(400).json({
        error: 'Campos requeridos: name, metric, targetValue, startDate, endDate',
      });
    }

    const validMetrics = ['DISTANCE', 'ELEVATION', 'TIME', 'FREQUENCY'];
    if (!validMetrics.includes(metric)) {
      return res.status(400).json({
        error: `Métrica inválida. Debe ser una de: ${validMetrics.join(', ')}`,
      });
    }

    // Validar scope
    if (type === 'GROUP' && groupId) {
      const member = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId } },
      });
      if (!member) return res.status(403).json({ error: 'No eres miembro de este grupo' });
    }

    if (type === 'COMMUNITY' && communityId) {
      const member = await prisma.communityMember.findUnique({
        where: { communityId_userId: { communityId, userId } },
      });
      if (!member) return res.status(403).json({ error: 'No eres miembro de esta comunidad' });
    }

    let sponsor;
    try {
      sponsor = await resolveSponsor({ sponsorBusinessId, sponsorRewardId, sponsorLabel });
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }

    const challenge = await prisma.challenge.create({
      data: {
        name,
        description,
        type: type || 'GLOBAL',
        metric,
        targetValue: parseFloat(targetValue),
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        createdById: userId,
        groupId: type === 'GROUP' ? groupId : null,
        communityId: type === 'COMMUNITY' ? communityId : null,
        ...sponsor,
      },
      include: {
        sponsorBusiness: { select: { id: true, name: true, logoUrl: true } },
        sponsorReward: { select: { id: true, title: true, pointsCost: true, imageUrl: true } },
      },
    });

    res.status(201).json(challenge);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'No pudimos crear el reto. Intentá de nuevo.' });
  }
};

const listChallenges = async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, metric, active } = req.query;
    const where = { deletedAt: null };

    if (type) where.type = type;
    if (metric) where.metric = metric;
    if (active === 'true') {
      where.isActive = true;
      where.endDate = { gte: new Date() };
    }

    const challenges = await prisma.challenge.findMany({
      where,
      include: {
        createdBy: { select: { id: true, email: true } },
        sponsorBusiness: { select: { id: true, name: true, logoUrl: true } },
        sponsorReward: { select: { id: true, title: true, pointsCost: true, imageUrl: true } },
        _count: { select: { participants: true } },
        participants: {
          where: { userId },
          select: {
            currentProgress: true,
            completed: true,
            sponsorRewardGranted: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(
      challenges.map((c) => {
        const myParticipant = c.participants[0];
        return {
          ...c,
          isParticipant: !!myParticipant,
          currentProgress: myParticipant?.currentProgress || 0,
          completed: !!myParticipant?.completed,
          sponsorRewardGranted: !!myParticipant?.sponsorRewardGranted,
          isSponsored: !!c.sponsorBusinessId,
        };
      })
    );
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getChallengeById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const challenge = await prisma.challenge.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, email: true } },
        group: { select: { id: true, name: true } },
        community: { select: { id: true, name: true } },
        sponsorBusiness: { select: { id: true, name: true, logoUrl: true } },
        sponsorReward: { select: { id: true, title: true, pointsCost: true, imageUrl: true } },
        participants: {
          include: { user: { select: { id: true, email: true } } },
          orderBy: { currentProgress: 'desc' },
        },
      },
    });

    if (!challenge || challenge.deletedAt) {
      return res.status(404).json({ error: 'No encontramos ese reto.' });
    }

    const isParticipant = challenge.participants.some((p) => p.userId === userId);

    res.json({ ...challenge, isParticipant, isSponsored: !!challenge.sponsorBusinessId });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const updateChallenge = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const {
      name,
      description,
      targetValue,
      startDate,
      endDate,
      isActive,
      sponsorBusinessId,
      sponsorRewardId,
      sponsorLabel,
    } = req.body;

    const challenge = await prisma.challenge.findUnique({ where: { id } });
    if (!challenge || challenge.deletedAt) {
      return res.status(404).json({ error: 'No encontramos ese reto.' });
    }

    if (challenge.createdById !== userId && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo el creador o un admin puede editar este reto' });
    }

    let sponsorPatch = {};
    if (
      sponsorBusinessId !== undefined ||
      sponsorRewardId !== undefined ||
      sponsorLabel !== undefined
    ) {
      try {
        sponsorPatch = await resolveSponsor({
          sponsorBusinessId:
            sponsorBusinessId === undefined ? challenge.sponsorBusinessId : sponsorBusinessId,
          sponsorRewardId:
            sponsorRewardId === undefined ? challenge.sponsorRewardId : sponsorRewardId,
          sponsorLabel: sponsorLabel === undefined ? challenge.sponsorLabel : sponsorLabel,
        });
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
      }
    }

    const updated = await prisma.challenge.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(targetValue !== undefined && { targetValue: parseFloat(targetValue) }),
        ...(startDate !== undefined && { startDate: new Date(startDate) }),
        ...(endDate !== undefined && { endDate: new Date(endDate) }),
        ...(isActive !== undefined && { isActive }),
        ...sponsorPatch,
      },
      include: {
        sponsorBusiness: { select: { id: true, name: true, logoUrl: true } },
        sponsorReward: { select: { id: true, title: true, pointsCost: true, imageUrl: true } },
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const deleteChallenge = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const challenge = await prisma.challenge.findUnique({ where: { id } });
    if (!challenge || challenge.deletedAt) {
      return res.status(404).json({ error: 'Challenge not found' });
    }

    if (challenge.createdById !== userId && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Solo el creador o un admin puede eliminar este reto' });
    }

    await prisma.challenge.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false }
    });

    res.json({ message: 'Challenge deleted successfully' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const joinChallenge = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const challenge = await prisma.challenge.findUnique({ where: { id } });
    if (!challenge || challenge.deletedAt || !challenge.isActive) {
      return res.status(404).json({ error: 'Challenge not found or inactive' });
    }

    if (new Date() > challenge.endDate) {
      return res.status(400).json({ error: 'Este reto ya venció' });
    }

    // Verificar membresía si es GROUP o COMMUNITY
    if (challenge.type === 'GROUP' && challenge.groupId) {
      const member = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: challenge.groupId, userId } }
      });
      if (!member) return res.status(403).json({ error: 'Debes ser miembro del grupo para unirte a este reto' });
    }

    if (challenge.type === 'COMMUNITY' && challenge.communityId) {
      const member = await prisma.communityMember.findUnique({
        where: { communityId_userId: { communityId: challenge.communityId, userId } }
      });
      if (!member) return res.status(403).json({ error: 'Debes ser miembro de la comunidad para unirte a este reto' });
    }

    const existing = await prisma.challengeParticipant.findUnique({
      where: { challengeId_userId: { challengeId: id, userId } }
    });

    if (existing) {
      return res.status(409).json({ error: 'Ya estás inscrito en este reto' });
    }

    const participant = await prisma.challengeParticipant.create({
      data: { challengeId: id, userId }
    });

    res.status(201).json(participant);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const leaveChallenge = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const existing = await prisma.challengeParticipant.findUnique({
      where: { challengeId_userId: { challengeId: id, userId } }
    });

    if (!existing) {
      return res.status(404).json({ error: 'No estás inscrito en este reto' });
    }

    await prisma.challengeParticipant.delete({
      where: { challengeId_userId: { challengeId: id, userId } }
    });

    res.json({ message: 'Left challenge successfully' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getChallengeRanking = async (req, res) => {
  try {
    const { id } = req.params;

    const challenge = await prisma.challenge.findUnique({ where: { id } });
    if (!challenge || challenge.deletedAt) {
      return res.status(404).json({ error: 'Challenge not found' });
    }

    const participants = await prisma.challengeParticipant.findMany({
      where: { challengeId: id },
      include: { user: { select: { id: true, email: true } } },
      orderBy: { currentProgress: 'desc' }
    });

    const ranking = participants.map((p, index) => ({
      position: index + 1,
      userId: p.userId,
      email: p.user.email,
      currentProgress: p.currentProgress,
      completed: p.completed,
      completedAt: p.completedAt,
      percentage: Math.min(100, Math.round((p.currentProgress / challenge.targetValue) * 100))
    }));

    res.json({ challenge: { id: challenge.id, name: challenge.name, metric: challenge.metric, targetValue: challenge.targetValue }, ranking });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  createChallenge,
  listChallenges,
  getChallengeById,
  updateChallenge,
  deleteChallenge,
  joinChallenge,
  leaveChallenge,
  getChallengeRanking
};
