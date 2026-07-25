const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

const STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
};

class SyncQueueService extends EventEmitter {
  constructor() {
    super();
    this.activeProcessors = new Set();
  }

  async createJob(userId, stravaAccessToken, afterDate = null) {
    const prisma = require('../lib/prisma');

    const job = await prisma.syncJob.create({
      data: {
        userId,
        type: 'STRAVA',
        status: STATUS.PENDING,
        payload: {
          afterDate: afterDate ? new Date(afterDate).toISOString() : null,
          progress: 0,
          total: 0,
          processed: 0,
        },
      },
    });

    this.emit('job:created', this.toPublicJob(job));

    // Procesar en background (no bloquear la respuesta HTTP)
    setImmediate(() => {
      this.processJob(job.id, stravaAccessToken).catch((err) => {
        console.error('[SyncQueue] Error procesando job:', err.message);
      });
    });

    return job.id;
  }

  toPublicJob(job) {
    const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
    return {
      id: job.id,
      userId: job.userId,
      type: job.type,
      status: job.status,
      // Compatibilidad con clientes que esperaban estados en minúscula
      progress: payload.progress || 0,
      total: payload.total || 0,
      processed: payload.processed || 0,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      payload,
    };
  }

  async updateJob(jobId, data) {
    const prisma = require('../lib/prisma');
    const job = await prisma.syncJob.update({
      where: { id: jobId },
      data,
    });
    const publicJob = this.toPublicJob(job);
    this.emit('job:updated', publicJob);
    return publicJob;
  }

  async processJob(jobId, stravaAccessToken = null) {
    if (this.activeProcessors.has(jobId)) return;
    this.activeProcessors.add(jobId);

    const prisma = require('../lib/prisma');
    const stravaService = require('./strava.service');
    const scoringService = require('./scoring.service');
    const challengesService = require('./challenges.service');

    let job = await prisma.syncJob.findUnique({ where: { id: jobId } });
    if (!job) {
      this.activeProcessors.delete(jobId);
      return;
    }

    if (job.status === STATUS.DONE || job.status === STATUS.FAILED) {
      this.activeProcessors.delete(jobId);
      return;
    }

    try {
      const payload = { ...(job.payload && typeof job.payload === 'object' ? job.payload : {}) };

      job = await this.updateJob(jobId, {
        status: STATUS.RUNNING,
        error: null,
        payload,
      });

      // Resolver token: preferir el pasado, si no, leer del usuario
      let accessToken = stravaAccessToken;
      if (!accessToken) {
        const user = await prisma.user.findUnique({ where: { id: job.userId } });
        if (!user?.stravaAccessToken) {
          throw new Error('Usuario no conectado a Strava');
        }
        // Refrescar si está por expirar
        const isExpired =
          user.stravaTokenExpiry &&
          new Date(user.stravaTokenExpiry).getTime() - Date.now() < 5 * 60 * 1000;
        if (isExpired && user.stravaRefreshToken) {
          const refreshData = await stravaService.refreshToken(user.stravaRefreshToken);
          const updatedUser = await prisma.user.update({
            where: { id: user.id },
            data: {
              stravaAccessToken: refreshData.access_token,
              stravaRefreshToken: refreshData.refresh_token || user.stravaRefreshToken,
              stravaTokenExpiry: new Date(Date.now() + refreshData.expires_in * 1000),
            },
          });
          accessToken = updatedUser.stravaAccessToken;
        } else {
          accessToken = user.stravaAccessToken;
        }
      }

      const afterDate = payload.afterDate ? new Date(payload.afterDate) : null;

      let page = 1;
      let allActivities = [];
      let hasMore = true;

      const firstPage = await stravaService.getActivities(accessToken, 1, 1, afterDate);
      const totalEstimate = firstPage.length > 0 ? 200 : 0;
      payload.total = totalEstimate;
      payload.progress = 0;
      payload.processed = 0;
      await this.updateJob(jobId, { status: STATUS.RUNNING, payload: { ...payload } });

      while (hasMore) {
        const activities = await stravaService.getActivities(accessToken, page, 30, afterDate);

        if (activities.length === 0) {
          hasMore = false;
          break;
        }

        const activityData = activities.map((act) => ({
          id: uuidv4(),
          userId: job.userId,
          stravaId: act.id?.toString(),
          name: act.name || 'Strava Activity',
          type: act.type?.toUpperCase() || 'RUN',
          startDate: act.start_date,
          distanceKm: act.distance ? act.distance / 1000 : 0,
          movingTime: act.moving_time || 0,
          elevationM: act.total_elevation_gain || 0,
          averageHr: act.average_heartrate || 0,
          maxHr: act.max_heartrate || 0,
          calories: act.calories || 0,
          rawData: act,
        }));

        for (const data of activityData) {
          const { id, userId, stravaId, ...updateData } = data;
          const upserted = await prisma.activity.upsert({
            where: { stravaId: data.stravaId },
            update: updateData,
            create: data,
          });

          scoringService.awardActivityPointsIfNotScored(upserted.id).catch((err) => {
            console.error('[Scoring] Failed to award points for synced activity:', err.message);
          });
        }

        allActivities = [...allActivities, ...activities];
        payload.processed = allActivities.length;
        payload.progress = Math.min(100, Math.round((payload.processed / Math.max(payload.total, 1)) * 100));
        await this.updateJob(jobId, { status: STATUS.RUNNING, payload: { ...payload } });

        page++;
        if (activities.length < 30) {
          hasMore = false;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      await prisma.user.update({
        where: { id: job.userId },
        data: { lastSyncDate: new Date() },
      });

      scoringService.recalculateUserScore(job.userId).catch((err) => {
        console.error('[Scoring] Failed to recalculate user score after sync:', err.message);
      });

      challengesService.updateChallengeProgress(job.userId).catch((err) => {
        console.error('[Challenges] Failed to update progress after sync queue:', err.message);
      });

      payload.progress = 100;
      const doneJob = await this.updateJob(jobId, {
        status: STATUS.DONE,
        payload: { ...payload },
        error: null,
      });
      this.emit('job:completed', doneJob);
    } catch (error) {
      console.error(`[SyncQueue] Job ${jobId} falló:`, error.message);
      const failedJob = await this.updateJob(jobId, {
        status: STATUS.FAILED,
        error: error.message || 'Error desconocido en la sincronización',
      }).catch(() => null);
      if (failedJob) this.emit('job:failed', failedJob);
    } finally {
      this.activeProcessors.delete(jobId);
    }
  }

  async getJob(jobId) {
    const prisma = require('../lib/prisma');
    const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
    return job ? this.toPublicJob(job) : null;
  }

  async getUserJobs(userId) {
    const prisma = require('../lib/prisma');
    const jobs = await prisma.syncJob.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return jobs.map((j) => this.toPublicJob(j));
  }

  /**
   * Reanuda jobs PENDING/RUNNING tras un reinicio del servidor.
   */
  async resumePendingJobs() {
    const prisma = require('../lib/prisma');
    const pending = await prisma.syncJob.findMany({
      where: {
        status: { in: [STATUS.PENDING, STATUS.RUNNING] },
        type: 'STRAVA',
      },
      orderBy: { createdAt: 'asc' },
    });

    if (pending.length === 0) {
      console.log('[SyncQueue] No hay jobs pendientes para reanudar');
      return;
    }

    console.log(`[SyncQueue] Reanudando ${pending.length} job(s) PENDING/RUNNING...`);

    for (const job of pending) {
      // Volver a PENDING si quedó RUNNING a medias
      if (job.status === STATUS.RUNNING) {
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: STATUS.PENDING },
        });
      }
      setImmediate(() => {
        this.processJob(job.id).catch((err) => {
          console.error(`[SyncQueue] Error reanudando job ${job.id}:`, err.message);
        });
      });
    }
  }
}

module.exports = new SyncQueueService();
module.exports.STATUS = STATUS;
