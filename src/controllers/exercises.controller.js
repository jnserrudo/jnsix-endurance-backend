const prisma = require('../lib/prisma');

const PAGE_SIZE = 24;

const listExercises = async (req, res) => {
  try {
    const { search, category, equipment, target, cursor } = req.query;
    const where = {};

    if (search) {
      where.name = { contains: search };
    }
    if (category) where.category = category;
    if (equipment) where.equipment = equipment;
    if (target) where.target = target;

    const exercises = await prisma.exercise.findMany({
      where,
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        category: true,
        bodyPart: true,
        equipment: true,
        target: true,
        muscleGroup: true,
        image: true,
        gifUrl: true
      }
    });

    const nextCursor = exercises.length === PAGE_SIZE ? exercises[exercises.length - 1].id : null;

    res.json({ exercises, nextCursor });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getExerciseById = async (req, res) => {
  try {
    const exercise = await prisma.exercise.findUnique({
      where: { id: req.params.id }
    });
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });
    res.json(exercise);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getFilters = async (req, res) => {
  try {
    const [categories, equipments, targets] = await Promise.all([
      prisma.exercise.findMany({ distinct: ['category'], select: { category: true }, orderBy: { category: 'asc' } }),
      prisma.exercise.findMany({ distinct: ['equipment'], select: { equipment: true }, orderBy: { equipment: 'asc' } }),
      prisma.exercise.findMany({ distinct: ['target'], select: { target: true }, orderBy: { target: 'asc' } })
    ]);

    res.json({
      categories: categories.map((c) => c.category),
      equipments: equipments.map((e) => e.equipment),
      targets: targets.map((t) => t.target)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  listExercises,
  getExerciseById,
  getFilters
};
