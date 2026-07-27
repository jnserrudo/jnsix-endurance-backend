const prisma = require('../lib/prisma');
const scoringService = require('./scoring.service');
const { copy } = require('../constants/copy.es');
const { activeMissionWhere, startOfDay, getTodayMissionForUser } = require('./missionRotation.service');
const { ensureBadgesExist } = require('../data/defaultBadges');
const { notify } = require('./notifications.service');

const { calculateStreakFromDates } = require('../utils/streak');

const COMBO_POINTS = 15;
const COMBO_REASON_PREFIX = 'Bonus combo del día';

function dayBounds(d = new Date()) {
  const start = startOfDay(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function weekBounds(d = new Date()) {
  const start = startOfDay(d);
  const day = start.getDay(); // 0=Sun
  const diffToMonday = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diffToMonday);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

class GamificationService {
  async updateStreak(userId) {
    try {
      const activities = await prisma.activity.findMany({
        where: { userId },
        orderBy: { startDate: 'desc' },
        select: { startDate: true }
      });

      const currentStreak = calculateStreakFromDates(activities.map((a) => a.startDate));

      let streakRecord = await prisma.streak.findUnique({ where: { userId } });
      if (!streakRecord) {
        streakRecord = await prisma.streak.create({
          data: {
            user: { connect: { id: userId } },
            currentStreak,
            longestStreak: currentStreak,
            lastActivityAt: activities[0]?.startDate || null,
          }
        });
      } else {
        await prisma.streak.update({
          where: { id: streakRecord.id },
          data: {
            currentStreak,
            longestStreak: Math.max(streakRecord.longestStreak, currentStreak),
            lastActivityAt: activities[0]?.startDate || streakRecord.lastActivityAt,
          }
        });
      }

      await scoringService.awardStreakBonusIfEligible(userId, currentStreak);
      await this.checkAndAwardBadges(userId, { streak: currentStreak });

      return currentStreak;
    } catch (error) {
      console.error('[GamificationService] updateStreak error:', error);
      return 0;
    }
  }

  async checkMissionsForActivity(userId, activity) {
    try {
      const currentStreak = await this.updateStreak(userId);
      const now = new Date();
      const activeMissions = await prisma.mission.findMany({
        where: activeMissionWhere(now),
      });

      const completedMissions = [];

      for (const mission of activeMissions) {
        let userMission = await prisma.userMission.findFirst({
          where: { userId, missionId: mission.id }
        });

        if (userMission && userMission.completed) continue;

        let increment = 0;
        const type = mission.type || '';

        if (type === 'FIRST_ACTIVITY' || type === 'DAILY_ACTIVITY' || type === 'WEEKLY_ACTIVITY_COUNT') {
          increment = 1;
        } else if (
          type === 'TOTAL_DISTANCE' ||
          type === 'DAILY_DISTANCE' ||
          type === 'WEEKLY_DISTANCE' ||
          type.endsWith('_DISTANCE')
        ) {
          increment = activity.distanceKm || 0;
        } else if (type === 'STREAK') {
          if (currentStreak >= mission.targetValue) {
            increment = mission.targetValue;
          }
        }

        if (increment > 0 || type === 'STREAK') {
          const newProgress = type === 'STREAK'
            ? Math.max(userMission?.currentProgress || 0, currentStreak)
            : (userMission?.currentProgress || 0) + increment;

          const completed = newProgress >= mission.targetValue;
          const wasCompleted = userMission?.completed || false;

          if (!userMission) {
            userMission = await prisma.userMission.create({
              data: {
                user: { connect: { id: userId } },
                mission: { connect: { id: mission.id } },
                currentProgress: newProgress,
                completed,
                completedAt: completed ? new Date() : null
              }
            });
          } else {
            userMission = await prisma.userMission.update({
              where: { id: userMission.id },
              data: {
                currentProgress: newProgress,
                completed,
                completedAt: (!userMission.completed && completed) ? new Date() : userMission.completedAt
              }
            });
          }

          if (completed && !wasCompleted && mission.rewardPts > 0) {
            const existingMissionScore = await prisma.scoreEvent.findFirst({
              where: { userId, missionId: mission.id }
            });

            if (!existingMissionScore) {
              await scoringService.awardPoints(userId, {
                points: mission.rewardPts,
                reason: copy.missionCompleted(mission.name),
                missionId: mission.id
              });
              completedMissions.push({ mission, points: mission.rewardPts });
            }
          }
        }
      }

      await this.checkAndAwardBadges(userId);
      // Insignias climáticas (H5): por texto en nombre/descripción
      await this.awardWeatherBadgesFromActivity(userId, activity);
      const combo = await this.checkDailyComboBonus(userId);
      if (combo?.awarded) {
        completedMissions.push({
          mission: { name: 'Combo del día', title: 'Combo del día' },
          points: combo.points,
          isCombo: true,
        });
      }

      return completedMissions;
    } catch (error) {
      console.error('[GamificationService] checkMissionsForActivity error:', error);
      return [];
    }
  }

  /**
   * Bonus pequeño si el usuario entrena + publica + reacciona el mismo día (1 vez/día).
   */
  async checkDailyComboBonus(userId) {
    try {
      const { start, end } = dayBounds();
      const dayKey = start.toISOString().slice(0, 10);

      const existing = await prisma.scoreEvent.findFirst({
        where: {
          userId,
          reason: { startsWith: COMBO_REASON_PREFIX },
          createdAt: { gte: start, lt: end },
        },
      });
      if (existing) return { awarded: false, alreadyAwarded: true };

      const [activityCount, postCount, reactionCount] = await Promise.all([
        prisma.activity.count({
          where: { userId, startDate: { gte: start, lt: end } },
        }),
        prisma.post.count({
          where: { userId, createdAt: { gte: start, lt: end }, isActive: true },
        }),
        prisma.reaction.count({
          where: { userId, createdAt: { gte: start, lt: end } },
        }),
      ]);

      if (activityCount < 1 || postCount < 1 || reactionCount < 1) {
        return { awarded: false, progress: { activityCount, postCount, reactionCount } };
      }

      const result = await scoringService.awardPoints(userId, {
        points: COMBO_POINTS,
        reason: `${COMBO_REASON_PREFIX}: entrená + publicá + reaccioná`,
      });

      await this.awardBadgeByCode(userId, 'social_combo');

      return {
        awarded: true,
        points: COMBO_POINTS,
        dayKey,
        newTotalPoints: result.userScore?.totalPoints ?? null,
      };
    } catch (error) {
      console.error('[GamificationService] checkDailyComboBonus error:', error);
      return { awarded: false, error: error.message };
    }
  }

  async ensureBadges() {
    return ensureBadgesExist(prisma);
  }

  async getBadgesCatalog(userId) {
    const badges = await this.ensureBadges();
    const earned = await prisma.userBadge.findMany({
      where: { userId },
      include: { badge: true },
    });
    const earnedMap = new Map(earned.map((ub) => [ub.badgeId, ub]));

    return {
      catalog: badges.map((b) => {
        const ub = earnedMap.get(b.id);
        return {
          id: b.id,
          code: b.code,
          name: b.name,
          description: b.description,
          iconUrl: b.iconUrl,
          criteria: b.criteria,
          earned: !!ub,
          earnedAt: ub?.earnedAt || null,
        };
      }),
      earnedCount: earned.length,
      totalCount: badges.length,
    };
  }

  async awardBadgeByCode(userId, code) {
    const badge = await prisma.badge.findUnique({ where: { code } });
    if (!badge) return null;

    const existing = await prisma.userBadge.findUnique({
      where: { userId_badgeId: { userId, badgeId: badge.id } },
    });
    if (existing) return null;

    const ub = await prisma.userBadge.create({
      data: { userId, badgeId: badge.id },
      include: { badge: true },
    });
    return ub;
  }

  /**
   * Otorga rain_run / heat_run si el nombre o descripción de la actividad lo sugiere.
   * Estilo first_post: se otorga una sola vez vía awardBadgeByCode.
   */
  async awardWeatherBadgesFromActivity(userId, activity) {
    if (!activity) return [];
    const text = `${activity.name || ''} ${activity.description || ''}`.toLowerCase();
    const newly = [];

    const isRain = /lluvia|rain|lluvioso|storm|tormenta/.test(text);
    const isHeat = /calor|heat|hot|quemante|bochorno|ola de calor/.test(text);

    if (isRain) {
      const awarded = await this.awardBadgeByCode(userId, 'rain_run');
      if (awarded) newly.push(awarded);
    }
    if (isHeat) {
      const awarded = await this.awardBadgeByCode(userId, 'heat_run');
      if (awarded) newly.push(awarded);
    }
    return newly;
  }

  async checkAndAwardBadges(userId, hints = {}) {
    await this.ensureBadges();
    const newlyEarned = [];

    const [activityCount, totalDistanceAgg, postCount, streakRow, duelWins, checkInCount] =
      await Promise.all([
        prisma.activity.count({ where: { userId } }),
        prisma.activity.aggregate({ where: { userId }, _sum: { distanceKm: true } }),
        prisma.post.count({ where: { userId, isActive: true } }),
        hints.streak != null
          ? Promise.resolve({ currentStreak: hints.streak })
          : prisma.streak.findUnique({ where: { userId } }),
        prisma.duel.count({
          where: {
            status: 'COMPLETED',
            winnerId: userId,
          },
        }),
        hints.checkInCount != null
          ? Promise.resolve(hints.checkInCount)
          : prisma.businessCheckIn.count({ where: { userId } }),
      ]);

    const totalDistance = totalDistanceAgg._sum.distanceKm || 0;
    const streak = streakRow?.currentStreak || 0;

    const checks = [
      { code: 'first_activity', ok: activityCount >= 1 },
      { code: 'activities_10', ok: activityCount >= 10 },
      { code: 'first_post', ok: postCount >= 1 },
      { code: 'streak_7', ok: streak >= 7 },
      { code: 'streak_30', ok: streak >= 30 },
      { code: 'distance_100', ok: totalDistance >= 100 },
      { code: 'distance_500', ok: totalDistance >= 500 },
      { code: 'duel_win', ok: duelWins >= 1 },
      { code: 'local_client', ok: checkInCount >= 1 },
    ];

    for (const c of checks) {
      if (!c.ok) continue;
      const awarded = await this.awardBadgeByCode(userId, c.code);
      if (awarded) newlyEarned.push(awarded);
    }

    return newlyEarned;
  }

  async getStreakAtRiskStatus(userId) {
    const streak = await prisma.streak.findUnique({ where: { userId } });
    if (!streak || streak.currentStreak < 2) {
      return { atRisk: false, currentStreak: streak?.currentStreak || 0 };
    }

    const { start, end } = dayBounds();
    const trainedToday = await prisma.activity.count({
      where: { userId, startDate: { gte: start, lt: end } },
    });

    if (trainedToday > 0) {
      return { atRisk: false, currentStreak: streak.currentStreak, trainedToday: true };
    }

    const yesterday = new Date(start);
    yesterday.setDate(yesterday.getDate() - 1);
    const trainedYesterday = await prisma.activity.count({
      where: { userId, startDate: { gte: yesterday, lt: start } },
    });

    return {
      atRisk: trainedYesterday > 0,
      currentStreak: streak.currentStreak,
      trainedToday: false,
      trainedYesterday: trainedYesterday > 0,
    };
  }

  async sumMetricForUser(userId, metric, weekStart, weekEnd) {
    if (metric === 'POINTS') {
      const agg = await prisma.scoreEvent.aggregate({
        where: {
          userId,
          points: { gt: 0 },
          createdAt: { gte: weekStart, lt: weekEnd },
        },
        _sum: { points: true },
      });
      return agg._sum.points || 0;
    }

    const agg = await prisma.activity.aggregate({
      where: {
        userId,
        startDate: { gte: weekStart, lt: weekEnd },
      },
      _sum: { distanceKm: true },
    });
    return Number(agg._sum.distanceKm || 0);
  }

  async refreshDuelScores(duel) {
    if (!['ACTIVE', 'PENDING', 'COMPLETED'].includes(duel.status)) return duel;

    const [challengerScore, opponentScore] = await Promise.all([
      this.sumMetricForUser(duel.challengerId, duel.metric, duel.weekStart, duel.weekEnd),
      this.sumMetricForUser(duel.opponentId, duel.metric, duel.weekStart, duel.weekEnd),
    ]);

    const now = new Date();
    let status = duel.status;
    let winnerId = duel.winnerId;

    if (status === 'ACTIVE' && now >= duel.weekEnd) {
      status = 'COMPLETED';
      if (challengerScore > opponentScore) winnerId = duel.challengerId;
      else if (opponentScore > challengerScore) winnerId = duel.opponentId;
      else winnerId = null;
    }

    const updated = await prisma.duel.update({
      where: { id: duel.id },
      data: { challengerScore, opponentScore, status, winnerId },
      include: {
        challenger: { select: { id: true, username: true, firstName: true, avatarUrl: true } },
        opponent: { select: { id: true, username: true, firstName: true, avatarUrl: true } },
      },
    });

    const justCompleted = status === 'COMPLETED' && duel.status !== 'COMPLETED';

    if (justCompleted && winnerId) {
      await this.awardBadgeByCode(winnerId, 'duel_win');
    }

    if (justCompleted) {
      const metricLabel = duel.metric === 'POINTS' ? 'pts' : 'km';
      const scoreLine = `${challengerScore.toFixed(1)} vs ${opponentScore.toFixed(1)} ${metricLabel}`;
      let resultBody;
      if (!winnerId) {
        resultBody = `Empate en el duelo: ${scoreLine}.`;
      } else if (winnerId === duel.challengerId) {
        resultBody = `Ganó ${updated.challenger?.firstName || updated.challenger?.username || 'el retador'}: ${scoreLine}.`;
      } else {
        resultBody = `Ganó ${updated.opponent?.firstName || updated.opponent?.username || 'el oponente'}: ${scoreLine}.`;
      }

      const payload = {
        type: 'DUEL_UPDATE',
        duelId: duel.id,
        status: 'COMPLETED',
        challengerScore,
        opponentScore,
        winnerId,
        screen: 'Achievements',
      };

      await Promise.all([
        notify(duel.challengerId, 'DUEL_UPDATE', {
          title: 'Duelo finalizado',
          body: resultBody,
          payload,
          dedupeKey: `duel-done:${duel.id}:challenger`,
        }).catch(console.error),
        notify(duel.opponentId, 'DUEL_UPDATE', {
          title: 'Duelo finalizado',
          body: resultBody,
          payload,
          dedupeKey: `duel-done:${duel.id}:opponent`,
        }).catch(console.error),
      ]);
    }

    return updated;
  }

  async createDuel(challengerId, opponentId, metric = 'DISTANCE') {
    if (challengerId === opponentId) {
      const err = new Error('No podés desafiarte a vos mismo');
      err.status = 400;
      throw err;
    }

    const opponent = await prisma.user.findUnique({ where: { id: opponentId } });
    if (!opponent) {
      const err = new Error('Oponente no encontrado');
      err.status = 404;
      throw err;
    }

    const metricNorm = String(metric || 'DISTANCE').toUpperCase();
    if (!['DISTANCE', 'POINTS'].includes(metricNorm)) {
      const err = new Error('Métrica inválida (DISTANCE o POINTS)');
      err.status = 400;
      throw err;
    }

    const { start, end } = weekBounds();

    const existing = await prisma.duel.findFirst({
      where: {
        status: { in: ['PENDING', 'ACTIVE'] },
        weekStart: start,
        OR: [
          { challengerId, opponentId },
          { challengerId: opponentId, opponentId: challengerId },
        ],
      },
    });
    if (existing) {
      const err = new Error('Ya hay un duelo activo o pendiente con este rival esta semana');
      err.status = 409;
      throw err;
    }

    const duel = await prisma.duel.create({
      data: {
        challengerId,
        opponentId,
        metric: metricNorm,
        weekStart: start,
        weekEnd: end,
        status: 'PENDING',
      },
      include: {
        challenger: { select: { id: true, username: true, firstName: true, avatarUrl: true } },
        opponent: { select: { id: true, username: true, firstName: true, avatarUrl: true } },
      },
    });

    const challenger = await prisma.user.findUnique({
      where: { id: challengerId },
      select: { username: true, firstName: true, email: true },
    });
    const label = challenger?.firstName || challenger?.username || challenger?.email || 'Un atleta';

    await notify(opponentId, 'DUEL_UPDATE', {
      title: '¡Te desafiaron a un duelo!',
      body: `${label} te retó a un duelo semanal por ${metricNorm === 'POINTS' ? 'puntos' : 'distancia'}.`,
      payload: { type: 'DUEL_UPDATE', duelId: duel.id, screen: 'Achievements' },
      dedupeKey: `duel:${duel.id}`,
    }).catch(console.error);

    return duel;
  }

  async acceptOrDeclineDuel(duelId, userId, accept) {
    const duel = await prisma.duel.findUnique({ where: { id: duelId } });
    if (!duel) {
      const err = new Error('Duelo no encontrado');
      err.status = 404;
      throw err;
    }
    if (duel.opponentId !== userId) {
      const err = new Error('Solo el oponente puede responder el duelo');
      err.status = 403;
      throw err;
    }
    if (duel.status !== 'PENDING') {
      const err = new Error('Este duelo ya no está pendiente');
      err.status = 400;
      throw err;
    }

    if (!accept) {
      return prisma.duel.update({
        where: { id: duelId },
        data: { status: 'DECLINED' },
        include: {
          challenger: { select: { id: true, username: true, firstName: true, avatarUrl: true } },
          opponent: { select: { id: true, username: true, firstName: true, avatarUrl: true } },
        },
      });
    }

    const activated = await prisma.duel.update({
      where: { id: duelId },
      data: { status: 'ACTIVE' },
    });

    return this.refreshDuelScores(activated);
  }

  async listMyDuels(userId) {
    const duels = await prisma.duel.findMany({
      where: {
        OR: [{ challengerId: userId }, { opponentId: userId }],
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: {
        challenger: { select: { id: true, username: true, firstName: true, avatarUrl: true } },
        opponent: { select: { id: true, username: true, firstName: true, avatarUrl: true } },
      },
    });

    const refreshed = [];
    for (const d of duels) {
      if (d.status === 'ACTIVE' || d.status === 'PENDING') {
        refreshed.push(await this.refreshDuelScores(d));
      } else {
        refreshed.push(d);
      }
    }
    return refreshed;
  }

  async getTodayMission(userId) {
    return getTodayMissionForUser(userId);
  }

  /**
   * Check-in en negocio: badge "Cliente local" + progreso misiones WEEKLY/DAILY BUSINESS_CHECK_IN.
   */
  async onBusinessCheckIn(userId, businessId) {
    const newly = [];
    try {
      await this.ensureBadges();
      const badge = await this.awardBadgeByCode(userId, 'local_client');
      if (badge) newly.push(badge);

      const now = new Date();
      const missions = await prisma.mission.findMany({
        where: {
          AND: [
            activeMissionWhere(now),
            {
              OR: [
                { type: 'BUSINESS_CHECK_IN' },
                { type: 'WEEKLY_BUSINESS_CHECK_IN' },
                { type: 'DAILY_BUSINESS_CHECK_IN' },
              ],
            },
          ],
        },
      });

      for (const mission of missions) {
        let userMission = await prisma.userMission.findFirst({
          where: { userId, missionId: mission.id },
        });
        if (userMission?.completed) continue;

        const newProgress = (userMission?.currentProgress || 0) + 1;
        const completed = newProgress >= mission.targetValue;
        const wasCompleted = userMission?.completed || false;

        if (!userMission) {
          userMission = await prisma.userMission.create({
            data: {
              user: { connect: { id: userId } },
              mission: { connect: { id: mission.id } },
              currentProgress: newProgress,
              completed,
              completedAt: completed ? new Date() : null,
            },
          });
        } else {
          userMission = await prisma.userMission.update({
            where: { id: userMission.id },
            data: {
              currentProgress: newProgress,
              completed,
              completedAt: !wasCompleted && completed ? new Date() : userMission.completedAt,
            },
          });
        }

        if (completed && !wasCompleted && mission.rewardPts > 0) {
          const existingMissionScore = await prisma.scoreEvent.findFirst({
            where: { userId, missionId: mission.id },
          });
          if (!existingMissionScore) {
            await scoringService.awardPoints(userId, {
              points: mission.rewardPts,
              reason: copy.missionCompleted(mission.name),
              missionId: mission.id,
            });
          }
        }
      }
    } catch (err) {
      console.error('[Gamification] onBusinessCheckIn:', err.message);
    }
    return { badges: newly, businessId };
  }
}

module.exports = new GamificationService();
