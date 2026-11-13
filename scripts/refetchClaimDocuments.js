#!/usr/bin/env node
/**
 * Re-fetch claim documents whose download failed for a temporary reason
 * (Milestone 4, Day 5).
 *
 * When a customer sends a file and Meta or the network fails at that moment,
 * the document row is kept as `pending` with Meta's media id. This job tries
 * again with backoff (5, 15, 30, 60, 180, 360 minutes) and marks it `failed`
 * after 6 attempts. Meta keeps media for a limited time, so it runs often.
 *
 * Nothing is deleted. The claim itself is never affected.
 *
 * USAGE
 *   node scripts/refetchClaimDocuments.js
 *
 * CRON (every 5 minutes)
 *   *\/5 * * * *  cd /path/to/backend && /usr/bin/node scripts/refetchClaimDocuments.js >> /var/log/aas-claim-docs.log 2>&1
 */
import dotenv from "dotenv";
import { initializePool, getPool } from "../utils/db.js";
import { getWhatsAppConfig, getClaimsConfig } from "../utils/appSettings.js";
import { refetchPendingDocuments } from "../models/claimDocumentModel.js";

dotenv.config();
const stamp = () => new Date().toISOString();

async function main() {
  const missing = ["DB_HOST", "DB_USER", "DB_NAME"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`${stamp()} claim-docs: missing env ${missing.join(", ")}`);
    process.exit(1);
  }
  initializePool({
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT || 3306),
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME,
  });
  const [waConfig, claimsConfig] = await Promise.all([getWhatsAppConfig(), getClaimsConfig()]);
  const r = await refetchPendingDocuments({ waConfig, claimsConfig });
  if (r.due) console.log(`${stamp()} claim-docs: due ${r.due}, stored ${r.stored}, still pending ${r.pending}, rejected ${r.rejected}, gave up ${r.failed}`);
  await getPool().end();
}

main().catch((err) => {
  console.error(`${stamp()} claim-docs: failed —`, err.message);
  process.exit(1);
});
