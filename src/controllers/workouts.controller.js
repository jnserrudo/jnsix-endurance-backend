const prisma = require('../lib/prisma');
const scoringService = require('../services/scoring.service');
const challengesService = require('../services/challenges.service');

const PAGE_SIZE = 20;

const createSession = async (req, res) => {
  try {
    const { name, notes } = req.body;
    const session = await prisma.workoutSession.create({
      data: {
        userId: req.user.id,
        name: name || undefined,
        notes: notes || null
      }
    });
    // Add empty sets array since it's a new session
    res.status(201).json({ ...session, sets: [] });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listSessions = async (req, res) => {
  try {
    const { cursor } = req.query;
    const sessions = await prisma.workoutSession.findMany({
      where: { userId: req.user.id },
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { startedAt: 'desc' },
      include: { _count: { select: { sets: true } } }
    });

    const nextCursor = sessions.length === PAGE_SIZE ? sessions[sessions.length - 1].id : null;
    res.json({ sessions, nextCursor });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getSessionById = async (req, res) => {
  try {
    const session = await prisma.workoutSession.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        sets: {
          include: { exercise: { select: { id: true, name: true, gifUrl: true, image: true } } },
          orderBy: { setNumber: 'asc' }
        }
      }
    });
    if (!session) return res.status(404).json({ error: 'Workout session not found' });
    res.json(session);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const addSet = async (req, res) => {
  try {
    const session = await prisma.workoutSession.findFirst({
      where: { id: req.params.id, userId: req.user.id }
    });
    if (!session) return res.status(404).json({ error: 'Workout session not found' });

    const { exerciseId, reps, weightKg, restSeconds } = req.body;
    if (!exerciseId) return res.status(400).json({ error: 'exerciseId is required' });

    const exercise = await prisma.exercise.findUnique({ where: { id: exerciseId } });
    if (!exercise) return res.status(404).json({ error: 'Exercise not found' });

    const lastSet = await prisma.workoutSet.findFirst({
      where: { sessionId: session.id, exerciseId },
      orderBy: { setNumber: 'desc' }
    });
    const setNumber = (lastSet?.setNumber || 0) + 1;

    const set = await prisma.workoutSet.create({
      data: {
        sessionId: session.id,
        exerciseId,
        setNumber,
        reps: reps ?? null,
        weightKg: weightKg ?? null,
        restSeconds: restSeconds ?? null,
        completedAt: new Date()
      },
      include: { exercise: { select: { id: true, name: true, gifUrl: true } } }
    });

    res.status(201).json(set);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const completeSession = async (req, res) => {
  try {
    const session = await prisma.workoutSession.findFirst({
      where: { id: req.params.id, userId: req.user.id }
    });
    if (!session) return res.status(404).json({ error: 'Workout session not found' });
    if (session.completedAt) return res.status(400).json({ error: 'Session already completed' });

    const updated = await prisma.workoutSession.update({
      where: { id: session.id },
      data: { completedAt: new Date() }
    });

    scoringService.awardWorkoutPoints(session.id).catch((err) => {
      console.error('[Scoring] Failed to award workout points:', err.message);
    });

    challengesService.updateChallengeProgress(req.user.id).catch((err) => {
      console.error('[Challenges] Failed to update progress after workout:', err.message);
    });

    res.json(updated);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const deleteSession = async (req, res) => {
  try {
    const session = await prisma.workoutSession.findFirst({
      where: { id: req.params.id, userId: req.user.id }
    });
    if (!session) return res.status(404).json({ error: 'Workout session not found' });

    await prisma.workoutSession.delete({ where: { id: session.id } });
    res.json({ message: 'Workout session deleted' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  createSession,
  listSessions,
  getSessionById,
  addSet,
  completeSession,
  deleteSession
};
