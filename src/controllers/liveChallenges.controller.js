const { prisma } = require('../lib/prisma');

// Obtener todos los retos en vivo
const getChallenges = async (req, res) => {
  try {
    const challenges = await prisma.liveChallenge.findMany({
      where: {
        status: { in: ['SCHEDULED', 'IN_PROGRESS'] } // Solo traer los activos o programados
      },
      orderBy: { scheduledAt: 'asc' }
    });
    res.json(challenges);
  } catch (error) {
    console.error('[GET LIVE CHALLENGES ERROR]', error);
    res.status(500).json({ error: 'Error al obtener retos en vivo' });
  }
};

// Crear reto en vivo
const createChallenge = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, description, startDate, endDate, targetDistance, type } = req.body;

    const challenge = await prisma.liveChallenge.create({
      data: {
        name,
        description,
        scheduledAt: new Date(startDate || Date.now()),
        status: 'SCHEDULED'
      }
    });

    res.status(201).json(challenge);
  } catch (error) {
    console.error('[CREATE LIVE CHALLENGE ERROR]', error);
    res.status(500).json({ error: 'Error al crear reto en vivo' });
  }
};

module.exports = {
  getChallenges,
  createChallenge
};
