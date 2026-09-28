// src/utils/monitoring.js
//
// Error monitoring. Optional by design: with no SENTRY_DSN set, every function
// here is a no-op, so development and any environment that has not installed the
// package behave exactly as before.
//
// The webhook is the reason this exists. It answers Meta with 200 even when our
// own processing fails — that is deliberate, because a non-2xx makes Meta retry
// and eventually disable the integration. The cost of that choice is that a
// broken conversation is invisible unless the failure is reported somewhere.
//
import { logger } from "./logger.js";

let Sentry = null;
let enabled = false;

export async function initMonitoring() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info({ monitoring: "disabled" }, "SENTRY_DSN not set — error monitoring is off");
    return false;
  }
  try {
    Sentry = await import("@sentry/node");
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || "development",
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      // Credentials must never reach a third-party service.
      beforeSend(event) {
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
          delete event.request.headers["x-hub-signature-256"];
        }
        return event;
      },
    });
    enabled = true;
    logger.info({ monitoring: "sentry" }, "Error monitoring initialised");
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, "Sentry could not be initialised — continuing without it");
    return false;
  }
}

/** Report an exception. Always safe to call. */
export function captureException(err, context = {}) {
  if (enabled && Sentry) {
    try {
      Sentry.captureException(err, { extra: context });
    } catch {
      /* monitoring must never break the request it is reporting on */
    }
  }
  logger.error({ err: err?.message, stack: err?.stack, ...context }, "exception");
}

export function captureMessage(message, context = {}) {
  if (enabled && Sentry) {
    try {
      Sentry.captureMessage(message, { extra: context });
    } catch { /* ignore */ }
  }
  logger.warn({ ...context }, message);
}

export function monitoringEnabled() {
  return enabled;
}
