#!/usr/bin/env node
/**
 * Email the claims team about newly submitted claims (Milestone 4, Day 6).
 *
 * Reads the claim_notifications outbox: urgent claims first, then high, then
 * normal. Recipients come from Admin → Settings → Claims → notification emails,
 * read at send time. With no address configured, a row is marked "skipped" —
 * the claim is on the dashboard regardless.
 *
 * A failed send is retried with backoff (2, 5, 15, 30, 60… minutes), up to 8
 * times. A failure never affects the claim itself.
 *
 * The email carries no passport number and no document — only the reference,
 * type, priority, dates, place and the customer's description.
 *
 * USAGE
 *   node scripts/sendClaimNotifications.js            send what is due
 *   node scripts/sendClaimNotifications.js --dry-run  print what would be sent
 *
 * CRON (every 2 minutes)
 *   *\/2 * * * *  cd /path/to/backend && /usr/bin/node scripts/sendClaimNotifications.js >> /var/log/aas-claim-mail.log 2>&1
 */
import dotenv from "dotenv";
import { initializePool, getPool } from "../utils/db.js";
import { getClaimsConfig } from "../utils/appSettings.js";
import sendEmail from "../utils/emailService.js";
import { dueNotifications, markSent, markSkipped, markFailed, renderClaimEmail } from "../models/claimNotificationModel.js";

dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");
const stamp = () => new Date().toISOString();

export async function runOnce({ dryRun = false, send = sendEmail, log = console } = {}) {
  const config = await getClaimsConfig();
  const to = (config.notificationEmails || []).join(",");
  const due = await dueNotifications({ limit: 25 });
  const summary = { due: due.length, sent: 0, skipped: 0, failed: 0 };
  for (const n of due) {
    const mail = renderClaimEmail(n, { adminUrl: process.env.ADMIN_URL || process.env.FRONTEND_URL || "" });
    if (dryRun) {
      log.log(`${stamp()} claim-mail: DRY RUN — would send "${mail.subject}" to ${to || "(nobody configured)"}`);
      continue;
    }
    if (!to) {
      await markSkipped(n.id, "no notification email configured");
      summary.skipped += 1;
      continue;
    }
    try {
      await send(to, mail.subject, mail.text, null);
      await markSent(n.id, to);
      summary.sent += 1;
    } catch (err) {
      const r = await markFailed(n.id, n.attempts, err?.message || "send failed");
      summary.failed += 1;
      log.error(`${stamp()} claim-mail: ${n.reference} failed (attempt ${r.attempts})${r.giveUp ? " — giving up" : `, retry in ${r.retryInMinutes} min`}: ${err?.message}`);
    }
  }
  return summary;
}

async function main() {
  const missing = ["DB_HOST", "DB_USER", "DB_NAME"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`${stamp()} claim-mail: missing env ${missing.join(", ")}`);
    process.exit(1);
  }
  initializePool({
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT || 3306),
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME,
  });
  const s = await runOnce({ dryRun: DRY_RUN });
  if (s.due || !DRY_RUN) console.log(`${stamp()} claim-mail: due ${s.due}, sent ${s.sent}, skipped ${s.skipped}, failed ${s.failed}`);
  await getPool().end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`${stamp()} claim-mail: failed —`, err.message);
    process.exit(1);
  });
}
