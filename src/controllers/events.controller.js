const prisma = require('../lib/prisma');
const { notify } = require('../services/notifications.service');

const RSVP_STATUSES = ['GOING', 'MAYBE', 'DECLINED'];

const eventInclude = (userId) => ({
  creator: { select: { id: true, username: true, firstName: true, avatarUrl: true } },
  group: { select: { id: true, name: true } },
  community: { select: { id: true, name: true } },
  rsvps: {
    include: {
      user: { select: { id: true, username: true, firstName: true, avatarUrl: true } }
    }
  },
  _count: { select: { rsvps: true } }
});

/** Añade el RSVP del usuario actual y conteos por estado al evento. */
const decorateEvent = (event, userId) => {
  const counts = { GOING: 0, MAYBE: 0, DECLINED: 0 };
  for (const r of event.rsvps || []) {
    if (counts[r.status] !== undefined) counts[r.status] += 1;
  }
  const myRsvp = (event.rsvps || []).find((r) => r.userId === userId);
  return { ...event, rsvpCounts: counts, myRsvp: myRsvp?.status || null };
};

/** Verifica que el usuario pertenezca al grupo/comunidad del evento (o sea ADMIN). */
const canAccessScope = async (userId, role, { groupId, communityId }) => {
  if (role === 'ADMIN') return true;
  if (groupId) {
    const m = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } }
    });
    return Boolean(m);
  }
  if (communityId) {
    const m = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId, userId } }
    });
    return Boolean(m);
  }
  return true;
};

const listEvents = async (req, res) => {
  try {
    const userId = req.user.id;
    const { groupId, communityId, scope = 'upcoming' } = req.query;

    const where = {};
    if (groupId) where.groupId = String(groupId);
    if (communityId) where.communityId = String(communityId);
    if (scope === 'upcoming') where.startsAt = { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) };

    const events = await prisma.clubEvent.findMany({
      where,
      orderBy: { startsAt: scope === 'past' ? 'desc' : 'asc' },
      include: eventInclude(userId)
    });

    res.json(events.map((e) => decorateEvent(e, userId)));
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const listGroupEvents = async (req, res) => {
  req.query.groupId = req.params.id;
  return listEvents(req, res);
};

const listCommunityEvents = async (req, res) => {
  req.query.communityId = req.params.id;
  return listEvents(req, res);
};

const getEvent = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const event = await prisma.clubEvent.findUnique({
      where: { id },
      include: eventInclude(userId)
    });
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    res.json(decorateEvent(event, userId));
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const createEvent = async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, description, location, startsAt, endsAt, groupId, communityId } = req.body;

    if (!title || !startsAt) {
      return res.status(400).json({ error: 'title y startsAt son requeridos' });
    }

    const allowed = await canAccessScope(userId, req.user.role, { groupId, communityId });
    if (!allowed) {
      return res.status(403).json({ error: 'Debés ser miembro para crear eventos aquí' });
    }

    const event = await prisma.clubEvent.create({
      data: {
        title,
        description: description || null,
        location: location || null,
        startsAt: new Date(startsAt),
        endsAt: endsAt ? new Date(endsAt) : null,
        groupId: groupId || null,
        communityId: communityId || null,
        creatorId: userId,
        rsvps: { create: { userId, status: 'GOING' } }
      },
      include: eventInclude(userId)
    });

    // Notificar a los miembros del grupo/comunidad
    try {
      let memberIds = [];
      if (groupId) {
        memberIds = (
          await prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } })
        ).map((m) => m.userId);
      } else if (communityId) {
        memberIds = (
          await prisma.communityMember.findMany({ where: { communityId }, select: { userId: true } })
        ).map((m) => m.userId);
      }
      await Promise.all(
        memberIds
          .filter((mid) => mid !== userId)
          .map((mid) =>
            notify(mid, 'SYSTEM', {
              title: 'Nuevo evento',
              body: `${req.user.username || 'Un atleta'} creó el evento "${title}"`,
              payload: { eventId: event.id, groupId: groupId || null, communityId: communityId || null },
              dedupeKey: `event:${event.id}:${mid}`
            })
          )
      );
    } catch (e) {
      console.warn('[events] notify members failed:', e.message);
    }

    res.status(201).json(decorateEvent(event, userId));
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const createGroupEvent = async (req, res) => {
  req.body.groupId = req.params.id;
  return createEvent(req, res);
};

const createCommunityEvent = async (req, res) => {
  req.body.communityId = req.params.id;
  return createEvent(req, res);
};

const updateEvent = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { title, description, location, startsAt, endsAt } = req.body;

    const event = await prisma.clubEvent.findUnique({ where: { id } });
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    if (event.creatorId !== userId && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Sólo el creador puede editar el evento' });
    }

    const updated = await prisma.clubEvent.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(location !== undefined && { location }),
        ...(startsAt !== undefined && { startsAt: new Date(startsAt) }),
        ...(endsAt !== undefined && { endsAt: endsAt ? new Date(endsAt) : null })
      },
      include: eventInclude(userId)
    });

    res.json(decorateEvent(updated, userId));
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const deleteEvent = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const event = await prisma.clubEvent.findUnique({ where: { id } });
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    if (event.creatorId !== userId && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Sólo el creador puede eliminar el evento' });
    }

    await prisma.clubEvent.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const rsvpEvent = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { status = 'GOING' } = req.body;

    if (!RSVP_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status debe ser uno de: ${RSVP_STATUSES.join(', ')}` });
    }

    const event = await prisma.clubEvent.findUnique({ where: { id } });
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    const allowed = await canAccessScope(userId, req.user.role, {
      groupId: event.groupId,
      communityId: event.communityId
    });
    if (!allowed) {
      return res.status(403).json({ error: 'No podés confirmar asistencia a este evento' });
    }

    const rsvp = await prisma.clubEventRsvp.upsert({
      where: { eventId_userId: { eventId: id, userId } },
      create: { eventId: id, userId, status },
      update: { status }
    });

    res.json(rsvp);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  listEvents,
  listGroupEvents,
  listCommunityEvents,
  getEvent,
  createEvent,
  createGroupEvent,
  createCommunityEvent,
  updateEvent,
  deleteEvent,
  rsvpEvent
};
