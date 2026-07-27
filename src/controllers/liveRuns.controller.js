const crypto = require('crypto');
const polyline = require('@mapbox/polyline');
const prisma = require('../lib/prisma');
const { getIO } = require('../services/socket.service');
const { notify } = require('../services/notifications.service');
const scoringService = require('../services/scoring.service');
const gamificationService = require('../services/gamification.service');
const referralService = require('../services/referral.service');

const USER_PUBLIC = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
};

const roomName = (sessionId) => `live_run:${sessionId}`;

const getAcceptedFriendIds = async (userId) => {
  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ userId }, { friendId: userId }],
    },
  });
  return friendships.map((f) => (f.userId === userId ? f.friendId : f.userId));
};

const areFriends = async (a, b) => {
  if (!a || !b || a === b) return a === b;
  const row = await prisma.friendship.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { userId: a, friendId: b },
        { userId: b, friendId: a },
      ],
    },
  });
  return Boolean(row);
};

const canViewSession = async (viewerId, session, inviteToken) => {
  if (!session) return false;
  if (session.userId === viewerId) return true;
  if (inviteToken && session.inviteToken === inviteToken) return true;
  if (session.visibility === 'FRIENDS') {
    return areFriends(viewerId, session.userId);
  }
  return false;
};

const serializeSession = (session, extras = {}) => ({
  id: session.id,
  userId: session.userId,
  status: session.status,
  visibility: session.visibility,
  inviteToken: session.inviteToken,
  activityType: session.activityType,
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  lastLat: session.lastLat,
  lastLng: session.lastLng,
  distanceKm: session.distanceKm,
  movingTime: session.movingTime,
  lastHr: session.lastHr,
  hrSource: session.hrSource,
  viewerCount: session.viewerCount,
  lastSeq: session.lastSeq,
  activityId: session.activityId,
  user: session.user || undefined,
  ...extras,
});

const safeScore = async (userId, activity) => {
  try {
    const scoreResult = await scoringService.awardActivityPointsIfNotScored(activity.id);
    const completedMissions = await gamificationService.checkMissionsForActivity(userId, activity);
    return {
      points: scoreResult?.pointsAwarded ?? scoreResult?.points ?? 0,
      rank: scoreResult?.rank ?? null,
      completedMissions: completedMissions || [],
    };
  } catch (err) {
    console.warn('[LiveRun] scoring failed:', err.message);
    return { points: 0, rank: null, completedMissions: [] };
  }
};

const startLiveRun = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityType = 'RUN', visibility = 'FRIENDS' } = req.body || {};

    const existing = await prisma.liveRunSession.findFirst({
      where: { userId, status: { in: ['LIVE', 'PAUSED'] } },
    });
    if (existing) {
      return res.status(409).json({
        error: 'Ya tenés una transmisión en vivo. Finalizala antes de empezar otra.',
        session: serializeSession(existing),
      });
    }

    const inviteToken = crypto.randomBytes(16).toString('hex');
    const session = await prisma.liveRunSession.create({
      data: {
        userId,
        activityType: String(activityType || 'RUN').toUpperCase(),
        visibility: visibility === 'INVITE_ONLY' ? 'INVITE_ONLY' : 'FRIENDS',
        inviteToken,
      },
      include: { user: { select: USER_PUBLIC } },
    });

    // Avisar amigos (no bloquea si falla)
    if (session.visibility === 'FRIENDS') {
      const friendIds = await getAcceptedFriendIds(userId);
      const runnerName =
        session.user?.username ||
        [session.user?.firstName, session.user?.lastName].filter(Boolean).join(' ') ||
        'Un amigo';
      await Promise.allSettled(
        friendIds.map((friendId) =>
          notify(friendId, 'LIVE_RUN_STARTED', {
            title: `${runnerName} está en vivo`,
            body: 'Entrá a ver su corrida en el mapa.',
            payload: {
              screen: 'LiveWatch',
              sessionId: session.id,
              dedupeKey: `live_run_start_${session.id}_${friendId}`,
            },
            dedupeKey: `live_run_start_${session.id}_${friendId}`,
          })
        )
      );
    }

    res.status(201).json({ session: serializeSession(session) });
  } catch (error) {
    console.error('[LiveRun] start:', error);
    res.status(500).json({ error: 'No se pudo iniciar la transmisión en vivo.' });
  }
};

const listLiveRuns = async (req, res) => {
  try {
    const userId = req.user.id;
    const friendIds = await getAcceptedFriendIds(userId);
    if (friendIds.length === 0) {
      return res.json({ sessions: [] });
    }

    const sessions = await prisma.liveRunSession.findMany({
      where: {
        status: { in: ['LIVE', 'PAUSED'] },
        visibility: 'FRIENDS',
        userId: { in: friendIds },
      },
      include: { user: { select: USER_PUBLIC } },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });

    res.json({ sessions: sessions.map((s) => serializeSession(s)) });
  } catch (error) {
    console.error('[LiveRun] list:', error);
    res.status(500).json({ error: 'No se pudieron listar las transmisiones.' });
  }
};

const getLiveRun = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const inviteToken = req.query.inviteToken || req.headers['x-live-invite'];

    const session = await prisma.liveRunSession.findUnique({
      where: { id },
      include: {
        user: { select: USER_PUBLIC },
        chatMessages: {
          orderBy: { createdAt: 'desc' },
          take: 40,
          include: { user: { select: USER_PUBLIC } },
        },
      },
    });

    if (!session) {
      return res.status(404).json({ error: 'Transmisión no encontrada.' });
    }

    const allowed = await canViewSession(userId, session, inviteToken);
    if (!allowed) {
      return res.status(403).json({ error: 'No tenés acceso a esta transmisión.' });
    }

    const chat = [...(session.chatMessages || [])].reverse();
    res.json({
      session: serializeSession(session, {
        chat: chat.map((m) => ({
          id: m.id,
          body: m.body,
          createdAt: m.createdAt,
          user: m.user,
        })),
      }),
    });
  } catch (error) {
    console.error('[LiveRun] get:', error);
    res.status(500).json({ error: 'No se pudo cargar la transmisión.' });
  }
};

const resolveInvite = async (req, res) => {
  try {
    const { token } = req.params;
    const session = await prisma.liveRunSession.findUnique({
      where: { inviteToken: token },
      include: { user: { select: USER_PUBLIC } },
    });
    if (!session || !['LIVE', 'PAUSED'].includes(session.status)) {
      return res.status(404).json({ error: 'El enlace ya no es válido o la transmisión terminó.' });
    }
    res.json({ session: serializeSession(session) });
  } catch (error) {
    console.error('[LiveRun] invite:', error);
    res.status(500).json({ error: 'No se pudo resolver el enlace.' });
  }
};

const cancelLiveRun = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const session = await prisma.liveRunSession.findUnique({ where: { id } });
    if (!session || session.userId !== userId) {
      return res.status(404).json({ error: 'Transmisión no encontrada.' });
    }
    if (['ENDED', 'CANCELLED'].includes(session.status)) {
      return res.json({ session: serializeSession(session) });
    }

    const updated = await prisma.liveRunSession.update({
      where: { id },
      data: { status: 'CANCELLED', endedAt: new Date() },
      include: { user: { select: USER_PUBLIC } },
    });

    try {
      getIO().to(roomName(id)).emit('live_run:end', {
        sessionId: id,
        status: 'CANCELLED',
        activityId: null,
      });
    } catch (_) {
      /* socket opcional */
    }

    res.json({ session: serializeSession(updated) });
  } catch (error) {
    console.error('[LiveRun] cancel:', error);
    res.status(500).json({ error: 'No se pudo cancelar la transmisión.' });
  }
};

/** Aplica un tick (socket o REST background) y emite a la room. */
const applyLiveTick = async (userId, payload = {}) => {
  const {
    sessionId,
    seq,
    lat,
    lng,
    distanceKm,
    movingTime,
    paceMinKm,
    altitudeM,
    hr,
    hrSource,
    recordedAt,
  } = payload;
  if (!sessionId || lat == null || lng == null) return null;

  const session = await prisma.liveRunSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) return null;
  if (!['LIVE', 'PAUSED'].includes(session.status)) return null;

  const nextSeq = Number.isFinite(seq) ? seq : session.lastSeq + 1;
  if (nextSeq < session.lastSeq) return null;

  const tick = {
    sessionId,
    seq: nextSeq,
    lat: Number(lat),
    lng: Number(lng),
    distanceKm: distanceKm != null ? Number(distanceKm) : session.distanceKm,
    movingTime: movingTime != null ? parseInt(movingTime, 10) : session.movingTime,
    paceMinKm: paceMinKm != null ? Number(paceMinKm) : null,
    altitudeM: altitudeM != null ? Number(altitudeM) : null,
    hr: hr != null ? parseInt(hr, 10) : null,
    hrSource: hrSource || null,
    recordedAt: recordedAt || new Date().toISOString(),
  };

  const shouldPersist = nextSeq === 1 || nextSeq % 5 === 0;
  const updates = {
    lastLat: tick.lat,
    lastLng: tick.lng,
    lastSeq: nextSeq,
    distanceKm: tick.distanceKm,
    movingTime: tick.movingTime,
    lastHr: tick.hr != null ? tick.hr : undefined,
    hrSource: tick.hrSource != null ? tick.hrSource : undefined,
    status: 'LIVE',
  };
  Object.keys(updates).forEach((k) => updates[k] === undefined && delete updates[k]);

  if (shouldPersist) {
    await prisma.$transaction([
      prisma.liveRunSession.update({ where: { id: sessionId }, data: updates }),
      prisma.liveRunPoint.create({
        data: {
          sessionId,
          seq: nextSeq,
          lat: tick.lat,
          lng: tick.lng,
          distanceKm: tick.distanceKm,
          movingTime: tick.movingTime,
          hr: tick.hr,
          recordedAt: new Date(tick.recordedAt),
        },
      }),
    ]);
  } else {
    await prisma.liveRunSession.update({ where: { id: sessionId }, data: updates });
  }

  try {
    getIO().to(roomName(sessionId)).emit('live_run:tick', tick);
  } catch (_) {
    /* socket opcional en HTTP */
  }
  return tick;
};

/** REST tick para GPS en segundo plano (cuando el socket no está activo). */
const postLiveTick = async (req, res) => {
  try {
    const tick = await applyLiveTick(req.user.id, {
      ...(req.body || {}),
      sessionId: req.params.id,
    });
    if (!tick) {
      return res.status(400).json({ error: 'Tick inválido o sesión no disponible.' });
    }
    res.json({ ok: true, tick });
  } catch (error) {
    console.error('[LiveRun] postTick:', error);
    res.status(500).json({ error: 'No se pudo registrar el tick.' });
  }
};

/** Cierra transmisiones zombie (LIVE sin update > 6h). */
const cleanupStaleLiveRuns = async () => {
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const stale = await prisma.liveRunSession.findMany({
    where: {
      status: { in: ['LIVE', 'PAUSED'] },
      updatedAt: { lt: cutoff },
    },
    take: 50,
  });
  for (const session of stale) {
    await prisma.liveRunSession.update({
      where: { id: session.id },
      data: { status: 'CANCELLED', endedAt: new Date() },
    });
    try {
      getIO().to(roomName(session.id)).emit('live_run:end', {
        sessionId: session.id,
        status: 'CANCELLED',
        activityId: null,
        reason: 'stale',
      });
    } catch (_) {
      /* ignore */
    }
  }
  return stale.length;
};

const endLiveRun = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const {
      name,
      distanceKm,
      elevationM = 0,
      movingTime,
      coordinates,
      mapPolyline,
      averageHr,
      maxHr,
      calories,
      visibility = 'PUBLIC',
      rpe,
      notes,
    } = req.body || {};

    const session = await prisma.liveRunSession.findUnique({ where: { id } });
    if (!session || session.userId !== userId) {
      return res.status(404).json({ error: 'Transmisión no encontrada.' });
    }
    if (session.status === 'ENDED' && session.activityId) {
      const activity = await prisma.activity.findUnique({ where: { id: session.activityId } });
      return res.json({
        session: serializeSession(session),
        activity,
        scoring: null,
        alreadyEnded: true,
      });
    }

    const dist =
      Math.round((parseFloat(distanceKm ?? session.distanceKm) || 0) * 100) / 100;
    const moveSecs = parseInt(movingTime ?? session.movingTime, 10) || 0;
    const elev = Math.round((parseFloat(elevationM) || 0) * 10) / 10;

    let encodedPolyline = null;
    try {
      if (Array.isArray(coordinates) && coordinates.length > 0) {
        const valid = coordinates.filter(
          (c) => Array.isArray(c) && c.length >= 2 && !Number.isNaN(c[0]) && !Number.isNaN(c[1])
        );
        if (valid.length > 0) encodedPolyline = polyline.encode(valid);
      } else if (typeof mapPolyline === 'string' && mapPolyline.trim()) {
        encodedPolyline = mapPolyline;
      }
    } catch (err) {
      console.warn('[LiveRun] polyline:', err.message);
    }

    const avgHr =
      averageHr != null
        ? parseInt(averageHr, 10)
        : session.lastHr != null
          ? session.lastHr
          : null;
    const mxHr = maxHr != null ? parseInt(maxHr, 10) : null;

    const activityName =
      (typeof name === 'string' && name.trim()) ||
      `En vivo · ${new Date().toLocaleDateString('es-AR')}`;

    const activity = await prisma.activity.create({
      data: {
        user: { connect: { id: userId } },
        name: activityName,
        type: session.activityType || 'RUN',
        distanceKm: dist,
        elevationM: elev,
        movingTime: moveSecs,
        startDate: session.startedAt,
        averageHr: avgHr,
        maxHr: mxHr,
        calories: calories != null ? parseInt(calories, 10) : null,
        mapPolyline: encodedPolyline,
        visibility: visibility || 'PUBLIC',
        rawData: {
          coordinates: Array.isArray(coordinates) ? coordinates : [],
          liveRunSessionId: session.id,
          source: 'live_run',
        },
        isExternal: false,
      },
    });

    if (rpe) {
      await prisma.effortLog
        .create({
          data: {
            userId,
            activityId: activity.id,
            rpe: parseInt(rpe, 10) || 5,
            notes: notes || null,
          },
        })
        .catch(() => {});
    }

    const updated = await prisma.liveRunSession.update({
      where: { id },
      data: {
        status: 'ENDED',
        endedAt: new Date(),
        distanceKm: dist,
        movingTime: moveSecs,
        activityId: activity.id,
        lastHr: avgHr,
      },
      include: { user: { select: USER_PUBLIC } },
    });

    const scoring = await safeScore(userId, activity);
    try {
      await referralService.maybeRewardOnFirstActivity(userId, activity.id);
    } catch (_) {
      /* optional */
    }

    try {
      getIO().to(roomName(id)).emit('live_run:end', {
        sessionId: id,
        status: 'ENDED',
        activityId: activity.id,
        distanceKm: dist,
        movingTime: moveSecs,
      });
    } catch (_) {
      /* socket opcional */
    }

    res.json({
      session: serializeSession(updated),
      activity,
      scoring,
    });
  } catch (error) {
    console.error('[LiveRun] end:', error);
    res.status(500).json({ error: 'No se pudo finalizar la transmisión.' });
  }
};

/**
 * Handlers Socket.io para rooms live_run:* (llamados desde socket.service).
 */
const attachLiveRunSocketHandlers = (io, socket) => {
  const userId = socket.user.id;

  socket.on('live_run:join', async (payload = {}) => {
    try {
      const sessionId = payload.sessionId;
      const inviteToken = payload.inviteToken;
      if (!sessionId) return;

      const session = await prisma.liveRunSession.findUnique({
        where: { id: sessionId },
        include: { user: { select: USER_PUBLIC } },
      });
      if (!session) {
        socket.emit('live_run:error', { message: 'Transmisión no encontrada.' });
        return;
      }

      const allowed = await canViewSession(userId, session, inviteToken);
      if (!allowed) {
        socket.emit('live_run:error', { message: 'No tenés acceso a esta transmisión.' });
        return;
      }

      socket.join(roomName(sessionId));

      if (session.userId !== userId && ['LIVE', 'PAUSED'].includes(session.status)) {
        await prisma.liveRunViewer.upsert({
          where: { sessionId_userId: { sessionId, userId } },
          create: { sessionId, userId },
          update: { lastSeenAt: new Date() },
        });
        const viewerCount = await prisma.liveRunViewer.count({ where: { sessionId } });
        await prisma.liveRunSession.update({
          where: { id: sessionId },
          data: { viewerCount },
        });
        io.to(roomName(sessionId)).emit('live_run:viewers', { sessionId, viewerCount });
      }

      socket.emit('live_run:state', { session: serializeSession(session) });
    } catch (error) {
      socket.emit('live_run:error', { message: 'No se pudo unir a la transmisión.' });
    }
  });

  socket.on('live_run:leave', async (payload = {}) => {
    try {
      const sessionId = payload.sessionId;
      if (!sessionId) return;
      socket.leave(roomName(sessionId));

      const session = await prisma.liveRunSession.findUnique({ where: { id: sessionId } });
      if (session && session.userId !== userId) {
        await prisma.liveRunViewer.deleteMany({ where: { sessionId, userId } });
        const viewerCount = await prisma.liveRunViewer.count({ where: { sessionId } });
        await prisma.liveRunSession.update({
          where: { id: sessionId },
          data: { viewerCount },
        });
        io.to(roomName(sessionId)).emit('live_run:viewers', { sessionId, viewerCount });
      }
    } catch (_) {
      /* ignore */
    }
  });

  socket.on('live_run:tick', async (payload = {}) => {
    try {
      await applyLiveTick(userId, payload);
    } catch (error) {
      console.warn('[LiveRun] tick error:', error.message);
    }
  });

  socket.on('live_run:chat', async (payload = {}) => {
    try {
      const sessionId = payload.sessionId;
      const body = typeof payload.body === 'string' ? payload.body.trim().slice(0, 280) : '';
      if (!sessionId || !body) return;

      const session = await prisma.liveRunSession.findUnique({ where: { id: sessionId } });
      if (!session || !['LIVE', 'PAUSED'].includes(session.status)) return;

      const allowed = await canViewSession(userId, session, payload.inviteToken);
      if (!allowed) return;

      const message = await prisma.liveRunChatMessage.create({
        data: { sessionId, userId, body },
        include: { user: { select: USER_PUBLIC } },
      });

      io.to(roomName(sessionId)).emit('live_run:chat', {
        id: message.id,
        sessionId,
        body: message.body,
        createdAt: message.createdAt,
        user: message.user,
      });
    } catch (error) {
      socket.emit('live_run:error', { message: 'No se pudo enviar el mensaje.' });
    }
  });
};

module.exports = {
  startLiveRun,
  listLiveRuns,
  getLiveRun,
  resolveInvite,
  cancelLiveRun,
  endLiveRun,
  postLiveTick,
  cleanupStaleLiveRuns,
  attachLiveRunSocketHandlers,
  canViewSession,
  roomName,
};
