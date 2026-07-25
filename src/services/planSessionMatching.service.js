const prisma = require('../lib/prisma');

const RUN_TYPES = new Set(['RUN', 'TRAIL_RUN', 'VIRTUAL_RUN', 'WALK', 'HIKE']);
const RIDE_TYPES = new Set(['RIDE', 'VIRTUAL_RIDE']);

function startOfLocalDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getPlanMonday(startDate) {
  const monday = startOfLocalDay(startDate);
  const day = monday.getDay();
  monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1));
  return monday;
}

function getSessionDate(startDate, session) {
  const date = getPlanMonday(startDate);
  date.setDate(date.getDate() + (session.week - 1) * 7 + (session.day - 1));
  return date;
}

function isSameLocalDay(a, b) {
  return startOfLocalDay(a).getTime() === startOfLocalDay(b).getTime();
}

function sessionMatchesActivity(session, activity) {
  const haystack = `${session.name || ''} ${session.description || ''}`.toUpperCase();
  const type = String(activity.type || '').toUpperCase();

  if (RUN_TYPES.has(type)) {
    return /(RUN|CORR|TROTE|RODAJE|TRAIL|CAMIN|FONDO|SERIE|INTERVAL)/.test(haystack);
  }
  if (RIDE_TYPES.has(type)) {
    return /(BICI|CICL|RIDE|PEDAL|RODILLO)/.test(haystack);
  }
  if (type === 'SWIM') return /(NAD|NATACI|SWIM|PILETA)/.test(haystack);
  if (type === 'WEIGHTTRAINING' || type === 'CROSSFIT') {
    return /(FUERZA|GIMNAS|PESAS|CORE|CROSSFIT)/.test(haystack);
  }
  if (type === 'YOGA') return /(YOGA|MOVILIDAD|RECUPER)/.test(haystack);
  return /(ENTREN|OTRO|GENERAL)/.test(haystack);
}

async function getTodayPlanSession(userId, date = new Date()) {
  const userPlan = await prisma.userPlan.findFirst({
    where: { userId, isActive: true },
    include: {
      plan: { include: { sessions: { orderBy: [{ week: 'asc' }, { day: 'asc' }] } } },
      competitionGoal: true,
    },
  });
  if (!userPlan) return null;

  const session = userPlan.plan.sessions.find((item) => {
    if (item.status === 'MOVED' && item.rescheduledTo) {
      return isSameLocalDay(item.rescheduledTo, date);
    }
    return isSameLocalDay(getSessionDate(userPlan.startDate, item), date);
  });

  return session ? { userPlan, session, scheduledDate: getSessionDate(userPlan.startDate, session) } : null;
}

async function suggestPlanSessionMatch(userId, activity, autoComplete = false) {
  const today = await getTodayPlanSession(userId, activity.startDate || new Date());
  if (!today || today.session.status !== 'PENDING' || !sessionMatchesActivity(today.session, activity)) {
    return null;
  }

  let session = today.session;
  if (autoComplete) {
    session = await prisma.planSession.update({
      where: { id: session.id },
      data: {
        status: 'DONE',
        completedActivityId: activity.id,
        completedAt: new Date(),
        rescheduledTo: null,
      },
    });
  }

  return {
    planId: today.userPlan.trainingPlanId,
    userPlanId: today.userPlan.id,
    session,
    activityId: activity.id,
    matched: true,
    autoCompleted: autoComplete,
  };
}

module.exports = {
  getPlanMonday,
  getSessionDate,
  getTodayPlanSession,
  sessionMatchesActivity,
  suggestPlanSessionMatch,
};
