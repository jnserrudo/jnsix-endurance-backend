const prisma = require('../lib/prisma');

const PACE_PR_THRESHOLDS = [
  { key: 'pace_1k', minKm: 0.95, label: 'Mejor ritmo (~1 km)' },
  { key: 'pace_5k', minKm: 4.75, label: 'Mejor ritmo (~5 km)' },
  { key: 'pace_10k', minKm: 9.5, label: 'Mejor ritmo (~10 km)' },
];

function paceMinPerKm(activity) {
  const distanceKm = Number(activity.distanceKm) || 0;
  const movingTime = Number(activity.movingTime) || 0;
  if (distanceKm <= 0 || movingTime <= 0) return null;
  return (movingTime / 60) / distanceKm;
}

/**
 * Detecta récords personales de la actividad frente al historial previo del usuario.
 * @returns {Promise<Array<{ type: string, label: string, paceMinPerKm?: number, elevationM?: number }>>}
 */
async function detectPersonalRecords(userId, activity) {
  if (!userId || !activity?.id) return [];

  const prior = await prisma.activity.findMany({
    where: {
      userId,
      id: { not: activity.id },
      movingTime: { gt: 0 },
      distanceKm: { gt: 0 },
    },
    select: {
      distanceKm: true,
      movingTime: true,
      elevationM: true,
    },
  });

  const records = [];
  const activityDistance = Number(activity.distanceKm) || 0;
  const newPace = paceMinPerKm(activity);

  for (const threshold of PACE_PR_THRESHOLDS) {
    if (activityDistance < threshold.minKm || newPace == null) continue;

    const eligiblePaces = prior
      .filter((a) => (Number(a.distanceKm) || 0) >= threshold.minKm)
      .map(paceMinPerKm)
      .filter((p) => p != null);

    const bestPrior = eligiblePaces.length > 0 ? Math.min(...eligiblePaces) : null;
    if (bestPrior == null || newPace < bestPrior - 0.0001) {
      records.push({
        type: threshold.key,
        label: threshold.label,
        paceMinPerKm: Number(newPace.toFixed(2)),
      });
    }
  }

  const elevationM = Number(activity.elevationM) || 0;
  if (elevationM > 0) {
    const maxPrior = prior.reduce((max, a) => Math.max(max, Number(a.elevationM) || 0), 0);
    if (elevationM > maxPrior) {
      records.push({
        type: 'max_elevation',
        label: 'Mayor desnivel en una sesión',
        elevationM: Math.round(elevationM),
      });
    }
  }

  return records;
}

module.exports = { detectPersonalRecords, paceMinPerKm };
