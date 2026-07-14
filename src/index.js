require('dotenv').config();
const express = require('express');
const cors = require('cors');

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
const usersRoutes = require('./routes/users.routes');
const authController = require('./controllers/auth.controller');
const { auditContextMiddleware } = require('./services/audit.service');
const { initSocket } = require('./services/socket.service');
const http = require('http');

const app = express();
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:3000',
      'https://jnsix-endurance.onrender.com'
    ];
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(auditContextMiddleware);

const path = require('path');
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/exercises-media', express.static(path.join(__dirname, '../public/exercises')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'JNSIX Endurance Analytics API' });
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
app.use('/api/challenges', challengesRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/exercises', exercisesRoutes);
app.use('/api/workouts', workoutsRoutes);
app.use('/api/users', usersRoutes);


// Ruta especial para callback de Strava (sin /api para compatibilidad con Strava)
app.get('/strava/callback', authController.stravaCallback);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

initSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`JNSIX Endurance Analytics API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
