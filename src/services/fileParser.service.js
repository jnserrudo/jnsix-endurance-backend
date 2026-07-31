const FitParser = require('fit-file-parser').default;
const gpxParse = require('gpx-parse');
const { XMLParser } = require('fast-xml-parser');
const polyline = require('@mapbox/polyline');
const { promisify } = require('util');

const gpxParseAsync = promisify(gpxParse.parseGpx);

/**
 * Archivo inválido del usuario, no falla del servidor: el controlador lo
 * traduce a 400 en vez de a un 500 genérico.
 */
class FileParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FileParseError';
    this.status = 400;
  }
}

/**
 * Busca el pulso dentro de las <extensions> de un trackpoint GPX.
 * El prefijo de namespace cambia según el reloj (`gpxtpx:hr`, `ns3:hr`, `hr`),
 * así que se compara solo el nombre local y se recorre en profundidad.
 */
function findHrInExtensions(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;

  for (const [key, value] of Object.entries(node)) {
    const localName = key.includes(':') ? key.split(':').pop() : key;
    if (localName.toLowerCase() === 'hr') {
      const bpm = Number(value);
      if (Number.isFinite(bpm) && bpm > 0) return Math.round(bpm);
    }
    if (value && typeof value === 'object') {
      const nested = findHrInExtensions(value, depth + 1);
      if (nested != null) return nested;
    }
  }
  return null;
}

/** FIT sport enums (Garmin/Coros) → ActivityType */
const FIT_SPORT_NUM = {
  0: 'OTHER', // generic
  1: 'RUN',
  2: 'RIDE',
  5: 'SWIM',
  11: 'WALK',
  17: 'HIKE',
  45: 'TRAIL_RUN', // some devices
};

class FileParserService {
  /**
   * Todo .FIT arranca con un header de 12 o 14 bytes cuyos bytes 8..11 son la
   * firma ASCII ".FIT". Validarlo acá es clave: con `force: true` la librería
   * intenta interpretar cualquier basura y se come varios segundos de CPU
   * *sincrónicos* (16 s con 1 MB de relleno), bloqueando todo el proceso.
   */
  assertLooksLikeFit(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 14) {
      throw new FileParseError('FIT parse error: el archivo está vacío o incompleto');
    }

    const headerSize = buffer.readUInt8(0);
    const signature = buffer.toString('ascii', 8, 12);
    if ((headerSize !== 12 && headerSize !== 14) || signature !== '.FIT') {
      throw new FileParseError('FIT parse error: el archivo no parece un .FIT válido');
    }
  }

  async parseFitFile(buffer) {
    this.assertLooksLikeFit(buffer);

    return new Promise((resolve, reject) => {
      const fitParser = new FitParser({
        force: true,
        speedUnit: 'km/h',
        lengthUnit: 'm', // metros: normalizamos nosotros (evita dobles conversiones)
        temperatureUnit: 'celsius',
        elapsedRecordField: true,
        mode: 'both',
      });

      fitParser.parse(buffer, (error, data) => {
        if (error) {
          // La librería a veces rechaza con un string suelto, no con un Error:
          // sin esto el usuario terminaba viendo "FIT parse error: undefined".
          const detalle = typeof error === 'string' ? error : error?.message;
          return reject(
            new FileParseError(
              `FIT parse error: ${detalle || 'no pudimos leer el contenido del archivo'}`
            )
          );
        }

        try {
          resolve(this.extractFitData(data));
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  toTimestampMs(value) {
    if (value == null) return null;
    if (value instanceof Date) {
      const t = value.getTime();
      return Number.isFinite(t) ? t : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      // epoch seconds vs ms
      return value < 1e12 ? value * 1000 : value;
    }
    const d = new Date(value);
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  }

  normalizeLatLon(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    let la = lat;
    let lo = lon;
    // Semicírculos FIT sin convertir
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) {
      la = (la * 180) / 2147483648;
      lo = (lo * 180) / 2147483648;
    }
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
    if (la === 0 && lo === 0) return null;
    return [la, lo];
  }

  /**
   * Distancia en km. fit-file-parser con lengthUnit m → metros.
   * Si algún archivo ya viene en km (< ~500 y parece km), no dividir.
   */
  normalizeDistanceKm(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    // > 500 suele ser metros (5 km = 5000 m). Valores chicos raros en km reales.
    if (n > 500) return n / 1000;
    return n;
  }

  movingTimeFromRecords(records) {
    if (!Array.isArray(records) || records.length < 2) return 0;
    const t0 = this.toTimestampMs(records[0].timestamp);
    const t1 = this.toTimestampMs(records[records.length - 1].timestamp);
    if (t0 == null || t1 == null || t1 <= t0) return 0;
    return Math.max(0, Math.round((t1 - t0) / 1000));
  }

  /**
   * Elige un movingTime razonable (segundos).
   * Prioriza total_timer_time; si es absurdo vs GPS/distancia, usa records.
   */
  resolveMovingTimeSec(session, records, distanceKm) {
    let timer = Number(session.total_timer_time);
    let elapsed = Number(session.total_elapsed_time);
    if (!Number.isFinite(timer) || timer < 0) timer = 0;
    if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;

    // Algunos firmwares entregan milisegundos
    if (timer > 48 * 3600 && timer / 1000 <= 48 * 3600) timer = Math.round(timer / 1000);
    if (elapsed > 48 * 3600 && elapsed / 1000 <= 48 * 3600) elapsed = Math.round(elapsed / 1000);

    timer = Math.round(timer);
    elapsed = Math.round(elapsed);

    const fromRecords = this.movingTimeFromRecords(records);
    let chosen = timer || elapsed || fromRecords || 0;

    if (distanceKm > 0.2 && chosen > 0) {
      const speedKmh = distanceKm / (chosen / 3600);
      // < 0.8 km/h o > 80 km/h en actividad con GPS → sospechoso
      const absurd = speedKmh < 0.8 || speedKmh > 80;
      if (absurd && fromRecords > 60) {
        const altSpeed = distanceKm / (fromRecords / 3600);
        if (altSpeed >= 0.8 && altSpeed <= 80) {
          chosen = fromRecords;
        } else if (elapsed > 0 && elapsed !== timer) {
          const elSpeed = distanceKm / (elapsed / 3600);
          if (elSpeed >= 0.8 && elSpeed <= 80) chosen = elapsed;
        }
      }
    } else if ((!chosen || chosen < 30) && fromRecords > chosen) {
      chosen = fromRecords;
    }

    // Cap duro 36h
    if (chosen > 36 * 3600) chosen = fromRecords || Math.min(chosen, 36 * 3600);
    return Math.max(0, chosen);
  }

  resolveStartDate(session, records) {
    const fromSession = this.toTimestampMs(session.start_time);
    if (fromSession) return new Date(fromSession);
    const fromRecord = records[0] ? this.toTimestampMs(records[0].timestamp) : null;
    if (fromRecord) return new Date(fromRecord);
    return new Date();
  }

  resolveFitSport(session = {}, data = {}) {
    const rawCandidates = [
      session.sport,
      session.sub_sport,
      session.sport_profile_name,
      data.activity?.sport,
      data.sports?.[0]?.sport,
    ];

    for (const raw of rawCandidates) {
      if (raw == null || raw === '') continue;
      if (typeof raw === 'number' && FIT_SPORT_NUM[raw]) {
        return FIT_SPORT_NUM[raw];
      }
      const mapped = this.mapActivityType(raw);
      if (mapped !== 'OTHER') return mapped;
      const inferred = this.inferTypeFromName(String(raw));
      if (inferred !== 'OTHER') return inferred;
    }

    // Coros a veces deja sport=generic y el nombre sí dice Run/Trail
    const nameGuess = this.inferTypeFromName(
      session.sport_profile_name || session.name || data.activity?.type || ''
    );
    return nameGuess;
  }

  extractFitData(data) {
    const session = data.sessions?.[0] || {};
    const records = data.records || [];
    const laps = data.laps || [];

    const distanceKm = this.normalizeDistanceKm(session.total_distance);
    const movingTime = this.resolveMovingTimeSec(session, records, distanceKm);
    const type = this.resolveFitSport(session, data);
    const startDate = this.resolveStartDate(session, records);
    const coordinates = this.downsampleCoordinates(records);

    const profileName =
      session.sport_profile_name ||
      session.name ||
      (typeof session.sport === 'string' ? session.sport : null) ||
      'Actividad';

    const activity = {
      name: String(profileName).replace(/_/g, ' '),
      type,
      distanceKm,
      elevationM: Number(session.total_ascent) || 0,
      movingTime,
      startDate,
      averageHr: session.avg_heart_rate ? Math.round(Number(session.avg_heart_rate)) : null,
      maxHr: session.max_heart_rate ? Math.round(Number(session.max_heart_rate)) : null,
      calories: session.total_calories ? Math.round(Number(session.total_calories)) : null,
      mapPolyline: coordinates.length > 1 ? polyline.encode(coordinates) : null,
      rawData: {
        source: 'fit',
        sportRaw: session.sport,
        subSportRaw: session.sub_sport,
        total_timer_time: session.total_timer_time,
        total_elapsed_time: session.total_elapsed_time,
        recordsCount: records.length,
        lapsCount: laps.length,
        coordinatesCount: coordinates.length,
      },
      laps: this.extractLaps(laps),
    };

    return activity;
  }

  async parseGpxFile(buffer) {
    try {
      const gpxString = buffer.toString('utf-8');
      const data = await gpxParseAsync(gpxString);

      const track = data.tracks?.[0];
      if (!track || !track.segments || track.segments.length === 0) {
        throw new Error('No track data found in GPX file');
      }

      const points = track.segments[0];
      return this.extractGpxData(data, points, this.extractGpxHeartRates(gpxString));
    } catch (error) {
      const detalle = typeof error === 'string' ? error : error?.message;
      throw new FileParseError(`GPX parse error: ${detalle || 'archivo ilegible'}`);
    }
  }

  /**
   * `gpx-parse` descarta las <extensions>, así que el pulso se lee aparte del
   * XML crudo y se aparea por posición con los trackpoints del primer segmento.
   * Devuelve [] si el archivo no trae pulso: nunca hace fallar el import.
   */
  extractGpxHeartRates(gpxString) {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        trimValues: true,
      });
      const xml = parser.parse(gpxString);

      let trk = xml?.gpx?.trk;
      if (Array.isArray(trk)) trk = trk[0];
      let seg = trk?.trkseg;
      if (Array.isArray(seg)) seg = seg[0];
      let trkpts = seg?.trkpt;
      if (!trkpts) return [];
      if (!Array.isArray(trkpts)) trkpts = [trkpts];

      return trkpts.map((pt) => findHrInExtensions(pt?.extensions));
    } catch {
      return [];
    }
  }

  extractGpxData(data, points, hrByIndex = []) {
    let totalDistance = 0;
    let totalElevationGain = 0;
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    const heartRates = [];

    for (let i = 0; i < points.length; i++) {
      const point = points[i];

      if (point.elevation) {
        if (point.elevation < minElevation) minElevation = point.elevation;
        if (point.elevation > maxElevation) maxElevation = point.elevation;

        if (i > 0 && points[i - 1].elevation) {
          const elevDiff = point.elevation - points[i - 1].elevation;
          if (elevDiff > 0) totalElevationGain += elevDiff;
        }
      }

      const hr = point.hr ?? hrByIndex[i];
      if (hr) heartRates.push(hr);

      if (i > 0) {
        totalDistance += this.calculateDistance(
          points[i - 1].lat,
          points[i - 1].lon,
          point.lat,
          point.lon
        );
      }
    }

    const startMs = this.toTimestampMs(points[0]?.time);
    const endMs = this.toTimestampMs(points[points.length - 1]?.time);
    const movingTime =
      startMs != null && endMs != null && endMs > startMs
        ? Math.floor((endMs - startMs) / 1000)
        : 0;

    const avgHr =
      heartRates.length > 0
        ? Math.round(heartRates.reduce((a, b) => a + b, 0) / heartRates.length)
        : null;
    const maxHr = heartRates.length > 0 ? Math.max(...heartRates) : null;

    const coordinates = this.downsampleCoordinates(points);
    const gpxName = data.tracks[0]?.name || 'Actividad GPX';

    return {
      name: gpxName,
      type: this.inferTypeFromName(gpxName),
      distanceKm: totalDistance / 1000,
      elevationM: totalElevationGain,
      movingTime,
      startDate: startMs ? new Date(startMs) : new Date(),
      averageHr: avgHr,
      maxHr: maxHr,
      calories: null,
      mapPolyline: coordinates.length > 1 ? polyline.encode(coordinates) : null,
      rawData: {
        source: 'gpx',
        pointsCount: points.length,
        minElevation,
        maxElevation,
        coordinatesCount: coordinates.length,
      },
      laps: this.generateLapsFromDistance(points, totalDistance),
    };
  }

  async parseTcxFile(buffer) {
    try {
      const tcxString = buffer.toString('utf-8');
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseAttributeValue: false,
        trimValues: true,
      });
      const xml = parser.parse(tcxString);

      let activityNode = xml.TrainingCenterDatabase?.Activities?.Activity;
      if (Array.isArray(activityNode)) activityNode = activityNode[0];
      if (!activityNode) throw new Error('No activity found in TCX file');

      const sport = activityNode['@_Sport'] || 'Other';
      const notes = typeof activityNode.Notes === 'string' ? activityNode.Notes.trim() : '';
      const name =
        (notes && !/^private$/i.test(notes) ? notes : null) ||
        (typeof activityNode.Id === 'string' ? activityNode.Id : null) ||
        `${sport} Activity`;

      const allPoints = [];
      const tcxLaps = [];
      let totalDistance = 0;
      let totalTimeFromLaps = 0;

      const lapNodes = Array.isArray(activityNode.Lap)
        ? activityNode.Lap
        : [activityNode.Lap].filter(Boolean);

      for (const lapNode of lapNodes) {
        const lapDistanceMeters = parseFloat(lapNode.DistanceMeters) || 0;
        const lapTimeSeconds = parseFloat(lapNode.TotalTimeSeconds) || 0;
        totalTimeFromLaps += lapTimeSeconds;
        const lapTrack = lapNode.Track;
        const trackpoints = lapTrack?.Trackpoint
          ? Array.isArray(lapTrack.Trackpoint)
            ? lapTrack.Trackpoint
            : [lapTrack.Trackpoint]
          : [];

        const points = [];
        for (const tp of trackpoints) {
          const lat =
            tp.Position?.LatitudeDegrees !== undefined
              ? parseFloat(tp.Position.LatitudeDegrees)
              : null;
          const lon =
            tp.Position?.LongitudeDegrees !== undefined
              ? parseFloat(tp.Position.LongitudeDegrees)
              : null;
          if (lat === null || lon === null) continue;

          const elevation =
            tp.AltitudeMeters !== undefined ? parseFloat(tp.AltitudeMeters) : null;
          const time = tp.Time ? new Date(tp.Time) : null;
          const hr =
            tp.HeartRateBpm?.Value !== undefined
              ? parseInt(tp.HeartRateBpm.Value, 10)
              : null;

          points.push({ lat, lon, elevation, time, hr });
        }

        allPoints.push(...points);
        tcxLaps.push({
          distance: lapDistanceMeters / 1000,
          timeSeconds: lapTimeSeconds,
          points,
        });

        totalDistance +=
          lapDistanceMeters > 0 ? lapDistanceMeters : this.calculatePointsDistance(points);
      }

      if (allPoints.length === 0) throw new Error('No trackpoints found in TCX file');

      const startMs = this.toTimestampMs(allPoints[0]?.time);
      const endMs = this.toTimestampMs(allPoints[allPoints.length - 1]?.time);
      const fromPoints =
        startMs != null && endMs != null && endMs > startMs
          ? Math.floor((endMs - startMs) / 1000)
          : 0;
      const movingTime = totalTimeFromLaps > 0 ? Math.round(totalTimeFromLaps) : fromPoints;

      const heartRates = allPoints
        .filter((p) => p.hr !== null && !isNaN(p.hr))
        .map((p) => p.hr);

      const avgHr =
        heartRates.length > 0
          ? Math.round(heartRates.reduce((a, b) => a + b, 0) / heartRates.length)
          : null;
      const maxHr = heartRates.length > 0 ? Math.max(...heartRates) : null;

      let totalElevationGain = 0;
      for (let i = 1; i < allPoints.length; i++) {
        const prev = allPoints[i - 1];
        const curr = allPoints[i];
        if (prev.elevation !== null && curr.elevation !== null) {
          const diff = curr.elevation - prev.elevation;
          if (diff > 0) totalElevationGain += diff;
        }
      }

      const coordinates = this.downsampleCoordinates(allPoints);

      return {
        name: String(name).slice(0, 120),
        type: this.mapActivityType(sport),
        distanceKm: totalDistance / 1000,
        elevationM: totalElevationGain,
        movingTime,
        startDate: startMs ? new Date(startMs) : new Date(),
        averageHr: avgHr,
        maxHr: maxHr,
        calories: null,
        mapPolyline: coordinates.length > 1 ? polyline.encode(coordinates) : null,
        rawData: {
          source: 'tcx',
          pointsCount: allPoints.length,
          lapsCount: tcxLaps.length,
          coordinatesCount: coordinates.length,
        },
        laps: tcxLaps.map((lap, index) => ({
          splitNum: index + 1,
          distance: lap.distance,
          elevationGain: 0,
          averagePace: this.calculatePace(lap.distance * 1000, lap.timeSeconds),
          averageHr: null,
          maxHr: null,
        })),
      };
    } catch (error) {
      const detalle = typeof error === 'string' ? error : error?.message;
      throw new FileParseError(`TCX parse error: ${detalle || 'archivo ilegible'}`);
    }
  }

  calculatePointsDistance(points) {
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      distance += this.calculateDistance(
        points[i - 1].lat,
        points[i - 1].lon,
        points[i].lat,
        points[i].lon
      );
    }
    return distance;
  }

  extractLaps(laps) {
    return (laps || []).map((lap, index) => {
      // lengthUnit: 'm' → total_distance en metros
      const distKm = (Number(lap.total_distance) || 0) / 1000;
      let timeSec = Number(lap.total_timer_time) || 0;
      if (timeSec > 48 * 3600 && timeSec / 1000 <= 48 * 3600) {
        timeSec = Math.round(timeSec / 1000);
      }
      timeSec = Math.round(timeSec);
      return {
        splitNum: index + 1,
        distance: distKm,
        elevationGain: Number(lap.total_ascent) || 0,
        averagePace: this.calculatePace(distKm * 1000, timeSec),
        averageHr: lap.avg_heart_rate ? Math.round(Number(lap.avg_heart_rate)) : null,
        maxHr: lap.max_heart_rate ? Math.round(Number(lap.max_heart_rate)) : null,
      };
    });
  }

  generateLapsFromDistance(points, totalDistance) {
    const laps = [];
    const kmInterval = 1000;
    let currentKm = 1;
    let lapStartIndex = 0;
    let accumulatedDistance = 0;

    for (let i = 1; i < points.length; i++) {
      const segmentDistance = this.calculateDistance(
        points[i - 1].lat,
        points[i - 1].lon,
        points[i].lat,
        points[i].lon
      );

      accumulatedDistance += segmentDistance;

      if (accumulatedDistance >= currentKm * kmInterval) {
        const lapPoints = points.slice(lapStartIndex, i + 1);
        const lap = this.calculateLapMetrics(lapPoints, currentKm);
        laps.push(lap);

        lapStartIndex = i;
        currentKm++;
      }
    }

    return laps;
  }

  calculateLapMetrics(points, splitNum) {
    let distance = 0;
    let elevationGain = 0;
    const heartRates = [];

    for (let i = 1; i < points.length; i++) {
      distance += this.calculateDistance(
        points[i - 1].lat,
        points[i - 1].lon,
        points[i].lat,
        points[i].lon
      );

      if (points[i].elevation && points[i - 1].elevation) {
        const elevDiff = points[i].elevation - points[i - 1].elevation;
        if (elevDiff > 0) elevationGain += elevDiff;
      }

      if (points[i].hr) heartRates.push(points[i].hr);
    }

    const startMs = this.toTimestampMs(points[0]?.time);
    const endMs = this.toTimestampMs(points[points.length - 1]?.time);
    const timeSeconds =
      startMs != null && endMs != null && endMs > startMs
        ? Math.round((endMs - startMs) / 1000)
        : 0;

    return {
      splitNum,
      distance: distance / 1000,
      elevationGain,
      averagePace: this.calculatePace(distance, timeSeconds),
      averageHr:
        heartRates.length > 0
          ? Math.round(heartRates.reduce((a, b) => a + b, 0) / heartRates.length)
          : null,
      maxHr: heartRates.length > 0 ? Math.max(...heartRates) : null,
    };
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(degrees) {
    return degrees * (Math.PI / 180);
  }

  calculatePace(distanceMeters, timeSeconds) {
    if (!distanceMeters || !timeSeconds) return 0;
    const distanceKm = distanceMeters / 1000;
    const timeMinutes = timeSeconds / 60;
    return timeMinutes / distanceKm;
  }

  mapActivityType(sport) {
    if (sport == null) return 'OTHER';
    if (typeof sport === 'number' && FIT_SPORT_NUM[sport]) return FIT_SPORT_NUM[sport];

    const key = String(sport).toLowerCase().trim().replace(/\s+/g, '_');
    const mapping = {
      running: 'RUN',
      run: 'RUN',
      road_running: 'RUN',
      trail_running: 'TRAIL_RUN',
      trail: 'TRAIL_RUN',
      trail_run: 'TRAIL_RUN',
      cycling: 'RIDE',
      cycle: 'RIDE',
      bike: 'RIDE',
      biking: 'RIDE',
      road_biking: 'RIDE',
      mountain_biking: 'RIDE',
      swimming: 'SWIM',
      swim: 'SWIM',
      lap_swimming: 'SWIM',
      open_water_swimming: 'SWIM',
      walking: 'WALK',
      walk: 'WALK',
      hiking: 'HIKE',
      hike: 'HIKE',
      virtual_run: 'VIRTUAL_RUN',
      virtual_ride: 'VIRTUAL_RIDE',
      treadmill: 'RUN',
      indoor_running: 'RUN',
      cardio: 'OTHER',
      generic: 'OTHER',
      training: 'OTHER',
      strength_training: 'OTHER',
    };

    return mapping[key] || 'OTHER';
  }

  inferTypeFromName(name) {
    const normalized = (name || '').toLowerCase();

    if (normalized.includes('virtual ride') || normalized.includes('virtualride')) return 'VIRTUAL_RIDE';
    if (normalized.includes('virtual run') || normalized.includes('virtualrun')) return 'VIRTUAL_RUN';
    if (normalized.includes('trail')) return 'TRAIL_RUN';
    if (
      normalized.includes('bike') ||
      normalized.includes('ride') ||
      normalized.includes('cycling') ||
      normalized.includes('bicicleta') ||
      normalized.includes('bici')
    ) {
      return 'RIDE';
    }
    if (normalized.includes('swim') || normalized.includes('natación') || normalized.includes('natacion')) {
      return 'SWIM';
    }
    if (normalized.includes('walk') || normalized.includes('caminata')) return 'WALK';
    if (normalized.includes('hike') || normalized.includes('trekking') || normalized.includes('senderismo')) {
      return 'HIKE';
    }
    if (
      normalized.includes('run') ||
      normalized.includes('corrida') ||
      normalized.includes('running') ||
      normalized.includes('correr')
    ) {
      return 'RUN';
    }

    return 'OTHER';
  }

  downsampleCoordinates(points) {
    const maxMapPoints = 300;
    if (!points || points.length === 0) return [];

    const step = Math.max(1, Math.floor(points.length / maxMapPoints));
    const coordinates = [];

    const pushPoint = (p) => {
      if (!p) return;
      const lat = p.lat ?? p.latitude ?? p.position_lat;
      const lon = p.lon ?? p.longitude ?? p.position_long ?? p.position_lng;
      const pair = this.normalizeLatLon(lat, lon);
      if (pair) coordinates.push(pair);
    };

    for (let i = 0; i < points.length; i += step) {
      pushPoint(points[i]);
    }

    if (points.length > 1 && (points.length - 1) % step !== 0) {
      pushPoint(points[points.length - 1]);
    }

    return coordinates;
  }
}

module.exports = new FileParserService();
module.exports.FileParseError = FileParseError;
