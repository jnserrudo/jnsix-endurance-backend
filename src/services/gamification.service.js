const { prisma } = require('../lib/prisma');

class GamificationService {
  async updateStreak(userId) {
    try {
      const activities = await prisma.activity.findMany({
        where: { userId },
        orderBy: { startDate: 'desc' },
        select: { startDate: true }
      });

      if (activities.length === 0) return 0;

      // Extract unique dates in YYYY-MM-DD
      const dates = [...new Set(activities.map(a => a.startDate.toISOString().split('T')[0]))];
      
      let currentStreak = 0;
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

      if (dates.includes(today) || dates.includes(yesterday)) {
        currentStreak = 1;
        let checkDate = new Date(dates[0]); // start from the most recent
        
        for (let i = 1; i < dates.length; i++) {
          checkDate.setDate(checkDate.getDate() - 1);
          const expectedStr = checkDate.toISOString().split('T')[0];
          if (dates[i] === expectedStr) {
            currentStreak++;
          } else {
            break;
          }
        }
      }

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

      return currentStreak;
    } catch (error) {
      console.error('[GamificationService] updateStreak error:', error);
      return 0;
    }
  }

  async checkMissionsForActivity(userId, activity) {
    try {
      const activeMissions = await prisma.mission.findMany({
        where: { isActive: true }
      });

      for (const mission of activeMissions) {
        let userMission = await prisma.userMission.findFirst({
          where: { userId, missionId: mission.id }
        });

        if (userMission && userMission.completed) continue;

        let increment = 0;
        if (mission.type === 'FIRST_ACTIVITY') {
          increment = 1;
        } else if (mission.type === 'TOTAL_DISTANCE') {
          increment = activity.distanceKm || 0;
        } else if (mission.type === 'STREAK') {
          const currentStreak = await this.updateStreak(userId);
          if (currentStreak >= mission.targetValue) {
             increment = mission.targetValue;
          }
        }

        if (increment > 0 || mission.type === 'STREAK') {
          const newProgress = mission.type === 'STREAK' 
                              ? Math.max(userMission?.currentProgress || 0, await this.updateStreak(userId)) 
                              : (userMission?.currentProgress || 0) + increment;
                              
          const completed = newProgress >= mission.targetValue;

          if (!userMission) {
            await prisma.userMission.create({
              data: {
                user: { connect: { id: userId } },
                mission: { connect: { id: mission.id } },
                currentProgress: newProgress,
                completed,
                completedAt: completed ? new Date() : null
              }
            });
          } else {
            await prisma.userMission.update({
              where: { id: userMission.id },
              data: {
                currentProgress: newProgress,
                completed,
                completedAt: (!userMission.completed && completed) ? new Date() : userMission.completedAt
              }
            });
          }
        }
      }
    } catch (error) {
      console.error('[GamificationService] checkMissionsForActivity error:', error);
    }
  }
}

module.exports = new GamificationService();
