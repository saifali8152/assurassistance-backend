#!/usr/bin/env node
/**
 * Claim document retention (Milestone 4, D9).
 *
 * Removes the stored FILES of documents whose claim was closed or abandoned
 * longer ago than Admin → Settings → Claims → "document retention days".
 * With that setting empty (the default), it does nothing at all.
 *
 * Rows are never deleted: each purged document keeps its row, marked
 * `purged` with the date. Claims themselves are never touched.
 *
 * USAGE
 *   node scripts/purgeClaimDocuments.js --dry-run   list what would go (run this first)
 *   node scripts/purgeClaimDocuments.js
 *
 * CRON (weekly)
 *   40 3 * * 0  cd /path/to/backend && /usr/bin/node scripts/purgeClaimDocuments.js >> /var/log/aas-claim-retention.log 2>&1
 */
import dotenv from "dotenv";
import { initializePool, getPool } from "../utils/db.js";
import { getClaimsConfig } from "../utils/appSettings.js";
import { purgeExpiredDocuments } from "../models/claimDocumentModel.js";

dotenv.config();
const DRY_RUN = process.argv.includes("--dry-run");
const stamp = () => new Date().toISOString();

async function main() {
  const missing = ["DB_HOST", "DB_USER", "DB_NAME"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`${stamp()} claim-retention: missing env ${missing.join(", ")}`);
    process.exit(1);
  }
  initializePool({
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT || 3306),
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME,
  });
  const config = await getClaimsConfig();
  const r = await purgeExpiredDocuments({ retentionDays: config.retentionDays, dryRun: DRY_RUN });
  if (!r.enabled) console.log(`${stamp()} claim-retention: no retention period set — nothing removed`);
  else if (DRY_RUN) console.log(`${stamp()} claim-retention: DRY RUN — ${r.due} document file(s) older than ${config.retentionDays} days would be removed`);
  else console.log(`${stamp()} claim-retention: removed ${r.purged} document file(s) (retention ${config.retentionDays} days); rows kept`);
  await getPool().end();
}

main().catch((err) => {
  console.error(`${stamp()} claim-retention: failed —`, err.message);
  process.exit(1);
});
