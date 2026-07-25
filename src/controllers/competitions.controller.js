const prisma = require('../lib/prisma');

const SERVER_ERROR = 'Algo salió mal. Intentá de nuevo en unos minutos.';

const getCompetitions = async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('[INFO] [GET COMPETITIONS] Usuario ID:', userId);

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [competitions, monthStats] = await Promise.all([
      prisma.competitionGoal.findMany({
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
          },
          userPlans: {
            where: { isActive: true },
            take: 1,
            include: {
              plan: {
                select: {
                  sessions: { select: { status: true } }
                }
              }
            }
          }
        }
      }),
      prisma.activity.aggregate({
        where: { userId, startDate: { gte: monthStart } },
        _sum: { distanceKm: true }
      })
    ]);

    const kmThisMonth = monthStats._sum.distanceKm || 0;
    res.json(competitions.map((competition) => {
      const sessions = competition.userPlans[0]?.plan?.sessions || [];
      const doneSessions = sessions.filter((session) => session.status === 'DONE').length;
      const totalSessions = sessions.length;
      const { userPlans, ...data } = competition;
      return {
        ...data,
        trainingProgress: {
          doneSessions,
          totalSessions,
          percent: totalSessions ? Math.round((doneSessions / totalSessions) * 100) : 0,
          kmThisMonth,
          hasActivePlan: totalSessions > 0,
        },
      };
    }));
  } catch (error) {
    console.error('[ERROR] [GET COMPETITIONS] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: SERVER_ERROR });
  }
};

const createCompetition = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, type, distanceKm, elevationM, targetDate, targetTime, terrainType, notes } = req.body;

    if (!name || !type || !distanceKm || !targetDate) {
      return res.status(400).json({
        error: 'Completá el nombre, la disciplina, la distancia y la fecha del evento.',
      });
    }

    console.log('[INFO] [CREATE COMPETITION] Nuevo objetivo:', { name, type, distanceKm });

    const parsedDate = new Date(targetDate);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'La fecha del evento no es válida. Volvé a elegirla.' });
    }

    const newComp = await prisma.competitionGoal.create({
      data: {
        userId,
        name,
        type,
        distanceKm: parseFloat(distanceKm),
        elevationM: elevationM ? parseFloat(elevationM) : 0,
        targetDate: parsedDate,
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
    console.error('[ERROR] [CREATE COMPETITION] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: SERVER_ERROR });
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
      return res.status(404).json({ error: 'No encontramos ese objetivo.' });
    }

    let parsedTargetDate = comp.targetDate;
    if (targetDate !== undefined) {
      parsedTargetDate = new Date(targetDate);
      if (isNaN(parsedTargetDate.getTime())) {
        return res.status(400).json({ error: 'La fecha del evento no es válida. Volvé a elegirla.' });
      }
    }

    const updatedComp = await prisma.competitionGoal.update({
      where: { id },
      data: {
        name: name !== undefined ? name : comp.name,
        type: type !== undefined ? type : comp.type,
        distanceKm: distanceKm !== undefined ? parseFloat(distanceKm) : comp.distanceKm,
        elevationM: elevationM !== undefined ? parseFloat(elevationM) : comp.elevationM,
        targetDate: parsedTargetDate,
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
    console.error('[ERROR] [UPDATE COMPETITION] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: SERVER_ERROR });
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
      return res.status(404).json({ error: 'No encontramos ese objetivo.' });
    }

    await prisma.competitionGoal.delete({
      where: { id }
    });

    res.json({ message: 'Objetivo eliminado.' });
  } catch (error) {
    console.error('[ERROR] [DELETE COMPETITION] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: SERVER_ERROR });
  }
};

const associateSimulation = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { activityId, remove = false } = req.body;

    if (!activityId) {
      return res.status(400).json({ error: 'Elegí una actividad para vincular.' });
    }

    const comp = await prisma.competitionGoal.findFirst({
      where: { id, userId }
    });

    if (!comp) {
      return res.status(404).json({ error: 'No encontramos ese objetivo.' });
    }

    const activity = await prisma.activity.findFirst({
      where: { id: activityId, userId }
    });

    if (!activity) {
      return res.status(404).json({ error: 'No encontramos esa actividad.' });
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
    console.error('[ERROR] [ASSOCIATE SIMULATION] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: SERVER_ERROR });
  }
};

module.exports = {
  getCompetitions,
  createCompetition,
  updateCompetition,
  deleteCompetition,
  associateSimulation
};
