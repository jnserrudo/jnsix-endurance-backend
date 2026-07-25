const prisma = require('../lib/prisma');
const scoringService = require('./scoring.service');
const { copy } = require('../constants/copy.es');
const { activeMissionWhere } = require('./missionRotation.service');

const { calculateStreakFromDates } = require('../utils/streak');

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
            longestStreak: currentStreak
          }
        });
      } else {
        await prisma.streak.update({
          where: { id: streakRecord.id },
          data: {
            currentStreak,
            longestStreak: Math.max(streakRecord.longestStreak, currentStreak)
          }
        });
      }

      await scoringService.awardStreakBonusIfEligible(userId, currentStreak);

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

      return completedMissions;
    } catch (error) {
      console.error('[GamificationService] checkMissionsForActivity error:', error);
      return [];
    }
  }
}

module.exports = new GamificationService();
