const fs = require('fs');
const path = require('path');
const aiService = require('./ai.service');
const prisma = require('../lib/prisma');

const DAILY_OCR_LIMIT = Number(process.env.OCR_DAILY_LIMIT || 10);
const LOW_CONFIDENCE = 0.55;

const ALLOWED_TYPES = new Set([
  'RUN',
  'TRAIL_RUN',
  'RIDE',
  'VIRTUAL_RUN',
  'VIRTUAL_RIDE',
  'SWIM',
  'HIKE',
  'WALK',
  'OTHER',
]);

const TYPE_ALIASES = {
  run: 'RUN',
  running: 'RUN',
  correr: 'RUN',
  carrera: 'RUN',
  jog: 'RUN',
  trail: 'TRAIL_RUN',
  trail_run: 'TRAIL_RUN',
  trailrun: 'TRAIL_RUN',
  ride: 'RIDE',
  bike: 'RIDE',
  cycling: 'RIDE',
  bici: 'RIDE',
  bicycle: 'RIDE',
  virtual_ride: 'VIRTUAL_RIDE',
  zwift: 'VIRTUAL_RIDE',
  virtual_run: 'VIRTUAL_RUN',
  swim: 'SWIM',
  swimming: 'SWIM',
  natacion: 'SWIM',
  hike: 'HIKE',
  hiking: 'HIKE',
  walk: 'WALK',
  walking: 'WALK',
  fuerza: 'OTHER',
  strength: 'OTHER',
  gym: 'OTHER',
  workout: 'OTHER',
  other: 'OTHER',
};

const SOURCE_APPS = new Set(['strava', 'garmin', 'coros', 'apple', 'suunto', 'polar', 'other']);

function stripJsonFence(raw) {
  const text = String(raw || '').trim();
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
}

function toNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value).trim().replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse moving time from seconds, "mm:ss", "h:mm:ss", or "12 min". */
function parseMovingTimeSec(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw);
  const s = String(raw).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));

  const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  }
  const ms = s.match(/^(\d+):(\d{1,2})$/);
  if (ms) {
    return Number(ms[1]) * 60 + Number(ms[2]);
  }
  const minMatch = s.match(/([\d.]+)\s*min/);
  if (minMatch) return Math.round(Number(minMatch[1]) * 60);
  const hourMatch = s.match(/([\d.]+)\s*h/);
  if (hourMatch) return Math.round(Number(hourMatch[1]) * 3600);
  return null;
}

function mapActivityType(raw) {
  if (!raw) return 'OTHER';
  const upper = String(raw).trim().toUpperCase().replace(/\s+/g, '_');
  if (ALLOWED_TYPES.has(upper)) return upper;
  const alias = TYPE_ALIASES[String(raw).trim().toLowerCase().replace(/\s+/g, '_')];
  return alias || 'OTHER';
}

function normalizeDistanceKm(distanceKm, distanceMiles) {
  let km = toNumber(distanceKm);
  const mi = toNumber(distanceMiles);
  if (km == null && mi != null) km = mi * 1.60934;
  if (km == null) return null;
  // Heurística: valores típicos de milas mal etiquetados como km (ej. 6.2 "km" de 10k)
  return Math.round(km * 1000) / 1000;
}

function normalizeElevationM(elevationM, elevationFt) {
  let m = toNumber(elevationM);
  const ft = toNumber(elevationFt);
  if (m == null && ft != null) m = ft * 0.3048;
  if (m == null) return null;
  return Math.round(m);
}

function normalizePaceMinPerKm(pace, distanceKm, movingTimeSec) {
  let p = toNumber(pace);
  if (p == null && typeof pace === 'string') {
    const m = String(pace).trim().match(/^(\d+):(\d{1,2})/);
    if (m) p = Number(m[1]) + Number(m[2]) / 60;
  }
  if (p == null && distanceKm > 0 && movingTimeSec > 0) {
    p = movingTimeSec / 60 / distanceKm;
  }
  if (p == null) return null;
  return Math.round(p * 100) / 100;
}

function normalizeStartDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  // Evitar fechas futuras absurdas (> 2 días)
  const max = Date.now() + 2 * 24 * 60 * 60 * 1000;
  if (d.getTime() > max) return null;
  return d.toISOString();
}

function buildPrompt(sourceHint) {
  const hint = sourceHint && SOURCE_APPS.has(sourceHint) ? sourceHint : 'unknown';
  return `Analizá esta captura de pantalla de una actividad deportiva (posible app: ${hint}: Strava, Garmin, Coros, Apple Fitness, Suunto, Polar u otra).

Extraé SOLO datos visibles. No inventes GPS ni splits. Si un dato no aparece, usá null.

Respondé SOLO este JSON:
{
  "name": string|null,
  "type": "RUN"|"TRAIL_RUN"|"RIDE"|"VIRTUAL_RUN"|"VIRTUAL_RIDE"|"SWIM"|"HIKE"|"WALK"|"OTHER"|null,
  "distanceKm": number|null,
  "distanceMiles": number|null,
  "elevationM": number|null,
  "elevationFt": number|null,
  "movingTimeSec": number|null,
  "movingTimeText": string|null,
  "startDate": string|null,
  "averageHr": number|null,
  "maxHr": number|null,
  "calories": number|null,
  "paceMinPerKm": number|null,
  "paceText": string|null,
  "sourceApp": "strava"|"garmin"|"coros"|"apple"|"suunto"|"polar"|"other",
  "confidence": number,
  "fieldConfidence": {
    "name": number,
    "type": number,
    "distanceKm": number,
    "elevationM": number,
    "movingTimeSec": number,
    "startDate": number,
    "averageHr": number,
    "maxHr": number,
    "calories": number
  },
  "warnings": string[],
  "rawTextSummary": string
}

Reglas:
- distanceKm en kilómetros; si la captura está en millas, llená distanceMiles y distanceKm convertido.
- movingTimeSec en segundos totales; también podés poner movingTimeText tipo "45:12".
- confidence y fieldConfidence entre 0 y 1.
- warnings en español breve (ej. "fecha no visible").
- sourceApp según logos/UI visibles.`;
}

function validateAndNormalize(parsed) {
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.map((w) => String(w)).filter(Boolean)
    : [];

  const type = mapActivityType(parsed.type);
  const distanceKm = normalizeDistanceKm(parsed.distanceKm, parsed.distanceMiles);
  const elevationM = normalizeElevationM(parsed.elevationM, parsed.elevationFt) ?? 0;
  let movingTimeSec =
    parseMovingTimeSec(parsed.movingTimeSec) ?? parseMovingTimeSec(parsed.movingTimeText);
  const startDate = normalizeStartDate(parsed.startDate) || new Date().toISOString();
  const averageHr = toNumber(parsed.averageHr);
  const maxHr = toNumber(parsed.maxHr);
  const calories = toNumber(parsed.calories);
  const paceMinPerKm = normalizePaceMinPerKm(
    parsed.paceMinPerKm ?? parsed.paceText,
    distanceKm,
    movingTimeSec
  );

  if (distanceKm != null && (distanceKm < 0 || distanceKm > 500)) {
    warnings.push('Distancia fuera de rango; revisala.');
  }
  if (movingTimeSec != null && (movingTimeSec < 0 || movingTimeSec > 48 * 3600)) {
    warnings.push('Duración fuera de rango; revisala.');
    movingTimeSec = null;
  }
  if (elevationM < 0 || elevationM > 20000) {
    warnings.push('Desnivel dudoso; revisalo.');
  }

  const overall =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.5;

  const fc = parsed.fieldConfidence && typeof parsed.fieldConfidence === 'object'
    ? parsed.fieldConfidence
    : {};

  const fieldsStatus = {};
  const draft = {
    name: parsed.name ? String(parsed.name).slice(0, 120) : 'Actividad importada',
    type,
    distanceKm: distanceKm != null && distanceKm >= 0 && distanceKm <= 500 ? distanceKm : null,
    elevationM: elevationM >= 0 && elevationM <= 20000 ? elevationM : 0,
    movingTime: movingTimeSec,
    startDate,
    averageHr:
      averageHr != null && averageHr >= 30 && averageHr <= 250 ? Math.round(averageHr) : null,
    maxHr: maxHr != null && maxHr >= 30 && maxHr <= 250 ? Math.round(maxHr) : null,
    calories: calories != null && calories >= 0 && calories <= 20000 ? Math.round(calories) : null,
    paceMinPerKm,
    description: parsed.rawTextSummary
      ? `Importado por captura. ${String(parsed.rawTextSummary).slice(0, 280)}`
      : 'Importado por captura de pantalla.',
  };

  const scoreField = (key, present) => {
    const conf = toNumber(fc[key]);
    const c = conf != null ? Math.min(1, Math.max(0, conf)) : present ? overall : 0;
    let status = 'ok';
    if (!present) status = 'missing';
    else if (c < LOW_CONFIDENCE) status = 'low';
    fieldsStatus[key] = { confidence: c, status };
  };

  scoreField('name', Boolean(parsed.name));
  scoreField('type', Boolean(parsed.type));
  scoreField('distanceKm', draft.distanceKm != null);
  scoreField('elevationM', elevationM > 0);
  scoreField('movingTimeSec', draft.movingTime != null);
  scoreField('startDate', Boolean(normalizeStartDate(parsed.startDate)));
  scoreField('averageHr', draft.averageHr != null);
  scoreField('maxHr', draft.maxHr != null);
  scoreField('calories', draft.calories != null);

  if (draft.distanceKm == null && draft.movingTime == null) {
    warnings.push('No se detectaron distancia ni duración. Completalas a mano.');
  }

  let sourceApp = String(parsed.sourceApp || 'other').toLowerCase();
  if (!SOURCE_APPS.has(sourceApp)) sourceApp = 'other';

  return {
    draft,
    confidence: overall,
    fieldsStatus,
    sourceApp,
    warnings,
    rawTextSummary: parsed.rawTextSummary ? String(parsed.rawTextSummary).slice(0, 500) : null,
  };
}

async function countTodayAttempts(userId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return prisma.activityOcrAttempt.count({
    where: { userId, createdAt: { gte: start } },
  });
}

async function assertUnderDailyLimit(userId) {
  const used = await countTodayAttempts(userId);
  if (used >= DAILY_OCR_LIMIT) {
    const err = new Error(
      `Llegaste al límite de ${DAILY_OCR_LIMIT} análisis OCR por día. Probá mañana o cargá la actividad a mano.`
    );
    err.code = 'OCR_DAILY_LIMIT';
    err.used = used;
    err.limit = DAILY_OCR_LIMIT;
    throw err;
  }
  return { used, limit: DAILY_OCR_LIMIT, remaining: DAILY_OCR_LIMIT - used };
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {Buffer} opts.imageBuffer
 * @param {string} opts.mimeType
 * @param {string} [opts.sourceHint]
 * @param {string} [opts.imageUrl] relative /uploads/...
 */
async function parseActivityScreenshot({
  userId,
  imageBuffer,
  mimeType = 'image/jpeg',
  sourceHint,
  imageUrl,
}) {
  if (!aiService.isVisionAvailable()) {
    const err = new Error(
      'OCR no configurado. Con Groq necesitás GROQ_API_KEY y GROQ_VISION_MODEL (modelo con visión, ej. meta-llama/llama-4-scout-17b-16e-instruct).'
    );
    err.code = 'VISION_UNAVAILABLE';
    throw err;
  }

  const quota = await assertUnderDailyLimit(userId);
  const base64 = imageBuffer.toString('base64');
  const prompt = buildPrompt(sourceHint);

  let aiResult;
  try {
    aiResult = await aiService.analyzeImage(base64, mimeType, prompt, 1400);
  } catch (error) {
    if (error.code === 'VISION_UNAVAILABLE') throw error;
    const err = new Error(
      error.message?.includes('vision') || error.status === 404
        ? 'El modelo de IA no soporta imágenes. Con Groq usá GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct (u otro multimodal de Groq).'
        : 'No pudimos leer la captura. Probá con otra foto más nítida.'
    );
    err.code = 'OCR_PARSE_FAILED';
    err.cause = error;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(aiResult.response));
  } catch (e) {
    const err = new Error('La IA devolvió un formato inválido. Reintentá con otra captura.');
    err.code = 'OCR_INVALID_JSON';
    throw err;
  }

  const normalized = validateAndNormalize(parsed);

  const attempt = await prisma.activityOcrAttempt.create({
    data: {
      userId,
      sourceApp: normalized.sourceApp,
      confidence: normalized.confidence,
      status: 'parsed',
      imageUrl: imageUrl || null,
      draft: {
        ...normalized.draft,
        fieldsStatus: normalized.fieldsStatus,
        warnings: normalized.warnings,
      },
      rawResponse: {
        model: aiResult.model,
        tokensUsed: aiResult.tokensUsed,
        summary: normalized.rawTextSummary,
      },
    },
  });

  // Contabiliza contra cuota mensual/diaria de IA (mismo contador que coach).
  await prisma.aIAnalysis.create({
    data: {
      userId,
      type: 'GENERAL_INSIGHT',
      prompt: `OCR activity screenshot (${normalized.sourceApp})`,
      response: JSON.stringify({
        attemptId: attempt.id,
        confidence: normalized.confidence,
        draft: normalized.draft,
      }),
      model: aiResult.model,
      tokensUsed: aiResult.tokensUsed || 0,
    },
  });

  return {
    attemptId: attempt.id,
    imageUrl: imageUrl || null,
    confidence: normalized.confidence,
    fieldsStatus: normalized.fieldsStatus,
    sourceApp: normalized.sourceApp,
    warnings: normalized.warnings,
    draft: normalized.draft,
    quota: {
      ocrDaily: {
        used: quota.used + 1,
        limit: quota.limit,
        remaining: Math.max(0, quota.remaining - 1),
      },
    },
    notice:
      'Esto no suma puntos hasta que confirmes la actividad en el formulario. Revisá los campos marcados.',
  };
}

async function markAttemptAccepted(attemptId, userId, activityId) {
  if (!attemptId) return null;
  return prisma.activityOcrAttempt.updateMany({
    where: { id: attemptId, userId },
    data: { status: 'accepted', activityId },
  });
}

async function markAttemptRejected(attemptId, userId) {
  if (!attemptId) return null;
  return prisma.activityOcrAttempt.updateMany({
    where: { id: attemptId, userId },
    data: { status: 'rejected' },
  });
}

async function findLikelyDuplicates(userId, { type, distanceKm, startDate }) {
  if (!type || distanceKm == null || !startDate) return [];
  const dayStart = new Date(startDate);
  if (Number.isNaN(dayStart.getTime())) return [];
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const dist = Number(distanceKm);
  if (!Number.isFinite(dist) || dist <= 0) return [];

  const candidates = await prisma.activity.findMany({
    where: {
      userId,
      type,
      startDate: { gte: dayStart, lt: dayEnd },
    },
    select: {
      id: true,
      name: true,
      type: true,
      distanceKm: true,
      movingTime: true,
      startDate: true,
    },
    take: 20,
  });

  return candidates.filter((a) => {
    const d = Number(a.distanceKm) || 0;
    if (d <= 0) return false;
    const delta = Math.abs(d - dist) / dist;
    return delta <= 0.02;
  });
}

function readImageFileAsBuffer(filePath) {
  return fs.readFileSync(filePath);
}

module.exports = {
  DAILY_OCR_LIMIT,
  LOW_CONFIDENCE,
  parseActivityScreenshot,
  markAttemptAccepted,
  markAttemptRejected,
  findLikelyDuplicates,
  countTodayAttempts,
  assertUnderDailyLimit,
  validateAndNormalize,
  mapActivityType,
  parseMovingTimeSec,
  normalizeDistanceKm,
  readImageFileAsBuffer,
};
