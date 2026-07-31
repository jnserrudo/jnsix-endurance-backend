/**
 * Shared streak calculation from activity start dates.
 * Counts consecutive calendar days ending today or yesterday.
 *
 * Todo el cálculo vive en UTC (las claves son YYYY-MM-DD de `toISOString`).
 * Mezclar UTC con un cursor en hora local cortaba la racha entre las 21:00 y
 * la medianoche en husos negativos (p. ej. Argentina): el día UTC ya había
 * avanzado y el cursor arrancaba desfasado.
 */
function toUtcDayKey(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Resta un día a una clave YYYY-MM-DD sin pasar por hora local. */
function prevUtcDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function calculateStreakFromDates(startDates) {
  if (!startDates || startDates.length === 0) return 0;

  const dateSet = new Set();
  for (const raw of startDates) {
    const key = toUtcDayKey(raw);
    if (key) dateSet.add(key);
  }
  if (dateSet.size === 0) return 0;

  const todayStr = toUtcDayKey(new Date());
  const yesterdayStr = prevUtcDayKey(todayStr);

  if (!dateSet.has(todayStr) && !dateSet.has(yesterdayStr)) {
    return 0;
  }

  let streak = 0;
  let cursor = dateSet.has(todayStr) ? todayStr : yesterdayStr;

  while (dateSet.has(cursor)) {
    streak++;
    cursor = prevUtcDayKey(cursor);
  }

  return streak;
}

module.exports = { calculateStreakFromDates };
