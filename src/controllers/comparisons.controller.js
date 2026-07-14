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
    res.status(500).json({ error: error.message });
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
      return res.status(404).json({ error: 'Comparison not found' });
    }

    res.json(comparison);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createComparison = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, description, activityIds } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    if (!activityIds || activityIds.length < 2) {
      return res.status(400).json({ error: 'At least 2 activities are required' });
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
      return res.status(404).json({ error: 'Some activities not found' });
    }

    const comparison = await prisma.activityComparison.create({
      data: {
        userId,
        name,
        description,
        activities: {
          create: activityIds.map((activityId, index) => ({
            activityId,
            color: this.getDefaultColor(index),
            label: `Activity ${index + 1}`
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
    res.status(500).json({ error: error.message });
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
      return res.status(404).json({ error: 'Comparison not found' });
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
      return res.status(404).json({ error: 'Activity not found' });
    }

    const existingLink = comparison.activities.find(a => a.activityId === activityId);
    if (existingLink) {
      return res.status(409).json({ error: 'Activity already in comparison' });
    }

    const comparisonActivity = await prisma.comparisonActivity.create({
      data: {
        comparisonId: id,
        activityId,
        color: color || this.getDefaultColor(comparison.activities.length),
        label: label || `Activity ${comparison.activities.length + 1}`
      },
      include: {
        activity: true
      }
    });

    res.status(201).json(comparisonActivity);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
      return res.status(404).json({ error: 'Comparison not found' });
    }

    const deleted = await prisma.comparisonActivity.deleteMany({
      where: {
        comparisonId: id,
        activityId
      }
    });

    if (deleted.count === 0) {
      return res.status(404).json({ error: 'Activity not in comparison' });
    }

    res.json({ message: 'Activity removed from comparison' });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
      return res.status(404).json({ error: 'Comparison not found' });
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
    res.status(500).json({ error: error.message });
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
      return res.status(404).json({ error: 'Comparison not found' });
    }

    await prisma.activityComparison.delete({
      where: { id }
    });

    res.json({ message: 'Comparison deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
