/**
 * Optional Sentry wrapper for the API.
 * No-ops unless SENTRY_DSN is set. Requires @sentry/node (listed in package.json).
 *
 * Set SENTRY_DSN in the environment to enable.
 */

let Sentry = null;
let enabled = false;

function init() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return { enabled: false };
  }

  try {
    // Optional dependency — do not hard-fail boot if missing
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
    });
    enabled = true;
    console.log('[Sentry] Initialized');
  } catch (err) {
    console.warn(
      '[Sentry] SENTRY_DSN set but @sentry/node is not installed. Run: npm install @sentry/node'
    );
    enabled = false;
  }

  return { enabled };
}

function captureException(error, context) {
  if (!enabled || !Sentry) return;
  if (context) {
    Sentry.withScope((scope) => {
      Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
      Sentry.captureException(error);
    });
  } else {
    Sentry.captureException(error);
  }
}

function captureMessage(message, level = 'info') {
  if (!enabled || !Sentry) return;
  Sentry.captureMessage(message, level);
}

module.exports = {
  init,
  captureException,
  captureMessage,
  get enabled() {
    return enabled;
  },
};
