const prisma = require('../lib/prisma');

const getComparisons = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const comparisons = await prisma.activityComparison.findMany({
      where: { userId },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        activities: {
          include: {
            activity: {
              select: {
                id: true,
                name: true,
                type: true,
                distanceKm: true,
                elevationM: true,
                movingTime: true,
                startDate: true
              }
            }
          }
        },
        _count: {
          select: { activities: true }
        }
      }
    });

    const total = await prisma.activityComparison.count({ where: { userId } });

    res.json({
      comparisons,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const getComparisonById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const comparison = await prisma.activityComparison.findFirst({
      where: { id, userId },
      include: {
        activities: {
          include: {
            activity: {
              include: {
                laps: {
                  orderBy: { splitNum: 'asc' }
                }
              }
            }
          }
        }
      }
    });

    if (!comparison) {
      return res.status(404).json({ error: 'No encontramos esa comparación.' });
    }

    res.json(comparison);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const createComparison = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, description, activityIds } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Poné un nombre para la comparación.' });
    }

    if (!activityIds || activityIds.length < 2) {
      return res.status(400).json({ error: 'Elegí al menos 2 actividades para comparar.' });
    }

    const activities = await prisma.activity.findMany({
      where: {
        id: { in: activityIds },
        OR: [
          { userId },
          { isExternal: true }
        ]
      }
    });

    if (activities.length !== activityIds.length) {
      return res.status(404).json({ error: 'Algunas actividades ya no están disponibles.' });
    }

    const comparison = await prisma.activityComparison.create({
      data: {
        userId,
        name,
        description,
        activities: {
          create: activityIds.map((activityId, index) => ({
            activityId,
            color: getDefaultColor(index),
            label: `Actividad ${index + 1}`
          }))
        }
      },
      include: {
        activities: {
          include: {
            activity: true
          }
        }
      }
    });

    res.status(201).json(comparison);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const addActivityToComparison = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { activityId, color, label } = req.body;

    const comparison = await prisma.activityComparison.findFirst({
      where: { id, userId },
      include: { activities: true }
    });

    if (!comparison) {
      return res.status(404).json({ error: 'No encontramos esa comparación.' });
    }

    const activity = await prisma.activity.findFirst({
      where: {
        id: activityId,
        OR: [
          { userId },
          { isExternal: true }
        ]
      }
    });

    if (!activity) {
      return res.status(404).json({ error: 'No encontramos esa actividad.' });
    }

    const existingLink = comparison.activities.find(a => a.activityId === activityId);
    if (existingLink) {
      return res.status(409).json({ error: 'Esa actividad ya está en la comparación.' });
    }

    const comparisonActivity = await prisma.comparisonActivity.create({
      data: {
        comparisonId: id,
        activityId,
        color: color || getDefaultColor(comparison.activities.length),
        label: label || `Actividad ${comparison.activities.length + 1}`
      },
      include: {
        activity: true
      }
    });

    res.status(201).json(comparisonActivity);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const removeActivityFromComparison = async (req, res) => {
  try {
    const { id, activityId } = req.params;
    const userId = req.user.id;

    const comparison = await prisma.activityComparison.findFirst({
      where: { id, userId }
    });

    if (!comparison) {
      return res.status(404).json({ error: 'No encontramos esa comparación.' });
    }

    const deleted = await prisma.comparisonActivity.deleteMany({
      where: {
        comparisonId: id,
        activityId
      }
    });

    if (deleted.count === 0) {
      return res.status(404).json({ error: 'Esa actividad no está en la comparación.' });
    }

    res.json({ message: 'Actividad quitada de la comparación.' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const updateComparison = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { name, description } = req.body;

    const comparison = await prisma.activityComparison.findFirst({
      where: { id, userId }
    });

    if (!comparison) {
      return res.status(404).json({ error: 'No encontramos esa comparación.' });
    }

    const updated = await prisma.activityComparison.update({
      where: { id },
      data: {
        name: name || comparison.name,
        description: description !== undefined ? description : comparison.description
      },
      include: {
        activities: {
          include: {
            activity: true
          }
        }
      }
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const deleteComparison = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const comparison = await prisma.activityComparison.findFirst({
      where: { id, userId }
    });

    if (!comparison) {
      return res.status(404).json({ error: 'No encontramos esa comparación.' });
    }

    await prisma.activityComparison.delete({
      where: { id }
    });

    res.json({ message: 'Comparación eliminada.' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Algo salió mal. Intentá de nuevo en unos minutos.' });
  }
};

const getDefaultColor = (index) => {
  const colors = ['#00E5FF', '#FF2A5F', '#B5FF3A', '#F59E0B', '#8B5CF6', '#EC4899'];
  return colors[index % colors.length];
};

module.exports = {
  getComparisons,
  getComparisonById,
  createComparison,
  addActivityToComparison,
  removeActivityFromComparison,
  updateComparison,
  deleteComparison
};
