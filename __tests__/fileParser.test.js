const fileParser = require('../src/services/fileParser.service');

const buf = (contenido) => Buffer.from(contenido, 'utf-8');

const GPX_VALIDO = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Trail Run de prueba</name>
    <trkseg>
      <trkpt lat="-34.6037" lon="-58.3816"><ele>10</ele><time>2026-01-01T10:00:00Z</time></trkpt>
      <trkpt lat="-34.6047" lon="-58.3816"><ele>20</ele><time>2026-01-01T10:05:00Z</time></trkpt>
      <trkpt lat="-34.6057" lon="-58.3816"><ele>15</ele><time>2026-01-01T10:10:00Z</time></trkpt>
      <trkpt lat="-34.6067" lon="-58.3816"><ele>35</ele><time>2026-01-01T10:15:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

/** GPX con pulso en <extensions>, que es donde lo pone cada reloj. */
const gpxConPulso = (prefijo) => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns:${prefijo}="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk>
    <name>Salida con pulsómetro</name>
    <trkseg>
      <trkpt lat="-34.6037" lon="-58.3816"><ele>10</ele><time>2026-01-01T10:00:00Z</time>
        <extensions><${prefijo}:TrackPointExtension><${prefijo}:hr>140</${prefijo}:hr></${prefijo}:TrackPointExtension></extensions>
      </trkpt>
      <trkpt lat="-34.6047" lon="-58.3816"><ele>20</ele><time>2026-01-01T10:05:00Z</time>
        <extensions><${prefijo}:TrackPointExtension><${prefijo}:hr>160</${prefijo}:hr></${prefijo}:TrackPointExtension></extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

/** Header mínimo de un .FIT real: 14 bytes con la firma ".FIT" en 8..11. */
const fitHeaderValido = () => {
  const header = Buffer.alloc(14);
  header.writeUInt8(14, 0);
  header.writeUInt8(0x20, 1);
  header.writeUInt16LE(2140, 2);
  header.writeUInt32LE(0, 4);
  header.write('.FIT', 8, 'ascii');
  return header;
};

const gpxConNombre = (nombre) => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${nombre}</name>
    <trkseg>
      <trkpt lat="-34.6037" lon="-58.3816"><ele>10</ele><time>2026-01-01T10:00:00Z</time></trkpt>
      <trkpt lat="-34.6047" lon="-58.3816"><ele>10</ele><time>2026-01-01T10:05:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const TCX_VALIDO = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>2026-01-01T10:00:00Z</Id>
      <Lap StartTime="2026-01-01T10:00:00Z">
        <TotalTimeSeconds>600</TotalTimeSeconds>
        <DistanceMeters>2000</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2026-01-01T10:00:00Z</Time>
            <Position><LatitudeDegrees>-34.6037</LatitudeDegrees><LongitudeDegrees>-58.3816</LongitudeDegrees></Position>
            <AltitudeMeters>10</AltitudeMeters>
            <HeartRateBpm><Value>140</Value></HeartRateBpm>
          </Trackpoint>
          <Trackpoint>
            <Time>2026-01-01T10:05:00Z</Time>
            <Position><LatitudeDegrees>-34.6047</LatitudeDegrees><LongitudeDegrees>-58.3816</LongitudeDegrees></Position>
            <AltitudeMeters>25</AltitudeMeters>
            <HeartRateBpm><Value>160</Value></HeartRateBpm>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

const TCX_DOS_VUELTAS = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>2026-02-02T08:00:00Z</Id>
      <Notes>Bici por costanera</Notes>
      <Lap StartTime="2026-02-02T08:00:00Z">
        <TotalTimeSeconds>300</TotalTimeSeconds>
        <DistanceMeters>1500</DistanceMeters>
        <Track>
          <Trackpoint><Time>2026-02-02T08:00:00Z</Time>
            <Position><LatitudeDegrees>-34.60</LatitudeDegrees><LongitudeDegrees>-58.38</LongitudeDegrees></Position>
            <AltitudeMeters>5</AltitudeMeters></Trackpoint>
          <Trackpoint><Time>2026-02-02T08:05:00Z</Time>
            <Position><LatitudeDegrees>-34.61</LatitudeDegrees><LongitudeDegrees>-58.38</LongitudeDegrees></Position>
            <AltitudeMeters>25</AltitudeMeters></Trackpoint>
        </Track>
      </Lap>
      <Lap StartTime="2026-02-02T08:05:00Z">
        <TotalTimeSeconds>240</TotalTimeSeconds>
        <DistanceMeters>1000</DistanceMeters>
        <Track>
          <Trackpoint><Time>2026-02-02T08:05:00Z</Time>
            <Position><LatitudeDegrees>-34.61</LatitudeDegrees><LongitudeDegrees>-58.38</LongitudeDegrees></Position>
            <AltitudeMeters>25</AltitudeMeters></Trackpoint>
          <Trackpoint><Time>2026-02-02T08:09:00Z</Time>
            <Position><LatitudeDegrees>-34.62</LatitudeDegrees><LongitudeDegrees>-58.38</LongitudeDegrees></Position>
            <AltitudeMeters>15</AltitudeMeters></Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

describe('parseGpxFile', () => {
  describe('GPX válido', () => {
    let actividad;

    beforeAll(async () => {
      actividad = await fileParser.parseGpxFile(buf(GPX_VALIDO));
    });

    it('toma el nombre del track', () => {
      expect(actividad.name).toBe('Trail Run de prueba');
    });

    it('infiere el tipo de actividad a partir del nombre', () => {
      expect(actividad.type).toBe('TRAIL_RUN');
    });

    it('calcula la distancia en kilómetros a partir de las coordenadas', () => {
      // 3 tramos de 0.001° de latitud ≈ 111 m cada uno
      expect(actividad.distanceKm).toBeCloseTo(0.3336, 4);
    });

    it('acumula solo el desnivel positivo', () => {
      // 10 → 20 (+10), 20 → 15 (ignorado), 15 → 35 (+20)
      expect(actividad.elevationM).toBe(30);
    });

    it('calcula el tiempo en movimiento entre el primer y el último punto', () => {
      expect(actividad.movingTime).toBe(900);
    });

    it('toma la fecha de inicio del primer punto', () => {
      expect(actividad.startDate).toBeInstanceOf(Date);
      expect(actividad.startDate.toISOString()).toBe('2026-01-01T10:00:00.000Z');
    });

    it('codifica el recorrido como polyline', () => {
      expect(typeof actividad.mapPolyline).toBe('string');
      expect(actividad.mapPolyline.length).toBeGreaterThan(0);
    });

    it('registra el origen y el conteo de puntos en rawData', () => {
      expect(actividad.rawData).toMatchObject({
        source: 'gpx',
        pointsCount: 4,
        coordinatesCount: 4,
        minElevation: 10,
        maxElevation: 35,
      });
    });

    it('no genera vueltas porque la actividad no llega al kilómetro', () => {
      expect(actividad.laps).toEqual([]);
    });
  });

  describe('inferencia de tipo desde el nombre del track', () => {
    it.each([
      ['Caminata matutina', 'WALK'],
      ['Salida en bici', 'RIDE'],
      ['Natación en pileta', 'SWIM'],
      ['Trekking al cerro', 'HIKE'],
      ['Morning Run', 'RUN'],
      ['Virtual Ride en rodillo', 'VIRTUAL_RIDE'],
      ['Sesión sin pistas', 'OTHER'],
    ])('un track llamado "%s" se clasifica como %s', async (nombre, tipoEsperado) => {
      const actividad = await fileParser.parseGpxFile(buf(gpxConNombre(nombre)));
      expect(actividad.type).toBe(tipoEsperado);
    });
  });

  describe('GPX malformado', () => {
    it('falla con un error claro cuando el contenido no es XML', async () => {
      await expect(fileParser.parseGpxFile(buf('esto no es un gpx'))).rejects.toThrow(/^GPX parse error:/);
    });

    it('falla con un error claro cuando el XML está truncado', async () => {
      const truncado = '<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="-34.6"';
      await expect(fileParser.parseGpxFile(buf(truncado))).rejects.toThrow(/^GPX parse error:/);
    });

    it('avisa cuando el GPX es válido pero no tiene track', async () => {
      const sinTrack = '<?xml version="1.0"?><gpx version="1.1"></gpx>';
      await expect(fileParser.parseGpxFile(buf(sinTrack))).rejects.toThrow(
        'GPX parse error: No track data found in GPX file'
      );
    });

    it('falla con un error y no explota con un archivo vacío', async () => {
      await expect(fileParser.parseGpxFile(buf(''))).rejects.toThrow(/^GPX parse error:/);
    });

    it('siempre rechaza con una instancia de Error', async () => {
      await expect(fileParser.parseGpxFile(buf('basura'))).rejects.toBeInstanceOf(Error);
    });
  });
});

describe('parseTcxFile', () => {
  describe('TCX válido de una vuelta', () => {
    let actividad;

    beforeAll(async () => {
      actividad = await fileParser.parseTcxFile(buf(TCX_VALIDO));
    });

    it('mapea el atributo Sport al tipo de actividad', () => {
      expect(actividad.type).toBe('RUN');
    });

    it('usa el Id como nombre cuando no hay notas', () => {
      expect(actividad.name).toBe('2026-01-01T10:00:00Z');
    });

    it('toma la distancia declarada en la vuelta', () => {
      expect(actividad.distanceKm).toBe(2);
    });

    it('acumula el desnivel positivo entre trackpoints', () => {
      expect(actividad.elevationM).toBe(15);
    });

    it('usa el tiempo total de las vueltas como tiempo en movimiento', () => {
      expect(actividad.movingTime).toBe(600);
    });

    it('promedia y toma el máximo de las pulsaciones', () => {
      expect(actividad.averageHr).toBe(150);
      expect(actividad.maxHr).toBe(160);
    });

    it('toma la fecha de inicio del primer trackpoint', () => {
      expect(actividad.startDate.toISOString()).toBe('2026-01-01T10:00:00.000Z');
    });

    it('devuelve una vuelta con el ritmo promedio en minutos por kilómetro', () => {
      expect(actividad.laps).toHaveLength(1);
      expect(actividad.laps[0]).toMatchObject({ splitNum: 1, distance: 2, averagePace: 5 });
    });

    it('registra el origen en rawData', () => {
      expect(actividad.rawData).toMatchObject({ source: 'tcx', pointsCount: 2, lapsCount: 1 });
    });
  });

  describe('TCX válido de varias vueltas', () => {
    let actividad;

    beforeAll(async () => {
      actividad = await fileParser.parseTcxFile(buf(TCX_DOS_VUELTAS));
    });

    it('suma la distancia de todas las vueltas', () => {
      expect(actividad.distanceKm).toBe(2.5);
    });

    it('suma el tiempo de todas las vueltas', () => {
      expect(actividad.movingTime).toBe(540);
    });

    it('devuelve una vuelta por cada Lap del archivo', () => {
      expect(actividad.laps).toHaveLength(2);
      expect(actividad.laps.map((l) => l.distance)).toEqual([1.5, 1]);
    });

    it('prefiere las notas al Id como nombre de la actividad', () => {
      expect(actividad.name).toBe('Bici por costanera');
    });

    it('mapea Biking a RIDE', () => {
      expect(actividad.type).toBe('RIDE');
    });

    it('deja las pulsaciones en null cuando el archivo no las trae', () => {
      expect(actividad.averageHr).toBeNull();
      expect(actividad.maxHr).toBeNull();
    });
  });

  describe('TCX con notas privadas', () => {
    it('ignora la nota "Private" de Strava y usa el Id', async () => {
      const tcx = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="Swimming">
        <Id>2026-03-03T07:00:00Z</Id><Notes>Private</Notes>
        <Lap><TotalTimeSeconds>1200</TotalTimeSeconds><DistanceMeters>1000</DistanceMeters><Track>
          <Trackpoint><Time>2026-03-03T07:00:00Z</Time>
            <Position><LatitudeDegrees>-34.60</LatitudeDegrees><LongitudeDegrees>-58.38</LongitudeDegrees></Position></Trackpoint>
          <Trackpoint><Time>2026-03-03T07:20:00Z</Time>
            <Position><LatitudeDegrees>-34.601</LatitudeDegrees><LongitudeDegrees>-58.38</LongitudeDegrees></Position></Trackpoint>
        </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
      const actividad = await fileParser.parseTcxFile(buf(tcx));
      expect(actividad.name).toBe('2026-03-03T07:00:00Z');
      expect(actividad.type).toBe('SWIM');
    });
  });

  describe('TCX malformado', () => {
    it('avisa cuando no hay actividad en el archivo', async () => {
      await expect(fileParser.parseTcxFile(buf('esto no es un tcx'))).rejects.toThrow(
        'TCX parse error: No activity found in TCX file'
      );
    });

    it('avisa cuando el TCX no tiene trackpoints', async () => {
      const sinPuntos = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="Running">
        <Id>x</Id><Lap><TotalTimeSeconds>10</TotalTimeSeconds></Lap>
        </Activity></Activities></TrainingCenterDatabase>`;
      await expect(fileParser.parseTcxFile(buf(sinPuntos))).rejects.toThrow(
        'TCX parse error: No trackpoints found in TCX file'
      );
    });

    it('siempre rechaza con una instancia de Error', async () => {
      await expect(fileParser.parseTcxFile(buf(''))).rejects.toBeInstanceOf(Error);
    });
  });
});

describe('helpers de normalización', () => {
  describe('mapActivityType', () => {
    it.each([
      ['running', 'RUN'],
      ['Trail Running', 'TRAIL_RUN'],
      ['cycling', 'RIDE'],
      ['Lap Swimming', 'SWIM'],
      ['hiking', 'HIKE'],
      ['walking', 'WALK'],
      ['deporte_raro', 'OTHER'],
    ])('mapea "%s" a %s', (sport, esperado) => {
      expect(fileParser.mapActivityType(sport)).toBe(esperado);
    });

    it('mapea a OTHER cuando el deporte viene nulo', () => {
      expect(fileParser.mapActivityType(null)).toBe('OTHER');
      expect(fileParser.mapActivityType(undefined)).toBe('OTHER');
    });
  });

  describe('normalizeDistanceKm', () => {
    it('convierte metros a kilómetros cuando el valor es grande', () => {
      expect(fileParser.normalizeDistanceKm(10000)).toBe(10);
    });

    it('deja el valor tal cual cuando ya parece estar en kilómetros', () => {
      expect(fileParser.normalizeDistanceKm(10)).toBe(10);
    });

    it('devuelve 0 con valores inválidos o negativos', () => {
      expect(fileParser.normalizeDistanceKm(-5)).toBe(0);
      expect(fileParser.normalizeDistanceKm(null)).toBe(0);
      expect(fileParser.normalizeDistanceKm('abc')).toBe(0);
    });
  });

  describe('calculatePace', () => {
    it('devuelve minutos por kilómetro', () => {
      expect(fileParser.calculatePace(1000, 300)).toBe(5);
    });

    it('devuelve 0 cuando falta distancia o tiempo', () => {
      expect(fileParser.calculatePace(0, 300)).toBe(0);
      expect(fileParser.calculatePace(1000, 0)).toBe(0);
    });
  });

  describe('normalizeLatLon', () => {
    it('acepta coordenadas válidas', () => {
      expect(fileParser.normalizeLatLon(-34.6, -58.38)).toEqual([-34.6, -58.38]);
    });

    it('convierte semicírculos FIT a grados', () => {
      const [lat, lon] = fileParser.normalizeLatLon(-412839000, -696190000);
      expect(lat).toBeCloseTo(-34.6, 1);
      expect(lon).toBeCloseTo(-58.35, 1);
    });

    it('descarta el punto nulo (0, 0)', () => {
      expect(fileParser.normalizeLatLon(0, 0)).toBeNull();
    });

    it('descarta valores no numéricos', () => {
      expect(fileParser.normalizeLatLon('-34.6', '-58.38')).toBeNull();
      expect(fileParser.normalizeLatLon(NaN, NaN)).toBeNull();
    });
  });

  describe('pulso en GPX (extensions)', () => {
    it('lee el pulso del namespace gpxtpx', async () => {
      const actividad = await fileParser.parseGpxFile(buf(gpxConPulso('gpxtpx')));
      expect(actividad.averageHr).toBe(150);
      expect(actividad.maxHr).toBe(160);
    });

    it('lee el pulso sin importar el prefijo del namespace', async () => {
      const actividad = await fileParser.parseGpxFile(buf(gpxConPulso('ns3')));
      expect(actividad.averageHr).toBe(150);
      expect(actividad.maxHr).toBe(160);
    });

    it('deja el pulso en null cuando el GPX no trae extensions', async () => {
      const actividad = await fileParser.parseGpxFile(buf(GPX_VALIDO));
      expect(actividad.averageHr).toBeNull();
      expect(actividad.maxHr).toBeNull();
    });
  });

  describe('FIT dañado', () => {
    it('rechaza un archivo que no tiene la firma .FIT', async () => {
      await expect(fileParser.parseFitFile(buf('esto no es un fit'))).rejects.toThrow(
        'FIT parse error: el archivo no parece un .FIT válido'
      );
    });

    it('avisa cuando el archivo está vacío', async () => {
      await expect(fileParser.parseFitFile(Buffer.alloc(0))).rejects.toThrow(
        'FIT parse error: el archivo está vacío o incompleto'
      );
    });

    it('nunca deja el mensaje en "undefined"', async () => {
      await expect(fileParser.parseFitFile(buf('basura'))).rejects.not.toThrow(/undefined/);
    });

    it('marca el fallo como error del archivo, para responder 400 y no 500', async () => {
      await expect(fileParser.parseFitFile(buf('basura'))).rejects.toMatchObject({
        name: 'FileParseError',
        status: 400,
      });
    });

    // Con `force: true` la librería tarda segundos de CPU sincrónicos con basura,
    // y eso bloquea todo el proceso. El header se descarta antes de llegar ahí.
    it('descarta la basura al instante en vez de quemar CPU', async () => {
      const inicio = Date.now();
      await expect(fileParser.parseFitFile(Buffer.alloc(1024 * 1024, 0x41))).rejects.toThrow();
      expect(Date.now() - inicio).toBeLessThan(1000);
    });

    it('deja pasar el header de un .FIT válido', () => {
      expect(() => fileParser.assertLooksLikeFit(fitHeaderValido())).not.toThrow();
    });
  });
});
