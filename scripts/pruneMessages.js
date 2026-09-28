#!/usr/bin/env node
/**
 * Apply the WhatsApp transcript retention policy.
 *
 * WHY A STANDALONE SCRIPT AND NOT AN IN-PROCESS TIMER:
 * the app runs under PM2. An in-process scheduler fires once per worker, so the
 * moment anyone switches PM2 to cluster mode the job runs N times concurrently.
 * A script invoked by system cron runs exactly once, is independently testable,
 * and leaves a log line someone can actually find.
 *
 * WHAT IT DELETES: rows in `whatsapp_messages` older than the retention window
 * configured by the superadmin (default 180 days). Nothing else — never a
 * session, a case, a traveller or a sale. Sessions are kept because an expired
 * conversation is still evidence of what a customer was told.
 *
 * USAGE
 *   node scripts/pruneMessages.js            apply the policy
 *   node scripts/pruneMessages.js --dry-run  report what would go, change nothing
 *
 * CRON (see docs/DEPLOY_HOSTINGER_VPS.md)
 *   15 3 * * 0  cd /path/to/backend && /usr/bin/node scripts/pruneMessages.js >> /var/log/aas-prune.log 2>&1
 */
import dotenv from "dotenv";
import { initializePool, getPool } from "../utils/db.js";
import { pruneOldMessages } from "../models/whatsappModel.js";
import { getWhatsAppConfig } from "../utils/appSettings.js";

dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");
const stamp = () => new Date().toISOString();

async function main() {
  const missing = ["DB_HOST", "DB_USER", "DB_NAME"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`${stamp()} prune: missing env ${missing.join(", ")}`);
    process.exit(1);
  }

  initializePool({
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT || 3306),
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME,
  });

  const config = await getWhatsAppConfig();
  const days = Math.max(7, Number(config.messageRetentionDays) || 180);

  const pool = getPool();
  const [[{ candidates }]] = await pool.query(
    `SELECT COUNT(*) AS candidates FROM whatsapp_messages
     WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [days]
  );

  if (DRY_RUN) {
    console.log(`${stamp()} prune: DRY RUN — ${candidates} message(s) older than ${days}d would be deleted`);
    await pool.end();
    return;
  }

  const deleted = await pruneOldMessages(days);
  console.log(`${stamp()} prune: deleted ${deleted} message(s), retention ${days}d`);
  await pool.end();
}

main().catch((err) => {
  console.error(`${stamp()} prune: failed —`, err.message);
  process.exit(1);
});
