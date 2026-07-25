/**
 * Shared CORS allow-list for Express and Socket.io.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://jnsix-endurance.onrender.com',
  'https://jnsix-endurance.duckdns.org',
];

const envOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...envOrigins])];

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (
    /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin) ||
    origin.startsWith('exp://')
  ) {
    return true;
  }
  return false;
}

module.exports = {
  allowedOrigins,
  isOriginAllowed,
};
