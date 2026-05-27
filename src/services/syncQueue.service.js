const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

class SyncQueueService extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
  }

  createJob(userId, stravaAccessToken, afterDate = null) {
    const jobId = uuidv4();
    const job = {
      id: jobId,
      userId,
      status: 'pending',
      progress: 0,
      total: 0,
      processed: 0,
      createdAt: new Date(),
      error: null
    };

    this.jobs.set(jobId, job);
    this.emit('job:created', job);

    // Procesar el job en background
    this.processJob(jobId, stravaAccessToken, afterDate);

    return jobId;
  }

  async processJob(jobId, stravaAccessToken, afterDate) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    try {
      job.status = 'processing';
      this.emit('job:updated', job);

      const stravaService = require('./strava.service');
      const { PrismaClient } = require('@prisma/client');
      const prisma = new PrismaClient();

      let page = 1;
      let allActivities = [];
      let hasMore = true;

      // Primero, obtener el total de actividades
      const firstPage = await stravaService.getActivities(stravaAccessToken, 1, 1, afterDate);
      const totalEstimate = firstPage.length > 0 ? 200 : 0; // Strava no da el total exacto
      job.total = totalEstimate;
      this.emit('job:updated', job);

      while (hasMore) {
        const activities = await stravaService.getActivities(
          stravaAccessToken,
          page,
          30,
          afterDate
        );

        if (activities.length === 0) {
          hasMore = false;
          break;
        }

        // Crear actividades en batch
        const activityData = activities.map(act => ({
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
          rawData: act
        }));

        // Upsert para evitar duplicados
        for (const data of activityData) {
          await prisma.activity.upsert({
            where: { stravaId: data.stravaId },
            update: data,
            create: data
          });
        }

        allActivities = [...allActivities, ...activities];
        job.processed = allActivities.length;
        job.progress = Math.min(100, Math.round((job.processed / job.total) * 100));
        
        this.emit('job:updated', job);

        page++;
        
        // Si recibimos menos de 30, es la última página
        if (activities.length < 30) {
          hasMore = false;
        }

        // Pequeña pausa para no saturar
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Actualizar lastSyncDate del usuario
      await prisma.user.update({
        where: { id: job.userId },
        data: { lastSyncDate: new Date() }
      });

      job.status = 'completed';
      job.progress = 100;
      this.emit('job:completed', job);

    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      this.emit('job:failed', job);
    }
  }

  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  getUserJobs(userId) {
    return Array.from(this.jobs.values()).filter(job => job.userId === userId);
  }
}

module.exports = new SyncQueueService();
