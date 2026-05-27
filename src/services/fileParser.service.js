const FitParser = require('fit-file-parser').default;
const gpxParse = require('gpx-parse');
const { promisify } = require('util');

const gpxParseAsync = promisify(gpxParse.parseGpx);

class FileParserService {
  async parseFitFile(buffer) {
    return new Promise((resolve, reject) => {
      const fitParser = new FitParser({
        force: true,
        speedUnit: 'km/h',
        lengthUnit: 'km',
        temperatureUnit: 'celsius',
        elapsedRecordField: true,
        mode: 'both'
      });

      fitParser.parse(buffer, (error, data) => {
        if (error) {
          return reject(new Error(`FIT parse error: ${error.message}`));
        }

        try {
          const activity = this.extractFitData(data);
          resolve(activity);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  extractFitData(data) {
    const session = data.sessions?.[0] || {};
    const records = data.records || [];
    const laps = data.laps || [];

    const activity = {
      name: session.sport || 'Activity',
      type: this.mapActivityType(session.sport || session.sub_sport),
      distanceKm: (session.total_distance || 0) / 1000,
      elevationM: session.total_ascent || 0,
      movingTime: session.total_timer_time || 0,
      startDate: session.start_time || new Date(),
      averageHr: session.avg_heart_rate || null,
      maxHr: session.max_heart_rate || null,
      calories: session.total_calories || null,
      rawData: {
        session,
        recordsCount: records.length,
        lapsCount: laps.length
      },
      laps: this.extractLaps(laps)
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
      const activity = this.extractGpxData(data, points);
      
      return activity;
    } catch (error) {
      throw new Error(`GPX parse error: ${error.message}`);
    }
  }

  extractGpxData(data, points) {
    let totalDistance = 0;
    let totalElevationGain = 0;
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    let heartRates = [];

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

      if (point.hr) {
        heartRates.push(point.hr);
      }

      if (i > 0) {
        totalDistance += this.calculateDistance(
          points[i - 1].lat,
          points[i - 1].lon,
          point.lat,
          point.lon
        );
      }
    }

    const startTime = points[0]?.time || new Date();
    const endTime = points[points.length - 1]?.time || new Date();
    const movingTime = Math.floor((endTime - startTime) / 1000);

    const avgHr = heartRates.length > 0
      ? Math.round(heartRates.reduce((a, b) => a + b, 0) / heartRates.length)
      : null;
    
    const maxHr = heartRates.length > 0 ? Math.max(...heartRates) : null;

    return {
      name: data.tracks[0]?.name || 'GPX Activity',
      type: 'RUN',
      distanceKm: totalDistance / 1000,
      elevationM: totalElevationGain,
      movingTime,
      startDate: startTime,
      averageHr: avgHr,
      maxHr: maxHr,
      calories: null,
      rawData: {
        pointsCount: points.length,
        minElevation,
        maxElevation
      },
      laps: this.generateLapsFromDistance(points, totalDistance)
    };
  }

  async parseTcxFile(buffer) {
    throw new Error('TCX parsing not yet implemented');
  }

  extractLaps(laps) {
    return laps.map((lap, index) => ({
      splitNum: index + 1,
      distance: (lap.total_distance || 0) / 1000,
      elevationGain: lap.total_ascent || 0,
      averagePace: this.calculatePace(lap.total_distance, lap.total_timer_time),
      averageHr: lap.avg_heart_rate || null,
      maxHr: lap.max_heart_rate || null
    }));
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
    let heartRates = [];

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

    const startTime = points[0]?.time;
    const endTime = points[points.length - 1]?.time;
    const timeSeconds = startTime && endTime ? (endTime - startTime) / 1000 : 0;

    return {
      splitNum,
      distance: distance / 1000,
      elevationGain,
      averagePace: this.calculatePace(distance, timeSeconds),
      averageHr: heartRates.length > 0
        ? Math.round(heartRates.reduce((a, b) => a + b, 0) / heartRates.length)
        : null,
      maxHr: heartRates.length > 0 ? Math.max(...heartRates) : null
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
    const mapping = {
      'running': 'RUN',
      'trail_running': 'TRAIL_RUN',
      'cycling': 'RIDE',
      'swimming': 'SWIM',
      'walking': 'WALK',
      'hiking': 'HIKE',
      'virtual_run': 'VIRTUAL_RUN',
      'virtual_ride': 'VIRTUAL_RIDE'
    };

    return mapping[sport?.toLowerCase()] || 'OTHER';
  }
}

module.exports = new FileParserService();
