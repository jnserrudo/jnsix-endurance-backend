const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getCompetitions = async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('🟢 [GET COMPETITIONS] Usuario ID:', userId);

    const competitions = await prisma.competitionGoal.findMany({
      where: { userId },
      orderBy: { targetDate: 'asc' },
      include: {
        simulations: {
          select: {
            id: true,
            name: true,
            distanceKm: true,
            movingTime: true,
            elevationM: true,
            startDate: true
          }
        }
      }
    });

    res.json(competitions);
  } catch (error) {
    console.error('🔴 [GET COMPETITIONS] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const createCompetition = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, type, distanceKm, elevationM, targetDate, targetTime, terrainType, notes } = req.body;

    if (!name || !type || !distanceKm || !targetDate) {
      return res.status(400).json({ error: 'Name, type, distance, and date are required.' });
    }

    console.log('🟢 [CREATE COMPETITION] Nuevo objetivo:', { name, type, distanceKm });

    const newComp = await prisma.competitionGoal.create({
      data: {
        userId,
        name,
        type,
        distanceKm: parseFloat(distanceKm),
        elevationM: elevationM ? parseFloat(elevationM) : 0,
        targetDate: new Date(targetDate),
        targetTime: targetTime || null,
        terrainType: terrainType || null,
        notes: notes || null
      },
      include: {
        simulations: true
      }
    });

    res.status(201).json(newComp);
  } catch (error) {
    console.error('🔴 [CREATE COMPETITION] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const updateCompetition = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { name, type, distanceKm, elevationM, targetDate, targetTime, terrainType, notes } = req.body;

    const comp = await prisma.competitionGoal.findFirst({
      where: { id, userId }
    });

    if (!comp) {
      return res.status(404).json({ error: 'Competition goal not found.' });
    }

    const updatedComp = await prisma.competitionGoal.update({
      where: { id },
      data: {
        name: name !== undefined ? name : comp.name,
        type: type !== undefined ? type : comp.type,
        distanceKm: distanceKm !== undefined ? parseFloat(distanceKm) : comp.distanceKm,
        elevationM: elevationM !== undefined ? parseFloat(elevationM) : comp.elevationM,
        targetDate: targetDate !== undefined ? new Date(targetDate) : comp.targetDate,
        targetTime: targetTime !== undefined ? targetTime : comp.targetTime,
        terrainType: terrainType !== undefined ? terrainType : comp.terrainType,
        notes: notes !== undefined ? notes : comp.notes
      },
      include: {
        simulations: true
      }
    });

    res.json(updatedComp);
  } catch (error) {
    console.error('🔴 [UPDATE COMPETITION] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const deleteCompetition = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const comp = await prisma.competitionGoal.findFirst({
      where: { id, userId }
    });

    if (!comp) {
      return res.status(404).json({ error: 'Competition goal not found.' });
    }

    await prisma.competitionGoal.delete({
      where: { id }
    });

    res.json({ message: 'Competition goal deleted successfully.' });
  } catch (error) {
    console.error('🔴 [DELETE COMPETITION] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const associateSimulation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params; // Competition ID
    const { activityId, remove = false } = req.body;

    if (!activityId) {
      return res.status(400).json({ error: 'Activity ID is required.' });
    }

    const comp = await prisma.competitionGoal.findFirst({
      where: { id, userId }
    });

    if (!comp) {
      return res.status(404).json({ error: 'Competition goal not found.' });
    }

    // Verify activity belongs to the user
    const activity = await prisma.activity.findFirst({
      where: { id: activityId, userId }
    });

    if (!activity) {
      return res.status(404).json({ error: 'Activity not found.' });
    }

    const updatedComp = await prisma.competitionGoal.update({
      where: { id },
      data: {
        simulations: remove 
          ? { disconnect: { id: activityId } }
          : { connect: { id: activityId } }
      },
      include: {
        simulations: {
          select: {
            id: true,
            name: true,
            distanceKm: true,
            movingTime: true,
            elevationM: true,
            startDate: true
          }
        }
      }
    });

    res.json(updatedComp);
  } catch (error) {
    console.error('🔴 [ASSOCIATE SIMULATION] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getCompetitions,
  createCompetition,
  updateCompetition,
  deleteCompetition,
  associateSimulation
};
