// src/controllers/healthController.js
//
// Is the service actually working?
//
// There was no health endpoint at all, and the closest thing — `GET /` — just
// returns a string without touching the database, so it answered 200 with a
// dead MySQL behind it. An uptime monitor watching that would have reported
// green through an outage.
//
// This one runs a real query. It is unauthenticated on purpose — a monitor
// cannot hold a credential — so it reports only what is safe for anyone to
// know: whether the pieces are up, never a hostname, a version of anything, or
// a configuration value.
//
import getPool from "../utils/db.js";
import { getWhatsAppConfig } from "../utils/appSettings.js";
import { getPaymentConfig } from "../utils/payments/config.js";

const STARTED_AT = Date.now();

async function checkDatabase() {
  const started = Date.now();
  try {
    // A query, not a connection check: a pool can hold a connection to a server
    // that has stopped answering.
    await getPool().query("SELECT 1");
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err.code || "query_failed" };
  }
}

/**
 * GET /api/health
 *
 * 200 when the service can serve, 503 when it cannot. The distinction is the
 * whole point: a monitor needs a status code it can alert on, not prose.
 */
export const health = async (_req, res) => {
  const db = await checkDatabase();

  // Module readiness is reported but does NOT affect the status code. WhatsApp
  // being unconfigured is a setup state, not an outage, and a monitor paging
  // someone at 3am because a feature is switched off trains people to ignore it.
  let whatsapp = { ready: false };
  let payments = { ready: false, providers: 0 };
  try {
    const wa = await getWhatsAppConfig();
    whatsapp = { enabled: wa.enabled, ready: wa.ready };
    const pay = await getPaymentConfig();
    payments = {
      enabled: pay.enabled,
      ready: pay.ready,
      providers: pay.providers.filter((p) => p.ready).length,
    };
  } catch {
    // Settings unreadable is itself a database problem; `db` above already says so.
  }

  const body = {
    status: db.ok ? "ok" : "degraded",
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    checks: { database: db, whatsapp, payments },
    time: new Date().toISOString(),
  };

  return res.status(db.ok ? 200 : 503).json(body);
};

/**
 * GET /api/health/live
 *
 * Liveness only: is the process up. Deliberately touches nothing, so a
 * supervisor restarting on a failed liveness probe cannot be triggered by a
 * slow database.
 */
export const live = (_req, res) =>
  res.status(200).json({ status: "ok", uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000) });
