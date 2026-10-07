// src/utils/alerts.js
//
// Telling a human when something breaks.
//
// WHAT WAS MISSING: Sentry was wired but double-gated shut — no DSN, and the
// package was not installed — and the webhook answers Meta 200 even when
// processing fails. So a broken payment integration was invisible until a
// customer complained. An alert that nobody reads is the same as no alert, so
// this sends email, to an address the operator actually opens.
//
// THROTTLED ON PURPOSE. The failure mode of alerting is a storm: one provider
// outage produces a callback error per customer per retry, and a thousand
// identical emails get a rule written to delete them. Each distinct problem is
// reported at most once per window, with a count of how many times it happened.
//
import sendEmail from "./emailService.js";
import { logger, scrubText } from "./logger.js";

const WINDOW_MS = Number(process.env.ALERT_WINDOW_MINUTES || 15) * 60_000;
const MAX_PER_HOUR = Number(process.env.ALERT_MAX_PER_HOUR || 20);

/** key -> { firstAt, lastAt, count, notifiedAt } */
const seen = new Map();
let hourStart = Date.now();
let sentThisHour = 0;

function withinHourlyCap() {
  const now = Date.now();
  if (now - hourStart > 3_600_000) {
    hourStart = now;
    sentThisHour = 0;
  }
  if (sentThisHour >= MAX_PER_HOUR) return false;
  sentThisHour += 1;
  return true;
}

/** Where alerts go. No address configured means alerting is simply off. */
export function alertRecipients() {
  const raw = process.env.ALERT_EMAIL || process.env.OPS_EMAIL || "";
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function alertingEnabled() {
  return alertRecipients().length > 0;
}

/**
 * Report a problem to a human.
 *
 * Never throws and never awaits anything the caller depends on: this runs on
 * the failure path, and an alert that breaks the request it is reporting on is
 * worse than no alert at all.
 *
 * @param {string} key     what kind of problem — the throttling unit
 * @param {string} subject one line, as it will appear in the inbox
 * @param {object} detail  context; scrubbed before it is sent
 */
export async function notifyOps(key, subject, detail = {}) {
  try {
    const now = Date.now();
    const entry = seen.get(key) || { firstAt: now, count: 0, notifiedAt: 0 };
    entry.count += 1;
    entry.lastAt = now;
    seen.set(key, entry);

    // Bounded: a long-running process must not accumulate a map entry per
    // distinct error string.
    if (seen.size > 500) {
      for (const [k, v] of seen) if (now - v.lastAt > WINDOW_MS * 4) seen.delete(k);
    }

    if (!alertingEnabled()) return { sent: false, reason: "no_recipient" };
    if (now - entry.notifiedAt < WINDOW_MS) return { sent: false, reason: "throttled", count: entry.count };
    if (!withinHourlyCap()) return { sent: false, reason: "hourly_cap" };

    entry.notifiedAt = now;
    const repeats = entry.count > 1 ? ` (${entry.count}× since ${new Date(entry.firstAt).toISOString()})` : "";
    const safeDetail = scrubDetail(detail);

    const text = [
      `${subject}${repeats}`,
      "",
      `Environment: ${process.env.NODE_ENV || "development"}`,
      `Host: ${process.env.PUBLIC_API_URL || "unknown"}`,
      `Time: ${new Date().toISOString()}`,
      "",
      JSON.stringify(safeDetail, null, 2),
    ].join("\n");

    await sendEmail(alertRecipients().join(","), `[Assur'Assistance] ${subject}`, text, null);
    return { sent: true, count: entry.count };
  } catch (err) {
    // Deliberately swallowed. The caller is already handling a failure.
    logger.error({ err: err?.message, key }, "could not send an alert");
    return { sent: false, reason: "send_failed" };
  }
}

/** Alerts travel by email, so they must not carry what logs must not carry. */
function scrubDetail(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail || {})) {
    if (/passport|msisdn|phone|email|token|secret|password/i.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string") {
      out[k] = scrubText(v).slice(0, 500);
    } else if (v && typeof v === "object") {
      out[k] = "[object]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Tests need a clean slate; nothing else should call this. */
export function __resetAlerts() {
  seen.clear();
  hourStart = Date.now();
  sentThisHour = 0;
}
