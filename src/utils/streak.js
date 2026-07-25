/**
 * Shared streak calculation from activity start dates.
 * Counts consecutive calendar days ending today or yesterday.
 */
function calculateStreakFromDates(startDates) {
  if (!startDates || startDates.length === 0) return 0;

  const dateSet = new Set(
    startDates.map((d) => {
      const date = d instanceof Date ? d : new Date(d);
      return date.toISOString().split('T')[0];
    })
  );

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  if (!dateSet.has(todayStr) && !dateSet.has(yesterdayStr)) {
    return 0;
  }

  let streak = 0;
  const cursor = new Date(dateSet.has(todayStr) ? today : yesterday);
  cursor.setHours(12, 0, 0, 0);

  while (true) {
    const key = cursor.toISOString().split('T')[0];
    if (!dateSet.has(key)) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}

module.exports = { calculateStreakFromDates };
