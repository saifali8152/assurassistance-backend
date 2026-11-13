#!/usr/bin/env node
/**
 * Mark unfinished claims as abandoned (Milestone 4, D9).
 *
 * A claim draft is created when a customer confirms their policy in the
 * conversation, and filled in as they answer. One left untouched for longer
 * than Admin → Settings → Claims → "draft abandon hours" (default 48) is moved
 * to `abandoned`, with a history row saying why.
 *
 * WHAT IT CHANGES: the status of claims that are still `draft`. Nothing is
 * deleted — not the claim, not its answers, not its documents. Documents of
 * abandoned claims are only ever removed by the separate retention setting.
 *
 * USAGE
 *   node scripts/abandonClaimDrafts.js            apply
 *   node scripts/abandonClaimDrafts.js --dry-run  report what would be marked
 *
 * CRON (hourly is plenty)
 *   20 * * * *  cd /path/to/backend && /usr/bin/node scripts/abandonClaimDrafts.js >> /var/log/aas-claim-drafts.log 2>&1
 */
import dotenv from "dotenv";
import { initializePool, getPool } from "../utils/db.js";
import { abandonStaleDrafts } from "../models/claimModel.js";
import { getClaimsConfig } from "../utils/appSettings.js";

dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");
const stamp = () => new Date().toISOString();

async function main() {
  const missing = ["DB_HOST", "DB_USER", "DB_NAME"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`${stamp()} claim-drafts: missing env ${missing.join(", ")}`);
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
  const hours = Math.max(1, Number(config.draftAbandonHours) || 48);
  const result = await abandonStaleDrafts({ hours, dryRun: DRY_RUN });
  console.log(
    DRY_RUN
      ? `${stamp()} claim-drafts: DRY RUN — ${result.found} draft(s) idle for more than ${hours}h would be marked abandoned`
      : `${stamp()} claim-drafts: marked ${result.abandoned} of ${result.found} idle draft(s) abandoned (threshold ${hours}h)`
  );
  await getPool().end();
}

main().catch((err) => {
  console.error(`${stamp()} claim-drafts: failed —`, err.message);
  process.exit(1);
});
