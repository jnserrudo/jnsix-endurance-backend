const prisma = require('../lib/prisma');

// Obtener todos los segmentos
const getSegments = async (req, res) => {
  try {
    const segments = await prisma.segment.findMany();
    res.json(segments);
  } catch (error) {
    console.error('[GET SEGMENTS ERROR]', error);
    res.status(500).json({ error: 'Error al obtener segmentos' });
  }
};

// Crear un segmento
const createSegment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, distanceKm, startLocation, endLocation, mapPolyline } = req.body;

    const segment = await prisma.segment.create({
      data: {
        name,
        distanceKm: parseFloat(distanceKm),
        startCoords: startLocation || [],
        endCoords: endLocation || [],
        polyline: mapPolyline || ''
      }
    });

    res.status(201).json(segment);
  } catch (error) {
    console.error('[CREATE SEGMENT ERROR]', error);
    res.status(500).json({ error: 'Error al crear segmento' });
  }
};

// Registrar un tiempo en un segmento
const logLeaderboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params; // segmentId
    const { activityId, timeSeconds, averageHr } = req.body;

    const entry = await prisma.segmentLeaderboard.create({
      data: {
        userId,
        segmentId: id,
        activityId,
        timeSeconds: parseInt(timeSeconds),
        date: new Date()
      }
    });

    res.status(201).json(entry);
  } catch (error) {
    console.error('[LOG LEADERBOARD ERROR]', error);
    res.status(500).json({ error: 'Error al registrar tiempo en segmento' });
  }
};

// Obtener el ranking de un segmento
const getLeaderboard = async (req, res) => {
  try {
    const { id } = req.params;
    
    const rankings = await prisma.segmentLeaderboard.findMany({
      where: { segmentId: id },
      orderBy: { timeSeconds: 'asc' },
      take: 100,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } }
      }
    });

    res.json(rankings);
  } catch (error) {
    console.error('[GET LEADERBOARD ERROR]', error);
    res.status(500).json({ error: 'Error al obtener ranking de segmento' });
  }
};

module.exports = {
  getSegments,
  createSegment,
  logLeaderboard,
  getLeaderboard
};
