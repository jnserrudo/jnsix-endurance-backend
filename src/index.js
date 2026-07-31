const path = require('path');
// Siempre cargar .env relativo al backend (no al cwd de PM2).
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const sentry = require('./lib/sentry');
sentry.init();

const authRoutes = require('./routes/auth.routes');
const activitiesRoutes = require('./routes/activities.routes');
const comparisonsRoutes = require('./routes/comparisons.routes');
const aiRoutes = require('./routes/ai.routes');
const webhookRoutes = require('./routes/webhook.routes');
const competitionsRoutes = require('./routes/competitions.routes');
const friendsRoutes = require('./routes/friends.routes');
const groupsRoutes = require('./routes/groups.routes');
const communitiesRoutes = require('./routes/communities.routes');
const rankingsRoutes = require('./routes/rankings.routes');
const feedRoutes = require('./routes/feed.routes');
const challengesRoutes = require('./routes/challenges.routes');
const chatRoutes = require('./routes/chat.routes');
const adminRoutes = require('./routes/admin.routes');
const paymentsRoutes = require('./routes/payments.routes');
const exercisesRoutes = require('./routes/exercises.routes');
const workoutsRoutes = require('./routes/workouts.routes');
const achievementsRoutes = require('./routes/achievements.routes');
const usersRoutes = require('./routes/users.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const plansRoutes = require('./routes/plans.routes');
const stripeRoutes = require('./routes/stripe.routes');
const gamificationRoutes = require('./routes/gamification.routes');
const duelsRoutes = require('./routes/duels.routes');
const storiesRoutes = require('./routes/stories.routes');
const trainingPlansRoutes = require('./routes/trainingPlans.routes');
const segmentsRoutes = require('./routes/segments.routes');
const liveChallengesRoutes = require('./routes/liveChallenges.routes');
const liveRunsRoutes = require('./routes/liveRuns.routes');
const integrationsRoutes = require('./routes/integrations.routes');
const scoringRoutes = require('./routes/scoring.routes');
const businessesRoutes = require('./routes/businesses.routes');
const rewardsRoutes = require('./routes/rewards.routes');
const redemptionsRoutes = require('./routes/redemptions.routes');
const reportsRoutes = require('./routes/reports.routes');
const eventsRoutes = require('./routes/events.routes');
const savedSessionsRoutes = require('./routes/savedSessions.routes');
const referralsRoutes = require('./routes/referrals.routes');
const meRoutes = require('./routes/me.routes');
const discountsRoutes = require('./routes/discounts.routes');
const authController = require('./controllers/auth.controller');
const emailService = require('./services/email.service');
const { auditContextMiddleware } = require('./services/audit.service');
const { initSocket } = require('./services/socket.service');
const { startCronJobs } = require('./services/cron.service');
const http = require('http');

const app = express();
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 5000;

// Start background cron jobs
startCronJobs();

const { isOriginAllowed } = require('./lib/corsOrigins');
const { APP_NAME, APP_SCHEME, LEGACY_APP_SCHEME } = require('./constants/brand');

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// We must mount Stripe webhook route BEFORE express.json() because it needs the raw body
app.use('/api/stripe', stripeRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(auditContextMiddleware);

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/exercises-media', express.static(path.join(__dirname, '../public/exercises')));

app.get('/health', (req, res) => {
  const email = emailService.getEmailStatus();
  res.json({
    status: 'ok',
    message: `${APP_NAME} Analytics API`,
    services: {
      email: {
        configured: email.configured,
        provider: email.provider,
        fromEmail: email.fromEmail,
        keyPresentInEnv: email.keyPresentInEnv,
        keyLength: email.keyLength,
        keyPrefix: email.keyPrefix,
      },
    },
  });
});

app.get('/invite/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const target = `invite/${encodeURIComponent(code)}`;
  const deepLink = `${APP_SCHEME}://${target}`;
  // Los builds anteriores al rebranding solo registran `jnsix://`, así que si el
  // esquema nuevo no abre nada, reintentamos con el legado.
  const legacyDeepLink =
    APP_SCHEME === LEGACY_APP_SCHEME ? null : `${LEGACY_APP_SCHEME}://${target}`;
  const acceptJson = req.accepts(['html', 'json']) === 'json';
  if (acceptJson) return res.json({ referralCode: code, deepLink, legacyDeepLink });
  return res.type('html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${APP_NAME}</title></head>
<body><p>Abriendo invitación de ${APP_NAME}…</p><p><a href="${deepLink}">Abrir la app</a></p>
<script>
window.location.href=${JSON.stringify(deepLink)};
${legacyDeepLink ? `setTimeout(function(){window.location.href=${JSON.stringify(legacyDeepLink)};},1200);` : ''}
</script></body></html>`);
});

app.use('/api/auth', authRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/comparisons', comparisonsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/competitions', competitionsRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/communities', communitiesRoutes);
app.use('/api/rankings', rankingsRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/achievements', achievementsRoutes);
app.use('/api/challenges', challengesRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/exercises', exercisesRoutes);
app.use('/api/workouts', workoutsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/plans', plansRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/duels', duelsRoutes);
app.use('/api/stories', storiesRoutes);
app.use('/api/training-plans', trainingPlansRoutes);
app.use('/api/segments', segmentsRoutes);
app.use('/api/live-challenges', liveChallengesRoutes);
app.use('/api/live-runs', liveRunsRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/scoring', scoringRoutes);
app.use('/api/businesses', businessesRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/redemptions', redemptionsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/saved-sessions', savedSessionsRoutes);
app.use('/api/referrals', referralsRoutes);
app.use('/api/me', meRoutes);
app.use('/api/discounts', discountsRoutes);


// Ruta especial para callback de Strava (sin /api para compatibilidad con Strava)
app.get('/strava/callback', authController.stravaCallback);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

initSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`${APP_NAME} Analytics API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  const emailStatus = emailService.getEmailStatus();
  if (!emailStatus.configured) {
    console.error(
      `[Email Service] NOT CONFIGURED: BREVO_API_KEY missing or placeholder. ` +
        `keyPresentInEnv=${emailStatus.keyPresentInEnv} cwd=${process.cwd()} envFile=../.env`
    );
  } else {
    console.log(
      `[Email Service] Brevo OK (sender: ${emailStatus.fromEmail}, key: ${emailStatus.keyPrefix}, len=${emailStatus.keyLength})`
    );
  }

  // Reanudar cola durable de sync (PENDING/RUNNING) tras reinicio
  const syncQueueService = require('./services/syncQueue.service');
  syncQueueService.resumePendingJobs().catch((err) => {
    console.error('[SyncQueue] Error al reanudar jobs pendientes:', err.message);
  });
});
