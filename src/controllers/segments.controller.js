const prisma = require('../lib/prisma');

const haversineMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const parseCoords = (value) => {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) {
    return { lat: Number(value[0]), lng: Number(value[1]) };
  }
  if (typeof value === 'object' && value.lat != null && value.lng != null) {
    return { lat: Number(value.lat), lng: Number(value.lng) };
  }
  return null;
};

/** Decode encoded polyline or JSON coords list into [{lat,lng}] */
const decodeActivityPath = (mapPolyline) => {
  if (!mapPolyline) return [];
  try {
    const polyline = require('@mapbox/polyline');
    return polyline.decode(mapPolyline).map(([lat, lng]) => ({ lat, lng }));
  } catch {
    try {
      const parsed = JSON.parse(mapPolyline);
      if (Array.isArray(parsed)) {
        return parsed
          .map((p) => (Array.isArray(p) ? { lat: p[0], lng: p[1] } : { lat: p.lat, lng: p.lng }))
          .filter((p) => p.lat != null && p.lng != null);
      }
    } catch {
      return [];
    }
  }
  return [];
};

const pathNearPoint = (path, point, thresholdM = 80) => {
  if (!point || path.length === 0) return { near: false, minDist: Infinity, index: -1 };
  let minDist = Infinity;
  let index = -1;
  for (let i = 0; i < path.length; i++) {
    const d = haversineMeters(path[i].lat, path[i].lng, point.lat, point.lng);
    if (d < minDist) {
      minDist = d;
      index = i;
    }
  }
  return { near: minDist <= thresholdM, minDist, index };
};

const getSegments = async (req, res) => {
  try {
    const segments = await prisma.segment.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { leaderboards: true } } }
    });
    res.json(segments);
  } catch (error) {
    console.error('[GET SEGMENTS ERROR]', error);
    res.status(500).json({ error: 'Error al obtener segmentos' });
  }
};

const getSegmentById = async (req, res) => {
  try {
    const segment = await prisma.segment.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { leaderboards: true } } }
    });
    if (!segment) return res.status(404).json({ error: 'Segmento no encontrado' });
    res.json(segment);
  } catch (error) {
    console.error('[GET SEGMENT ERROR]', error);
    res.status(500).json({ error: 'Error al obtener segmento' });
  }
};

const createSegment = async (req, res) => {
  try {
    const { name, description, distanceKm, startLocation, endLocation, startCoords, endCoords, mapPolyline, polyline } =
      req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });

    const segment = await prisma.segment.create({
      data: {
        name: name.trim(),
        description: description || null,
        distanceKm: parseFloat(distanceKm) || 0,
        startCoords: startCoords || startLocation || [],
        endCoords: endCoords || endLocation || [],
        polyline: polyline || mapPolyline || ''
      }
    });

    res.status(201).json(segment);
  } catch (error) {
    console.error('[CREATE SEGMENT ERROR]', error);
    res.status(500).json({ error: 'Error al crear segmento' });
  }
};

/**
 * POST /segments/from-activity
 *
 * El atleta propone un segmento a partir de una de sus actividades con GPS.
 * Hoy crear segmentos era solo admin, así que la tabla quedaba vacía y el
 * matching nunca tenía qué comparar. Acá el recorrido de la actividad se
 * convierte en inicio, fin y polyline listos para el leaderboard.
 */
const createFromActivity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityId, name, description, startIndex, endIndex } = req.body;

    if (!activityId) {
      return res.status(400).json({ error: 'Indicá la actividad de la que querés sacar el segmento.' });
    }
    if (!name?.trim()) {
      return res.status(400).json({ error: 'El segmento necesita un nombre.' });
    }

    const activity = await prisma.activity.findFirst({
      where: { id: activityId, userId },
    });
    if (!activity) {
      return res.status(404).json({ error: 'No encontramos esa actividad.' });
    }
    if (!activity.mapPolyline) {
      return res.status(400).json({
        error: 'Esa actividad no tiene recorrido GPS. Solo se pueden crear segmentos desde actividades con mapa.',
      });
    }

    const path = decodeActivityPath(activity.mapPolyline);
    if (path.length < 2) {
      return res.status(400).json({ error: 'No pudimos leer el recorrido GPS de esa actividad.' });
    }

    // Por defecto usa todo el recorrido; si el móvil manda índices, toma el tramo.
    let from = Number.isInteger(startIndex) ? startIndex : 0;
    let to = Number.isInteger(endIndex) ? endIndex : path.length - 1;
    from = Math.max(0, Math.min(from, path.length - 1));
    to = Math.max(0, Math.min(to, path.length - 1));
    if (to <= from) {
      return res.status(400).json({ error: 'El tramo tiene que tener al menos dos puntos.' });
    }

    const slice = path.slice(from, to + 1);
    let distanceM = 0;
    for (let i = 1; i < slice.length; i++) {
      distanceM += haversineMeters(slice[i - 1].lat, slice[i - 1].lng, slice[i].lat, slice[i].lng);
    }

    // Preferimos re-encodear el tramo: así el matching futuro compara el mismo
    // formato que el resto de segmentos creados por admin.
    let encoded = activity.mapPolyline;
    try {
      const polyline = require('@mapbox/polyline');
      encoded = polyline.encode(slice.map((p) => [p.lat, p.lng]));
    } catch {
      // Si falla el encode, dejamos la polyline original: el matching usa
      // start/end y no necesita la polyline exacta.
    }

    const segment = await prisma.segment.create({
      data: {
        name: name.trim(),
        description:
          description ||
          `Propuesto por un atleta a partir de "${activity.name}".`,
        distanceKm: Number((distanceM / 1000).toFixed(3)),
        startCoords: [slice[0].lat, slice[0].lng],
        endCoords: [slice[slice.length - 1].lat, slice[slice.length - 1].lng],
        polyline: encoded,
      },
    });

    // El creador queda como primer registro del leaderboard con el tiempo del tramo.
    const totalMoving = activity.movingTime || 0;
    const frac = path.length > 1 ? (to - from) / (path.length - 1) : 0;
    const timeSeconds = Math.max(1, Math.round(totalMoving * frac));

    try {
      await prisma.segmentLeaderboard.create({
        data: {
          userId,
          segmentId: segment.id,
          activityId: activity.id,
          timeSeconds,
          date: activity.startDate || new Date(),
        },
      });
    } catch (err) {
      console.warn('[createFromActivity] leaderboard:', err.message);
    }

    res.status(201).json({
      segment,
      timeSeconds,
      message: `Segmento "${segment.name}" creado. Ya está disponible para el resto.`,
    });
  } catch (error) {
    console.error('[CREATE SEGMENT FROM ACTIVITY ERROR]', error);
    res.status(500).json({ error: 'No pudimos crear el segmento. Intentá de nuevo.' });
  }
};

const updateSegment = async (req, res) => {
  try {
    const existing = await prisma.segment.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Segmento no encontrado' });

    const { name, description, distanceKm, startCoords, endCoords, polyline, mapPolyline } = req.body;
    const segment = await prisma.segment.update({
      where: { id: req.params.id },
      data: {
        ...(name != null ? { name: String(name).trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(distanceKm != null ? { distanceKm: parseFloat(distanceKm) } : {}),
        ...(startCoords !== undefined ? { startCoords } : {}),
        ...(endCoords !== undefined ? { endCoords } : {}),
        ...(polyline != null || mapPolyline != null
          ? { polyline: polyline || mapPolyline || existing.polyline }
          : {})
      }
    });
    res.json(segment);
  } catch (error) {
    console.error('[UPDATE SEGMENT ERROR]', error);
    res.status(500).json({ error: 'Error al actualizar segmento' });
  }
};

const deleteSegment = async (req, res) => {
  try {
    await prisma.segment.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (error) {
    console.error('[DELETE SEGMENT ERROR]', error);
    res.status(500).json({ error: 'Error al eliminar segmento' });
  }
};

const logLeaderboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { activityId, timeSeconds } = req.body;

    if (!activityId || timeSeconds == null) {
      return res.status(400).json({ error: 'activityId y timeSeconds son obligatorios' });
    }

    const entry = await prisma.segmentLeaderboard.create({
      data: {
        userId,
        segmentId: id,
        activityId,
        timeSeconds: parseInt(timeSeconds, 10),
        date: new Date()
      }
    });

    res.status(201).json(entry);
  } catch (error) {
    console.error('[LOG LEADERBOARD ERROR]', error);
    res.status(500).json({ error: 'Error al registrar tiempo en segmento' });
  }
};

const getLeaderboard = async (req, res) => {
  try {
    const { id } = req.params;

    const rankings = await prisma.segmentLeaderboard.findMany({
      where: { segmentId: id },
      orderBy: { timeSeconds: 'asc' },
      take: 100,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
            avatarUrl: true
          }
        }
      }
    });

    res.json(rankings);
  } catch (error) {
    console.error('[GET LEADERBOARD ERROR]', error);
    res.status(500).json({ error: 'Error al obtener ranking de segmento' });
  }
};

/**
 * Match activity GPS path against known segments.
 * POST body: { activityId }
 */
const matchSegments = async (req, res) => {
  try {
    const userId = req.user.id;
    const { activityId } = req.body;
    if (!activityId) return res.status(400).json({ error: 'activityId requerido' });

    const activity = await prisma.activity.findFirst({
      where: { id: activityId, userId }
    });
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });
    if (!activity.mapPolyline) {
      return res.json({ matches: [], message: 'La actividad no tiene polyline GPS' });
    }

    const path = decodeActivityPath(activity.mapPolyline);
    if (path.length < 2) {
      return res.json({ matches: [], message: 'No se pudo decodificar el recorrido' });
    }

    const segments = await prisma.segment.findMany();
    const matches = [];

    for (const seg of segments) {
      const start = parseCoords(seg.startCoords);
      const end = parseCoords(seg.endCoords);
      if (!start || !end) continue;

      const nearStart = pathNearPoint(path, start, 100);
      const nearEnd = pathNearPoint(path, end, 100);
      if (!nearStart.near || !nearEnd.near) continue;
      if (nearEnd.index <= nearStart.index) continue;

      const slice = path.slice(nearStart.index, nearEnd.index + 1);
      const totalMoving = activity.movingTime || 0;
      const frac = path.length > 1 ? (nearEnd.index - nearStart.index) / (path.length - 1) : 0;
      const timeSeconds = Math.max(1, Math.round(totalMoving * frac));

      let entry = null;
      try {
        entry = await prisma.segmentLeaderboard.create({
          data: {
            userId,
            segmentId: seg.id,
            activityId: activity.id,
            timeSeconds,
            date: activity.startDate || new Date()
          }
        });
      } catch (err) {
        // still report match even if leaderboard insert fails (e.g. duplicate)
        console.warn('[matchSegments] leaderboard insert:', err.message);
      }

      matches.push({
        segment: {
          id: seg.id,
          name: seg.name,
          distanceKm: seg.distanceKm
        },
        timeSeconds,
        entryId: entry?.id || null
      });
    }

    res.json({ matches, count: matches.length });
  } catch (error) {
    console.error('[MATCH SEGMENTS ERROR]', error);
    res.status(500).json({ error: 'Error al evaluar segmentos' });
  }
};

module.exports = {
  getSegments,
  getSegmentById,
  createSegment,
  createFromActivity,
  updateSegment,
  deleteSegment,
  logLeaderboard,
  getLeaderboard,
  matchSegments
};
