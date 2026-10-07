#!/usr/bin/env node
// scripts/sweepPayments.js
//
// Expire payments nobody ever confirmed, and tell the customer.
//
// WHY A SCRIPT AND NOT A TIMER: the app runs under PM2, and an in-process
// interval would fire once per worker — so a cluster-mode switch would expire
// the same transaction several times and message the customer once per worker.
// Same reasoning as scripts/pruneMessages.js, which this follows deliberately.
//
// Install it with cron, every minute — a payment window is measured in minutes,
// so an hourly sweep would leave a customer staring at a dead prompt:
//
//   * * * * * cd /path/to/backend && /usr/bin/node scripts/sweepPayments.js >> /var/log/aas-sweep.log 2>&1
//
// Flags:
//   --dry-run   report what would expire, change nothing
//   --limit=N   cap one pass (default 100), so a backlog drains steadily
//
import dotenv from "dotenv";
import { initializePool, getPool } from "../utils/db.js";
import { findExpirable, transition } from "../models/paymentModel.js";
import { settlePayment } from "../utils/payments/service.js";

dotenv.config();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) || 100 : 100;

async function main() {
  initializePool(process.env);

  const due = await findExpirable(limit);
  if (due.length === 0) {
    console.log(`[sweep] nothing to expire`);
    return 0;
  }

  console.log(`[sweep] ${due.length} transaction(s) past their window${dryRun ? " (dry run)" : ""}`);

  let expired = 0;
  let notified = 0;

  for (const tx of due) {
    if (dryRun) {
      console.log(`[sweep] would expire ${tx.reference} (${tx.provider}, ${tx.status}, due ${tx.expires_at})`);
      continue;
    }

    const result = await transition(tx.id, "expired", {
      by: "sweeper",
      note: "no confirmation within the payment window",
    });

    // A transaction that completed between the query and now is not an error —
    // it is the race the state machine exists to settle. Leave it alone.
    if (!result.ok || result.noop) {
      console.log(`[sweep] ${tx.reference} not expired: ${result.reason || "already settled"}`);
      continue;
    }
    expired += 1;

    // Telling the customer is the point. A silent expiry leaves someone
    // watching a prompt that will never arrive.
    const { notice } = await settlePayment({ transactionId: tx.id, status: "expired" });
    if (notice.notified) notified += 1;
    else console.log(`[sweep] ${tx.reference} expired but not announced: ${notice.reason || "unknown"}`);
  }

  console.log(`[sweep] expired ${expired}, customers told ${notified}`);
  return 0;
}

main()
  .then(async (code) => {
    await getPool().end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("[sweep] failed:", err.message);
    await getPool().end().catch(() => {});
    process.exit(1);
  });
